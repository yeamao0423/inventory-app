import type { Tool } from "../types.ts";

// 查指定商品的即時庫存/售價（含各規格、預購旗標，不含成本）
// 複製自 line-webhook/tools/get-stock.ts，另補一道跨店檢查：
// line_get_stock 只吃 product_id，不帶 store_id，所以這裡先確認商品確實屬於本店。
export const getStock: Tool = {
  name: "get_stock",
  tier: "read",
  description:
    "查詢指定商品的即時庫存與售價（含各規格）。需要 product_id，通常先用 search_products 取得。",
  inputSchema: {
    type: "object",
    properties: {
      product_id: { type: "integer", description: "商品 ID" },
    },
    required: ["product_id"],
  },
  async handler(input, ctx) {
    const productId = Number(input.product_id);
    if (!Number.isInteger(productId)) return { error: "product_id 必須是整數" };

    const { data: owned } = await ctx.admin
      .from("products")
      .select("id")
      .eq("id", productId)
      .eq("store_id", ctx.storeId)
      .maybeSingle();
    if (!owned) return { error: "查無此商品" };

    const { data, error } = await ctx.admin.rpc("line_get_stock", {
      p_product_id: productId,
    });
    if (error) return { error: error.message };
    return data ?? { error: "查無此商品" };
  },
};
