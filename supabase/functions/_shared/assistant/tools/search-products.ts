import type { Tool } from "../types.ts";

// 依名稱/關鍵字模糊找商品（斷詞＋相似度，只回已上架）
// 複製自 line-webhook/tools/search-products.ts —— 只查 Supabase，與傳輸層無關。
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
      p_store_id: ctx.storeId, // 跨店紅線：只查這家店的商品
      p_query: q,
    });
    if (error) return { error: error.message };
    return { results: data ?? [] };
  },
};
