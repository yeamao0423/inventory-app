// 對話狀態機、限流判斷、記憶取用範圍 —— 純規則，沒有副作用。
//
// 這是 src/lib/customerInbox.js 的 TypeScript 等價複本。
// 那一份有 vitest（src/lib/customerInbox.test.js）且被後台工作台使用；
// 這一份給 Edge Function 用。改任何一條規則兩邊都要改。

export const IDLE_HANDBACK_MS = 30 * 60 * 1000;

export type ConversationStatus = "bot" | "waiting_human" | "human" | "closed";

/** 助理是否該自動回覆這條對話。接管期間助理靜音。 */
export function shouldRunAssistant(status: ConversationStatus): boolean {
  return status === "bot";
}

/**
 * 消費者發話時對話該落到什麼狀態。
 * 只有兩種會變：真人接管後閒置太久自動交還、已關閉的對話被重新開啟。
 */
export function nextStatusOnConsumerMessage(
  { status, lastStaffAt, now = Date.now(), idleMs = IDLE_HANDBACK_MS }: {
    status: ConversationStatus;
    lastStaffAt?: string | null;
    now?: number;
    idleMs?: number;
  },
): ConversationStatus {
  if (status === "closed") return "bot";
  if (status === "human") {
    const last = lastStaffAt ? new Date(lastStaffAt).getTime() : null;
    if (last !== null && now - last > idleMs) return "bot";
    return "human";
  }
  return status;
}

/** 舉手轉真人（助理呼叫 request_human，或消費者按「找真人」）。 */
export function nextStatusOnRequestHuman(status: ConversationStatus): ConversationStatus {
  if (status === "human") return "human";
  return "waiting_human";
}

// ── 限流 ────────────────────────────────────────────────────
export const DEFAULT_RATE_PER_MIN = 6;
export const DEFAULT_RATE_PER_DAY = 300;

export interface RateDecision {
  ok: boolean;
  reason?: "visitor" | "store";
  message?: string;
}

export function rateLimitDecision(
  { perVisitorCount, perStoreCount, perVisitorLimit = DEFAULT_RATE_PER_MIN, perStoreLimit = DEFAULT_RATE_PER_DAY }: {
    perVisitorCount: number;
    perStoreCount: number;
    perVisitorLimit?: number;
    perStoreLimit?: number;
  },
): RateDecision {
  if (perVisitorCount >= perVisitorLimit) {
    return { ok: false, reason: "visitor", message: "你問得有點快，稍等幾秒再傳一次好嗎 🙏" };
  }
  if (perStoreCount >= perStoreLimit) {
    return { ok: false, reason: "store", message: "今天客服量比較滿，稍後再來找我問喔 🙏" };
  }
  return { ok: true };
}

// ── 記憶取用範圍 ────────────────────────────────────────────
export const DEFAULT_MEMORY_LIMIT = 20;

export interface MemoryScope {
  storeId: number;
  key: "consumer_id" | "visitor_token";
  value: string;
}

/** 決定用哪個身分鍵去撈記憶。跨店紅線：一定帶 storeId。 */
export function memoryScope(
  { storeId, consumerId, visitorToken }: {
    storeId: number;
    consumerId?: string | null;
    visitorToken?: string | null;
  },
): MemoryScope {
  if (!storeId) throw new Error("memoryScope 必須帶 storeId（跨店隔離）");
  if (consumerId) return { storeId, key: "consumer_id", value: consumerId };
  if (visitorToken) return { storeId, key: "visitor_token", value: visitorToken };
  throw new Error("memoryScope 需要 consumerId 或 visitorToken");
}

/**
 * 把資料庫撈出的訊息整理成可以送進 Anthropic 的對話序列。
 * 詳細規則見 src/lib/customerInbox.js 的同名函式。
 */
export function memoryWindow(
  rows: { sender: string; content: string }[],
  limit = DEFAULT_MEMORY_LIMIT,
): { role: "user" | "assistant"; content: string }[] {
  const recent = rows.slice(-limit);
  const turns = recent.map((r) => ({
    role: (r.sender === "consumer" ? "user" : "assistant") as "user" | "assistant",
    content: r.content,
  }));
  while (turns.length && turns[0].role !== "user") turns.shift();
  const merged: { role: "user" | "assistant"; content: string }[] = [];
  for (const t of turns) {
    const last = merged[merged.length - 1];
    if (last && last.role === t.role) last.content += "\n" + t.content;
    else merged.push({ ...t });
  }
  return merged;
}

// ── 訪客識別碼 ──────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidVisitorToken(token: unknown): token is string {
  return typeof token === "string" && UUID_RE.test(token);
}
