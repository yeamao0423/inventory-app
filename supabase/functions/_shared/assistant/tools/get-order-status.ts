import type { Tool } from "../types.ts";

// 查「本人」訂單進度：需已識別身分；不吃任何使用者輸入的編號/電話 → 無法查到別人。
// 複製自 line-webhook/tools/get-order-status.ts，差別在未識別時的回覆語意：
// 站內是「訪客」（系統不知道他是誰），要引導登入而不是引導綁定 LINE。
export const getMyOrders: Tool = {
  name: "get_my_orders",
  tier: "read",
  description:
    "查詢『目前這位已登入消費者本人』的訂單進度（狀態、物流、付款）。直接查本人名下訂單，「不需也不可」向對方索取訂單編號或電話。若對方尚未登入，工具會回傳 identified=false。",
  inputSchema: { type: "object", properties: {} },
  async handler(_input, ctx) {
    // 匿名訪客：明確回傳「未識別身分」，讓助理引導登入，不可臆測
    if (!ctx.consumer) {
      return {
        identified: false,
        message: "目前是尚未識別身分的訪客，系統不知道他是誰，無法查詢任何訂單。請引導對方先登入會員。",
      };
    }
    const { data, error } = await ctx.admin.rpc("line_get_orders_by_consumer", {
      p_store_id: ctx.storeId, // 跨店紅線：只查這家店的訂單
      p_consumer_id: ctx.consumer.id,
      p_phone: ctx.consumer.phone ?? "",
    });
    if (error) return { error: error.message };
    return { identified: true, orders: data ?? [] };
  },
};
