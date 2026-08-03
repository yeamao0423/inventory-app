// 客服助理的型別定義：一支工具 = schema + 分級 + 實作。
//
// 這份是 line-webhook/core/types.ts 的複本（刻意複製，不跨資料夾 import），
// 差別在 ToolContext 不再綁 LINE：改帶「對話」與「身分」，讓同一個引擎能服務任何管道。
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// read＝唯讀查詢，可自由新增；action＝會動到資料/狀態，需額外防護閘
export type ToolTier = "read" | "action";

export type ChannelName = "web" | "line";

// 一則對話往來（只存最終文字，不含 tool_use 中間過程）
export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

// 已識別的消費者（訪客為 null —— 系統不知道他是誰）
export interface BoundConsumer {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
}

// 每次工具執行時可拿到的情境
export interface ToolContext {
  admin: SupabaseClient;
  storeId: number;
  channel: ChannelName;
  conversationId: number;
  // 尚未識別身分的訪客識別碼（已認領的對話為 null）
  visitorToken: string | null;
  consumer: BoundConsumer | null;
  history: ConversationTurn[];
  // request_human 用：把「這條對話該轉真人」回報給呼叫端
  requestHuman: (reason: string) => Promise<void>;
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
