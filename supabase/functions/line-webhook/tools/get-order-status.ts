import type { Tool } from "../core/types.ts";

// 查「本人」訂單進度：需已綁定會員；不吃任何使用者輸入的編號/電話 → 無法查到別人。
export const getMyOrders: Tool = {
  name: "get_my_orders",
  tier: "read",
  description:
    "查詢『目前這位已綁定會員本人』的訂單進度（狀態、物流、付款）。直接查本人名下訂單，「不需也不可」向顧客索取訂單編號或電話。若顧客未綁定會員，工具會回傳 bound=false。",
  inputSchema: { type: "object", properties: {} },
  async handler(_input, ctx) {
    if (!ctx.consumer) {
      return { bound: false, message: "顧客尚未綁定 LINE 會員，需先綁定才能查本人訂單。" };
    }
    const { data, error } = await ctx.admin.rpc("line_get_orders_by_consumer", {
      p_store_id: ctx.storeId,
      p_consumer_id: ctx.consumer.id,
      p_phone: ctx.consumer.phone ?? "",
    });
    if (error) return { error: error.message };
    return { bound: true, orders: data ?? [] };
  },
};
