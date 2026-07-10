// 工具的型別定義：一支工具 = schema + 分級 + 實作
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// read＝唯讀查詢，可自由新增；action＝會動到資料/金錢，需額外防護閘（下單/退款…）
export type ToolTier = "read" | "action";

// 一則對話（只存最終文字，不含 tool_use 中間過程）
export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

// 已綁定的消費者（由 line_user_id 反查而來；null＝尚未綁定）
export interface BoundConsumer {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
}

// 每次工具執行時可拿到的情境（取代散落的全域變數，未來可放購物車…）
export interface ToolContext {
  admin: SupabaseClient;
  storeId: number;
  lineUserId: string;
  history: ConversationTurn[]; // 本次 session 的近期對話（下單 slot-filling 可用）
  consumer: BoundConsumer | null; // 綁定的本人；個人資料工具需檢查
  imageData?: { base64: string; mediaType: string }; // Phase D: 傳圖搜尋（不落地，僅本輪存在）
  defaultAddress?: string | null; // Phase E: 上次訂單地址，用於預填收件資訊
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON schema（object）
  tier: ToolTier;
  handler: (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

// Anthropic messages API 需要的工具宣告格式
export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// stage_order 成功時工具結果攜帶的短路訊號（askClaude 看到就直接送確認按鈕）
export interface StagedOrder {
  pendingId: string;
  summary: string;
}

// askClaude 的回傳：純文字回覆，或「送出訂單確認按鈕」指令
export type AskResult =
  | { kind: "text"; text: string }
  | { kind: "confirm_order"; staged: StagedOrder };
