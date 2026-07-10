// stage_order：暫存訂單工具（action tier）
// 不直接下單——把訂單快照存進 line_pending_orders，由 index.ts 送出
// LINE 確認按鈕，顧客點「確認下單」的 postback 才真正呼叫 place_order。
// 訂單成立與否完全由確定性程式路徑決定，杜絕 LLM 幻覺「訂單已成立」。
// handler 內重新從 DB 取價（防偽造）。
import type { Tool } from "../core/types.ts";

const BIND_URL = Deno.env.get("LINE_BIND_URL") ?? "https://liff.line.me/2010616155-bJSaanw4";

interface OrderItem {
  product_id: number;
  variant_id?: number;
  variant_label?: string;
  qty: number;
}

type ItemWithPrice = OrderItem & { price: number; name: string };

// 組確認卡片上方的訂單摘要（純文字，index.ts 直接送出、不經 Claude）
function buildSummaryText(
  items: ItemWithPrice[],
  subtotal: number,
  shippingFee: number,
  totalAmount: number,
  address: string,
  paymentMethod: string,
  customerName: string,
): string {
  const lines = items.map(
    (i) => `・${i.name}${i.variant_label ? `（${i.variant_label}）` : ""} × ${i.qty}　$${(i.price * i.qty).toLocaleString()}`,
  );
  return [
    "📋 訂單確認",
    ...lines,
    `小計 $${subtotal.toLocaleString()}`,
    `運費 $${shippingFee.toLocaleString()}`,
    `合計 $${totalAmount.toLocaleString()}`,
    `收件人：${customerName || "（未填）"}`,
    `地址：${address}`,
    `付款：${paymentMethod === "remittance" ? "匯款" : paymentMethod}`,
    "",
    "⏰ 此確認 3 小時內有效，逾時請重新下單",
  ].join("\n");
}

export const stageOrder: Tool = {
  name: "stage_order",
  tier: "action",
  description:
    "暫存訂單並觸發確認按鈕。當商品/規格/數量/地址/付款方式都齊全時「立即」呼叫，"
    + "「不需要」先請顧客回覆確認文字——系統會自動送出訂單摘要與確認按鈕，由顧客點選完成下單。"
    + "只有已綁定 LINE 會員才能使用此工具。",
  inputSchema: {
    type: "object",
    required: ["items", "address", "payment_method"],
    properties: {
      items: {
        type: "array",
        description: "訂單品項，從 search_products / get_stock 結果填入",
        items: {
          type: "object",
          required: ["product_id", "qty"],
          properties: {
            product_id: { type: "integer", description: "商品 ID（來自 search_products）" },
            variant_id: { type: "integer", description: "規格 ID（來自 get_stock variants[].id；無規格商品不填）" },
            variant_label: { type: "string", description: "規格描述，例：黑色/M（供訂單紀錄，可讀取自 get_stock variants[].label）" },
            qty: { type: "integer", minimum: 1, description: "數量（預設 1）" },
          },
        },
      },
      address: {
        type: "string",
        description: "收件地址（若顧客有預設地址請直接帶入；需更改時由顧客告知）",
      },
      payment_method: {
        type: "string",
        enum: ["remittance"],
        description: "付款方式：remittance=匯款",
      },
      note: { type: "string", description: "備註（選填）" },
    },
  },

  async handler(input, ctx) {
    // ── 1. 未綁定拒絕 ──────────────────────────────────────────
    if (!ctx.consumer) {
      return { ok: false, error: `請先綁定 LINE 會員才能下單 👉 ${BIND_URL}` };
    }

    const items = (input.items as OrderItem[]) ?? [];
    const address = String(input.address ?? "").trim();
    const paymentMethod = String(input.payment_method ?? "remittance");
    const note = String(input.note ?? "");

    if (!items.length) return { ok: false, error: "請指定要購買的商品" };
    if (!address) return { ok: false, error: "需要收件地址才能下單" };

    // ── 2. 防重複：5 分鐘內同消費者已有訂單 → 警告 ─────────────
    const fiveMinsAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const { count: recentCount } = await ctx.admin
      .from("consumer_orders")
      .select("id", { count: "exact", head: true })
      .eq("consumer_id", ctx.consumer.id)
      .eq("store_id", ctx.storeId)
      .gte("created_at", fiveMinsAgo);
    if ((recentCount ?? 0) > 0) {
      return {
        ok: false,
        error: "你 5 分鐘內剛建立過一筆訂單，請稍等再試，或確認要再建一筆新訂單",
      };
    }

    // ── 3. 從 DB 重新取得正確售價（不信任對話中的數字） ──────────
    const itemsWithPrice: ItemWithPrice[] = [];

    for (const item of items) {
      const { data: stock, error: stockErr } = await ctx.admin.rpc("line_get_stock", {
        p_product_id: item.product_id,
      });
      if (stockErr || !stock) {
        return { ok: false, error: `查不到商品 ID ${item.product_id}，請確認商品是否存在` };
      }

      // 依規格取售價
      let price: number = Number(stock.shop_price ?? 0);
      if (item.variant_id && Array.isArray(stock.variants)) {
        const v = stock.variants.find((vr: Record<string, unknown>) => Number(vr.id) === item.variant_id);
        if (v) {
          const vPrice = Number(v.price ?? stock.shop_price);
          const vSale = v.sale_price ? Number(v.sale_price) : null;
          price = (stock.on_sale && vSale) ? vSale : vPrice;
        }
      } else if (stock.on_sale && stock.sale_price) {
        price = Number(stock.sale_price);
      }

      itemsWithPrice.push({ ...item, price, name: String(stock.name ?? "") });
    }

    // ── 4. 計算小計 + 運費 ─────────────────────────────────────
    const subtotal = itemsWithPrice.reduce((s, i) => s + i.price * i.qty, 0);
    const { data: storeData } = await ctx.admin
      .from("stores")
      .select("settings")
      .eq("id", ctx.storeId)
      .maybeSingle();
    const settings = (storeData?.settings ?? {}) as Record<string, number>;
    const freeThreshold = settings.free_shipping_threshold ?? 3800;
    const shippingFeeAmt = settings.shipping_fee ?? 60;
    const shippingFee = subtotal >= freeThreshold ? 0 : shippingFeeAmt;
    const totalAmount = subtotal + shippingFee;

    // ── 5. 組 place_order 用的品項快照 ─────────────────────────
    const pItemsJson = itemsWithPrice.map((i) => ({
      id: i.product_id,
      variantId: i.variant_id ? String(i.variant_id) : null,
      variantLabel: i.variant_label ?? "",
      qty: i.qty,
      price: i.price,
      name: i.name,
      sku: null,
      customNote: "",
      isCollection: false,
    }));
    const pItemsText = itemsWithPrice
      .map((i) => `${i.name}${i.variant_label ? ` (${i.variant_label})` : ""} × ${i.qty}`)
      .join("、");

    // ── 6. 暫存到 line_pending_orders（一人一張：先清舊 pending） ──
    await ctx.admin
      .from("line_pending_orders")
      .delete()
      .eq("line_user_id", ctx.lineUserId)
      .eq("store_id", ctx.storeId)
      .eq("status", "pending");

    const { data: pending, error: pendingErr } = await ctx.admin
      .from("line_pending_orders")
      .insert({
        line_user_id: ctx.lineUserId,
        consumer_id: ctx.consumer.id,
        store_id: ctx.storeId,
        items_json: pItemsJson,
        items_text: pItemsText,
        subtotal,
        shipping_fee: Math.round(shippingFee),
        total_amount: totalAmount,
        address,
        note,
        payment_method: paymentMethod,
      })
      .select("id")
      .single();

    if (pendingErr || !pending) {
      console.error("[stage_order] insert pending error", pendingErr);
      return { ok: false, error: "暫存訂單失敗，請稍後再試" };
    }

    // __staged 是給 index.ts 的短路訊號：askClaude 看到就直接送確認按鈕，不再回 Claude
    return {
      ok: true,
      __staged: {
        pendingId: pending.id as string,
        summary: buildSummaryText(
          itemsWithPrice,
          subtotal,
          shippingFee,
          totalAmount,
          address,
          paymentMethod,
          ctx.consumer.name ?? "",
        ),
      },
    };
  },
};
