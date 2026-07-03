import type { Tool } from "../core/types.ts";

// 查指定商品的即時庫存/售價（含各規格、預購旗標，不含成本）
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
    const { data, error } = await ctx.admin.rpc("line_get_stock", {
      p_product_id: Number(input.product_id),
    });
    if (error) return { error: error.message };
    return data ?? { error: "查無此商品" };
  },
};
