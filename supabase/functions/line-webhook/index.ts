// ============================================================
// LINE 智慧客服 webhook
//   LINE → 驗簽 → 限流 → 載入對話記憶 → Claude(tool use) → 查 Supabase → 回覆 → 寫回記憶
//
// 工具箱式架構：本檔只負責「傳輸層＋對話迴圈」，
// 各工具的宣告與實作在 tools/，統一由 core/dispatch 執行。
// 新增能力＝在 tools/ 建一支檔、加進 tools/registry.ts，主流程不動。
//
// 需要的環境變數（Supabase Function Secrets）：
//   LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN / ANTHROPIC_API_KEY
//   （選填）ANTHROPIC_MODEL、LINE_STORE_ID(預設 1)、LINE_RATE_PER_MIN、LINE_RATE_PER_DAY
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 由平台自動注入
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { AskResult, BoundConsumer, ConversationTurn, StagedOrder, ToolContext } from "./core/types.ts";
import { toolDefs } from "./tools/registry.ts";
import { dispatchTool } from "./core/dispatch.ts";

const LINE_SECRET = Deno.env.get("LINE_CHANNEL_SECRET")!;
const LINE_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-haiku-4-5-20251001";
// 圖片辨識可用不同 model（預設同 MODEL，想提升準確度可設為 claude-sonnet-4-6）
const VISION_MODEL = Deno.env.get("LINE_VISION_MODEL") ?? MODEL;
const STORE_ID = Number(Deno.env.get("LINE_STORE_ID") ?? "1");
// 限流：每 user 每分鐘上限、全站每日上限（保護 API 帳單），可用 env 調整
const RATE_PER_MIN = Number(Deno.env.get("LINE_RATE_PER_MIN") ?? "8");
const RATE_PER_DAY = Number(Deno.env.get("LINE_RATE_PER_DAY") ?? "500");
// 對話記憶：載入每人最近 N 則、且在 session 內（逾時視為新對話）。保留天數由 pg_cron 控制。
const MEMORY_LIMIT = Number(Deno.env.get("LINE_MEMORY_LIMIT") ?? "8");
const SESSION_GAP_MS = Number(Deno.env.get("LINE_SESSION_GAP_MIN") ?? "30") * 60_000;
// 會員綁定連結（LIFF）：未綁定顧客問個人資料時，bot 遞出這個讓他一點進來綁
const BIND_URL = Deno.env.get("LINE_BIND_URL") ?? "https://liff.line.me/2010616155-bJSaanw4";
// 商城網址：LINE 下單成功後呼叫商城的 /api/send-order-email 寄訂單確認信（與網站結帳同一條寄信路徑）
const SHOP_URL = Deno.env.get("LINE_SHOP_URL") ?? "https://daigogotw.com";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// ── 系統提示基底（不含消費者個人資料，動態由 buildSystemPrompt 組入）────
const SYSTEM_PROMPT_BASE = `你是 LikeDaigo 代購商城的 LINE 客服助理，個性親切、回答簡短口語（繁體中文）。

【基本規則】
・商品庫存、售價一律用工具即時查詢，「絕對不要」自己猜或編數字。
・使用者問某商品時，先用 search_products 找出對應商品；有多個相近結果就簡短反問是哪一個。
・查到庫存後：有規格的商品要說明各規格的剩餘數量；沒規格的看整體數量。有貨就明確說有、剩幾件；沒貨就說目前缺貨。
・只透露庫存與售價，「不可以」透露成本、進價、利潤等內部資訊。
・預購/可預訂商品：工具結果的 skip_stock_check 為 true 時，即使庫存為 0 也要回「可預訂」，「不要」說缺貨。
・不代表公司做退款、折扣或補償承諾；涉及金錢爭議一律請稍候由真人客服處理。
・查不到商品或超出範圍（退換貨/客訴），禮貌引導真人客服，不要硬掰。
・回覆盡量在 3 句內，適度用 emoji，但別浮誇。
・LINE 是純文字，不支援 Markdown。不要使用 **粗體**、# 標題、- 或 * 項目符號（會原樣顯示）；要條列就用「・」或直接分行。

【訂單查詢】
・用 get_my_orders 查本人訂單，「絕對不要」索取訂單編號或電話。
・若 get_my_orders 回傳 bound=false，說「需先綁定 LINE 會員才能查你的訂單」，附綁定連結：${BIND_URL}。
・任何情況「絕對不可」透露其他顧客的資料。

【以圖搜尋（Phase D）】
・收到圖片時，你的 messages 裡會有一張圖，請自行辨識品牌/商品關鍵字，立即呼叫 search_products 查庫存。
・搜尋後可附上「回覆『+1』即可下單」。
・圖片模糊辨識不出就誠實說，請顧客用文字描述。

【下單流程（Phase E，「+1」行為支援）】
・若顧客說「+1」/「我要這個」/「訂這個」等，代表他要下剛才討論的商品（看對話脈絡）。
・無規格商品：數量預設 1，跳過規格步驟。
・有規格且顧客已說規格（如「+1 黑L」）：直接用；只有一款有貨：自動選；多款都有貨但沒說：只問一次讓他選。
・地址：已知預設地址就直接帶入，顧客說要換再更改。付款方式預設匯款。
・商品/規格/數量/地址/付款方式都齊全後，「立刻」呼叫 stage_order 工具。
　「不要」自己用文字列訂單摘要請顧客確認、「不要」等顧客回覆「確認」——
　系統會自動送出訂單摘要與確認按鈕，由顧客點選完成下單。
・stage_order 回傳錯誤時（未綁定、查無商品等），依錯誤訊息用文字引導顧客。
・「絕對不可」自行宣稱訂單已成立或編出訂單編號；訂單成立與否只由系統按鈕流程決定。
　顧客問訂單是否成立時，用 get_my_orders 查證再回答。`;

// 動態注入已綁定會員資料（供下單預填，不需每次詢問）
function buildSystemPrompt(consumer: BoundConsumer | null, defaultAddress: string | null): string {
  if (!consumer) return SYSTEM_PROMPT_BASE;
  const addr = defaultAddress ? `預設地址：${defaultAddress}` : "預設地址：（尚無訂單記錄，請詢問顧客）";
  return `${SYSTEM_PROMPT_BASE}

【已綁定會員資料】
姓名：${consumer.name ?? "未填"}
電話：${consumer.phone ?? "未填"}
Email：${consumer.email ?? "未填"}
${addr}
→ 建立訂單時請以上述資料預填，地址如需更換由顧客告知即可。`;
}

// 合併連續同角色訊息（連發或先寫 user 造成的兩則 user），符合 Anthropic 交替要求
function mergeTurns(history: ConversationTurn[]): { role: string; content: string }[] {
  const out: { role: string; content: string }[] = [];
  for (const h of history) {
    const last = out[out.length - 1];
    if (last && last.role === h.role) last.content += "\n" + h.content;
    else out.push({ role: h.role, content: h.content });
  }
  return out;
}

// 大圖 base64 編碼（分塊避免 String.fromCharCode spread 超出 stack）
function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    for (let j = 0; j < slice.length; j++) binary += String.fromCharCode(slice[j]);
  }
  return btoa(binary);
}

// ── Claude tool-use 迴圈 ─────────────────────────────────────────────────────
// 回傳 AskResult：一般為純文字；stage_order 成功時短路回 confirm_order，
// 由主流程直接送 LINE 確認按鈕（不讓 Claude 生成下單結果文字 → 杜絕幻覺）。
async function askClaude(ctx: ToolContext, systemPrompt: string): Promise<AskResult> {
  // history 已含本次訊息（進入點先寫入 user）；合併連續同角色後即為對話序列
  let messages: unknown[] = mergeTurns(ctx.history);

  // Phase D：若有圖片，把最後一則 user 訊息替換成多模態格式（圖片 + 文字提示）
  if (ctx.imageData) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as { role: string; content: unknown };
      if (msg.role === "user") {
        messages = [
          ...messages.slice(0, i),
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: ctx.imageData.mediaType, data: ctx.imageData.base64 } },
              { type: "text", text: "請辨識這張圖片裡的商品，幫我搜尋庫存。" },
            ],
          },
          ...messages.slice(i + 1),
        ];
        break;
      }
    }
  }

  const model = ctx.imageData ? VISION_MODEL : MODEL;
  const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user");
  const lastText = typeof lastUserMsg?.content === "string"
    ? lastUserMsg.content.slice(0, 80)
    : "[multimodal]";
  console.log(`[claude] model=${model} history=${messages.length} bound=${!!ctx.consumer} img=${!!ctx.imageData} msg="${lastText}"`);

  for (let i = 0; i < 5; i++) {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        tools: toolDefs,
        messages,
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      console.error(`[claude] anthropic error status=${resp.status}`, errBody);
      return { kind: "text", text: "抱歉，系統忙線中，請稍後再問一次，或稍候由真人客服協助你 🙏" };
    }

    const data = await resp.json();
    console.log(`[claude] turn=${i} stop_reason=${data.stop_reason} input_tokens=${data.usage?.input_tokens} output_tokens=${data.usage?.output_tokens}`);

    if (data.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: data.content });
      const toolResults = [];
      for (const block of data.content) {
        if (block.type === "tool_use") {
          console.log(`[tool-call] ${block.name} input=${JSON.stringify(block.input).slice(0, 120)}`);
          const result = await dispatchTool(block.name, block.input ?? {}, ctx);
          console.log(`[tool-result] ${block.name} ok=${!(result as any)?.error} preview=${JSON.stringify(result).slice(0, 120)}`);
          // stage_order 成功 → 短路：直接送確認按鈕，不再讓 Claude 生成文字
          // （對話記憶只存最終文字，中斷 tool_use 序列不影響下一輪重建 messages）
          const staged = (result as Record<string, unknown>)?.__staged as StagedOrder | undefined;
          if (staged) {
            console.log(`[stage-order] staged pendingId=${staged.pendingId}`);
            return { kind: "confirm_order", staged };
          }
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        }
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // 沒有再呼叫工具 → 收斂為最終回覆
    const text = (data.content ?? [])
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("\n")
      .trim();
    console.log(`[claude] final reply preview="${text.slice(0, 80)}"`);
    return { kind: "text", text: text || "不好意思，我不太確定你的意思，可以再說一次嗎？ 🙏" };
  }

  console.error("[claude] exceeded max turns (5)");
  return { kind: "text", text: "抱歉，這題我查了幾次還是卡住，稍候由真人客服幫你確認 🙏" };
}

// LINE 純文字不支援 Markdown → 清掉常見語法符號，避免原樣顯示
function toPlainText(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1") // **粗體**
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$1") // *斜體*
    .replace(/`([^`]+)`/g, "$1") // `程式碼`
    .replace(/^#{1,6}\s+/gm, "") // # 標題
    .replace(/^\s*[-*]\s+/gm, "・") // - 項目符號 → ・
    .trim();
}

// ── LINE 回覆 ───────────────────────────────────────────────
async function lineReplyMessages(replyToken: string, messages: unknown[]) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LINE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ replyToken, messages }),
  });
  if (!res.ok) console.error("line reply error", res.status, await res.text());
}

async function lineReply(replyToken: string, text: string) {
  return lineReplyMessages(replyToken, [
    { type: "text", text: toPlainText(text).slice(0, 4900) },
  ]);
}

// 訂單確認：摘要純文字 + Confirm Template 按鈕（一次 reply 兩則）
// Confirm text 上限 240 字，摘要放前一則純文字避免截斷。
// displayText 讓點按後聊天室顯示文字，但 postback 不會產生 message 事件（不觸發 Claude）。
function buildConfirmMessages(staged: StagedOrder): unknown[] {
  return [
    { type: "text", text: staged.summary.slice(0, 4900) },
    {
      type: "template",
      altText: "訂單確認：請點選確認或取消",
      template: {
        type: "confirm",
        text: "請確認是否送出這筆訂單 👆",
        actions: [
          {
            type: "postback",
            label: "確認下單",
            data: `action=confirm_order&id=${staged.pendingId}`,
            displayText: "確認下單",
          },
          {
            type: "postback",
            label: "取消",
            data: `action=cancel_order&id=${staged.pendingId}`,
            displayText: "取消",
          },
        ],
      },
    },
  ];
}

// ── 驗簽：X-Line-Signature = base64(HMAC-SHA256(channelSecret, rawBody)) ──
async function verifySignature(body: string, signature: string): Promise<boolean> {
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(LINE_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return expected === signature;
}

// ── 限流：每 user 每分鐘 + 全站每日 ─────────────────────────
async function checkRateLimit(userId: string): Promise<{ ok: boolean; message?: string }> {
  const minAgo = new Date(Date.now() - 60_000).toISOString();
  const { count: perUser } = await admin
    .from("line_rate_log")
    .select("*", { count: "exact", head: true })
    .eq("line_user_id", userId)
    .gte("created_at", minAgo);
  if ((perUser ?? 0) >= RATE_PER_MIN) {
    return { ok: false, message: "你問得有點快，稍等幾秒再傳一次好嗎 🙏" };
  }

  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const { count: total } = await admin
    .from("line_rate_log")
    .select("*", { count: "exact", head: true })
    .gte("created_at", dayAgo);
  if ((total ?? 0) >= RATE_PER_DAY) {
    return { ok: false, message: "今天客服量比較滿，稍後再來找我問喔 🙏" };
  }
  return { ok: true };
}

// ── 對話記憶：載入近期、寫回本輪 ────────────────────────────
async function loadHistory(userId: string): Promise<ConversationTurn[]> {
  const since = new Date(Date.now() - SESSION_GAP_MS).toISOString();
  const { data } = await admin
    .from("line_messages")
    .select("role, content")
    .eq("line_user_id", userId)
    .gte("created_at", since) // 只取 session 內（逾時＝新對話）
    .order("created_at", { ascending: false })
    .limit(MEMORY_LIMIT);
  const rows = ((data ?? []) as ConversationTurn[]).reverse();
  // Anthropic 要求首則為 user；截斷可能導致開頭是 assistant，先剔除
  while (rows.length && rows[0].role !== "user") rows.shift();
  return rows;
}

// 由 LINE userId 反查已綁定的消費者，同時取最近一筆訂單地址供下單預填
async function resolveConsumer(
  userId: string,
): Promise<{ consumer: BoundConsumer | null; defaultAddress: string | null }> {
  const { data } = await admin
    .from("consumers")
    .select("id, name, phone, email")
    .eq("line_user_id", userId)
    .maybeSingle();

  if (!data) return { consumer: null, defaultAddress: null };
  const consumer = data as BoundConsumer;

  const { data: lastOrder } = await admin
    .from("consumer_orders")
    .select("address")
    .eq("consumer_id", consumer.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return { consumer, defaultAddress: lastOrder?.address ?? null };
}

async function saveMessage(userId: string, role: "user" | "assistant", content: string) {
  await admin.from("line_messages").insert({
    line_user_id: userId,
    role,
    content: content.slice(0, 4000),
  });
}

// ── 訂單確認 postback：完全不經 Claude 的確定性下單路徑 ──────
// 顧客點「確認下單/取消」按鈕 → 這裡直接查 line_pending_orders、
// 呼叫 place_order、回固定格式文字。杜絕 LLM 幻覺「訂單已成立」。
async function handleOrderPostback(userId: string, data: string, replyToken: string) {
  const params = new URLSearchParams(data);
  const action = params.get("action");
  const pendingId = params.get("id") ?? "";
  if (!["confirm_order", "cancel_order"].includes(action ?? "") || !pendingId) return;

  // 雙條件查詢是安全關鍵：postback 的 userId 由 LINE 平台認證（已過驗簽），偽造不了
  const { data: pending } = await admin
    .from("line_pending_orders")
    .select("*")
    .eq("id", pendingId)
    .eq("line_user_id", userId)
    .maybeSingle();

  if (!pending) {
    await lineReply(replyToken, "這筆訂單確認已失效，請重新告訴我要買什麼 🙏");
    return;
  }
  if (pending.status === "confirmed") {
    await lineReply(replyToken, "這筆訂單已經成立囉，不用重複點擊 😊");
    return;
  }
  if (pending.status === "cancelled") {
    await lineReply(replyToken, "這筆訂單已取消囉，想重新下單再跟我說 😊");
    return;
  }
  if (new Date(pending.expires_at).getTime() < Date.now()) {
    await admin.from("line_pending_orders").update({ status: "cancelled" }).eq("id", pendingId);
    await lineReply(replyToken, "這筆確認已逾時（超過 3 小時），請重新告訴我要買什麼 🙏");
    return;
  }

  if (action === "cancel_order") {
    await admin
      .from("line_pending_orders")
      .update({ status: "cancelled" })
      .eq("id", pendingId)
      .eq("status", "pending");
    const msg = "好的，已取消這筆訂單。想改什麼再跟我說 😊";
    await lineReply(replyToken, msg);
    await saveMessage(userId, "user", "（點選按鈕：取消訂單）");
    await saveMessage(userId, "assistant", msg);
    return;
  }

  // confirm_order：原子認領（連點/競態時只有一次搶得到 pending → confirmed）
  const { data: claimed } = await admin
    .from("line_pending_orders")
    .update({ status: "confirmed" })
    .eq("id", pendingId)
    .eq("status", "pending")
    .select()
    .maybeSingle();
  if (!claimed) {
    await lineReply(replyToken, "訂單處理中，請稍候 😊");
    return;
  }

  // 重取最新綁定資料（姓名/電話/email 可能在 stage 後更新）
  const { consumer } = await resolveConsumer(userId);
  if (!consumer) {
    await admin.from("line_pending_orders").update({ status: "cancelled" }).eq("id", pendingId);
    await lineReply(replyToken, "找不到你的會員綁定資料，請重新綁定後再下單 🙏");
    return;
  }

  const { data: orderResult, error: orderErr } = await admin.rpc("place_order", {
    p_customer_name: consumer.name ?? "",
    p_email: consumer.email ?? "",
    p_phone: consumer.phone ?? "",
    p_address: claimed.address,
    p_store_name: "",
    p_store_number: "",
    p_line_id: userId,
    p_remittance_last5: "",
    p_note: claimed.note,
    p_items: claimed.items_text,
    p_items_json: claimed.items_json,
    p_total_amount: Number(claimed.total_amount),
    p_shipping_fee: Math.round(Number(claimed.shipping_fee)),
    p_coupon_code: null,
    p_subtotal: Number(claimed.subtotal),
    p_consumer_email: consumer.email ?? "",
    p_store_id: claimed.store_id,
  });

  if (orderErr || !orderResult?.ok) {
    const reason = orderResult?.error || orderErr?.message || "系統忙線";
    console.error(`[postback] place_order failed pendingId=${pendingId}`, reason);
    // 標 cancelled 而非還原 pending：避免顧客反覆點一顆註定失敗的按鈕
    await admin.from("line_pending_orders").update({ status: "cancelled" }).eq("id", pendingId);
    await lineReply(replyToken, `下單沒有成功：${reason}\n請重新告訴我要買什麼，我再幫你確認一次 🙏`);
    return;
  }

  const discountAmount = Number(orderResult.discount_amount ?? 0);
  const finalTotal = Number(claimed.total_amount) - discountAmount;
  const successMsg = [
    "✅ 訂單成立！",
    `訂單編號：#${orderResult.store_order_no}`,
    claimed.items_text,
    `合計 $${finalTotal.toLocaleString()}（含運費 $${Number(claimed.shipping_fee).toLocaleString()}）`,
    "",
    `請匯款 $${finalTotal.toLocaleString()} 後，告訴我帳號末 5 碼，我們會盡快確認入帳 🙏`,
  ].join("\n");
  console.log(`[postback] order placed store_order_no=${orderResult.store_order_no} pendingId=${pendingId}`);
  await lineReply(replyToken, successMsg);

  // 寄訂單確認信：走商城同一條寄信路徑（Resend），fire-and-forget 不阻斷回覆
  if (orderResult.public_token) {
    fetch(`${SHOP_URL}/api/send-order-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: orderResult.public_token, lang: "zh" }),
    })
      .then((r) => console.log(`[postback] send-order-email status=${r.status}`))
      .catch((e) => console.error("[postback] send-order-email failed", e));
  }

  // 補回對話記憶，讓後續「我剛的訂單多少錢」有脈絡
  await saveMessage(userId, "user", "（點選按鈕：確認下單）");
  await saveMessage(userId, "assistant", successMsg);
}

// ── 進入點 ──────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok"); // 健康檢查

  const bodyText = await req.text();
  const signature = req.headers.get("x-line-signature") ?? "";
  if (!(await verifySignature(bodyText, signature))) {
    return new Response("bad signature", { status: 401 });
  }

  let body: { events?: any[] };
  try {
    body = JSON.parse(bodyText || "{}");
  } catch {
    return new Response("bad body", { status: 400 });
  }

  // 逐一處理事件；回應文字/圖片訊息與訂單按鈕 postback，其餘（加好友/貼圖…）先忽略
  for (const ev of body.events ?? []) {
    // 訂單確認按鈕：不經限流（無 Claude 成本、有 idempotency 保護）、不經 Claude
    if (ev.type === "postback" && ev.replyToken) {
      const pbUserId = ev.source?.userId ?? "unknown";
      console.log(`[event] userId=${pbUserId.slice(-6)} type=postback data="${(ev.postback?.data ?? "").slice(0, 80)}"`);
      try {
        await handleOrderPostback(pbUserId, ev.postback?.data ?? "", ev.replyToken);
      } catch (e) {
        console.error("handle postback error", e);
        try {
          await lineReply(ev.replyToken, "抱歉，系統出了點狀況，請稍後再試 🙏");
        } catch (_) { /* ignore */ }
      }
      continue;
    }

    const isText  = ev.type === "message" && ev.message?.type === "text";
    const isImage = ev.type === "message" && ev.message?.type === "image";
    if (!(isText || isImage) || !ev.replyToken) continue;

    const userId = ev.source?.userId ?? "unknown";
    const msgType = ev.message?.type ?? "unknown";
    const msgPreview = msgType === "text" ? (ev.message?.text ?? "").slice(0, 60) : `[${msgType}]`;
    console.log(`[event] userId=${userId.slice(-6)} type=${msgType} msg="${msgPreview}"`);
    try {
      // 限流：超過就回提示並跳過（不呼叫 Claude，省成本）
      const gate = await checkRateLimit(userId);
      if (!gate.ok) {
        await lineReply(ev.replyToken, gate.message!);
        continue;
      }
      await admin.from("line_rate_log").insert({ line_user_id: userId });

      let imageData: { base64: string; mediaType: string } | undefined;

      if (isImage) {
        // 先寫佔位文字進記憶，讓 history 序列完整
        await saveMessage(userId, "user", "[顧客傳了一張圖片，請辨識商品並搜尋庫存]");
        // 從 LINE Content API 取圖（不落地，僅本輪存在）
        const imgRes = await fetch(
          `https://api-data.line.me/v2/bot/message/${ev.message.id}/content`,
          { headers: { Authorization: `Bearer ${LINE_TOKEN}` } },
        );
        if (imgRes.ok) {
          const buf = await imgRes.arrayBuffer();
          imageData = {
            base64: bufToBase64(buf),
            mediaType: (imgRes.headers.get("content-type") ?? "image/jpeg").split(";")[0],
          };
        }
      } else {
        // 先寫入 user 訊息，讓「快速連發的下一則」也能立刻讀到本則（消除多輪時間差）
        await saveMessage(userId, "user", ev.message.text);
      }

      const history = await loadHistory(userId);
      const { consumer, defaultAddress } = await resolveConsumer(userId);
      const ctx: ToolContext = { admin, storeId: STORE_ID, lineUserId: userId, history, consumer, defaultAddress, imageData };
      const systemPrompt = buildSystemPrompt(consumer, defaultAddress);
      const answer = await askClaude(ctx, systemPrompt);
      if (answer.kind === "confirm_order") {
        // stage_order 成功：送訂單摘要＋確認按鈕（不經 Claude 生成）
        await lineReplyMessages(ev.replyToken, buildConfirmMessages(answer.staged));
        await saveMessage(userId, "assistant", `（已送出訂單確認按鈕，等待顧客點選）\n${answer.staged.summary}`);
      } else {
        await lineReply(ev.replyToken, answer.text);
        await saveMessage(userId, "assistant", answer.text);
      }

    } catch (e) {
      console.error("handle event error", e);
      try {
        await lineReply(ev.replyToken, "抱歉，系統出了點狀況，請稍後再試 🙏");
      } catch (_) { /* ignore */ }
    }
  }

  // LINE 要求 webhook 快速回 200（含它的 Verify 驗證）
  return new Response("ok");
});
