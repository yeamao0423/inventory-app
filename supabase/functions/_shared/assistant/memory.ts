// 記憶：取「該身分」在「該店」的最近 N 則訊息，不限時間、不限 session。
//
// 記憶掛在人身上（ADR-0001）：有 consumer_id 就用它、否則用訪客識別碼。
// 跨店紅線：查詢一定帶 store_id —— 同一位消費者在 A 店與 B 店的對話絕對不能互見。
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { DEFAULT_MEMORY_LIMIT, memoryScope, memoryWindow } from "./policy.ts";
import type { ConversationTurn } from "./types.ts";

export async function loadMemory(
  admin: SupabaseClient,
  { storeId, consumerId, visitorToken, limit = DEFAULT_MEMORY_LIMIT }: {
    storeId: number;
    consumerId?: string | null;
    visitorToken?: string | null;
    limit?: number;
  },
): Promise<ConversationTurn[]> {
  const scope = memoryScope({ storeId, consumerId, visitorToken });

  // 先找出這個身分在這家店的所有對話（本版只有 web，但不特別限制管道 ——
  // 第二階段 LINE 併進來時，記憶自然就跨管道了，這正是 ADR-0001 要的）
  const { data: convs } = await admin
    .from("conversations")
    .select("id")
    .eq("store_id", scope.storeId)
    .eq(scope.key, scope.value);

  const ids = (convs ?? []).map((c: { id: number }) => c.id);
  if (ids.length === 0) return [];

  // 取最近 limit 則（DB 端由新到舊，取完再翻回時間順序）
  const { data } = await admin
    .from("messages")
    .select("sender, content")
    .in("conversation_id", ids)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);

  const rows = ((data ?? []) as { sender: string; content: string }[]).reverse();
  return memoryWindow(rows, limit) as ConversationTurn[];
}
