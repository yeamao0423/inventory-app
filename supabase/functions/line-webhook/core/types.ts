// 工具的型別定義：一支工具 = schema + 分級 + 實作
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// read＝唯讀查詢，可自由新增；action＝會動到資料/金錢，需額外防護閘（下單/退款…）
export type ToolTier = "read" | "action";

// 每次工具執行時可拿到的情境（取代散落的全域變數，未來可放對話歷史、購物車…）
export interface ToolContext {
  admin: SupabaseClient;
  storeId: number;
  lineUserId: string;
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
