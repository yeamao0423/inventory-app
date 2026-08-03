import type { Tool } from "../types.ts";

// 助理舉手：判定該轉真人時呼叫。把對話設為 waiting_human 並通知店主。
// 觸發條件沿用 SYSTEM_PROMPT 寫好的規則（退換貨爭議、客訴、涉及金錢的要求、查不到商品）。
export const requestHuman: Tool = {
  name: "request_human",
  tier: "action",
  description:
    "把這條對話轉給真人客服。當遇到退換貨爭議、客訴、任何涉及金錢的要求（退款/折扣/補償），" +
    "或查不到對方要的商品、問題超出你能查詢的範圍時呼叫。" +
    "呼叫後要用一句話讓對方知道已經幫他找真人客服了，不要重複道歉或編造承諾。",
  inputSchema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "為什麼要轉真人，一句話（給店主看的，不會顯示給消費者）",
      },
    },
    required: ["reason"],
  },
  async handler(input, ctx) {
    const reason = String(input.reason ?? "").slice(0, 300) || "（未說明）";
    await ctx.requestHuman(reason);
    return { ok: true, message: "已轉給真人客服，對話狀態改為等待真人。" };
  },
};
