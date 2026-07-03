import type { Tool } from "../core/types.ts";

// 依名稱/關鍵字模糊找商品（斷詞＋相似度，只回已上架）
export const searchProducts: Tool = {
  name: "search_products",
  tier: "read",
  description:
    "依商品名稱或關鍵字模糊搜尋商品，找出使用者可能指的是哪個商品。當你需要某商品的 product_id 卻還不知道時使用。回傳候選商品清單。",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "商品名稱或關鍵字" },
    },
    required: ["query"],
  },
  async handler(input, ctx) {
    const q = String(input.query ?? "").slice(0, 100);
    const { data, error } = await ctx.admin.rpc("line_search_products", {
      p_store_id: ctx.storeId,
      p_query: q,
    });
    if (error) return { error: error.message };
    return { results: data ?? [] };
  },
};
