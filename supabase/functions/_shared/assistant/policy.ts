// 對話狀態機、限流判斷、記憶取用範圍 —— 純規則，沒有副作用。
//
// 這是 src/lib/customerInbox.js 的 TypeScript 等價複本。
// 那一份有 vitest（src/lib/customerInbox.test.js）且被後台工作台使用；
// 這一份給 Edge Function 用。改任何一條規則兩邊都要改。

// AI 自動回覆可以整店關掉（stores.settings.ai_reply，預設關）。關掉時 bot 是「不可能狀態」——
// 標著助理在服務、實際上沒有任何人會回話。所以每一條原本會落到 bot 的路徑都得吃 aiEnabled，
// 一律改落 waiting_human。詳見 src/lib/customerInbox.js 的同段註解。
//
// waiting_human 原本沒有逃生門，跟 human 早就有的 30 分鐘閒置自動交還不對稱——
// 2026-08-19 補上：沒人接手超過 12 小時視為冷掉，消費者下次發話重新評估 aiEnabled。
export const IDLE_HANDBACK_MS = 30 * 60 * 1000;
export const WAITING_TIMEOUT_MS = 12 * 60 * 60 * 1000;

export type ConversationStatus = "bot" | "waiting_human" | "human" | "closed";

/** 助理是否該自動回覆這條對話。接管期間、以及整店關閉 AI 時靜音。 */
export function shouldRunAssistant(
  status: ConversationStatus,
  { aiEnabled = true }: { aiEnabled?: boolean } = {},
): boolean {
  if (!aiEnabled) return false;
  return status === "bot";
}

/** 新對話的起始狀態。 */
export function initialStatus({ aiEnabled = true }: { aiEnabled?: boolean } = {}): ConversationStatus {
  return aiEnabled ? "bot" : "waiting_human";
}

/**
 * 消費者發話時對話該落到什麼狀態。
 * 會變的情況：真人接管後閒置太久自動交還、等真人太久沒人接手視為冷掉、
 * 已關閉的對話被重新開啟。
 */
export function nextStatusOnConsumerMessage(
  { status, lastStaffAt, lastMessageAt, now = Date.now(), idleMs = IDLE_HANDBACK_MS, waitingTimeoutMs = WAITING_TIMEOUT_MS, aiEnabled = true }: {
    status: ConversationStatus;
    lastStaffAt?: string | null;
    lastMessageAt?: string | null;
    now?: number;
    idleMs?: number;
    waitingTimeoutMs?: number;
    aiEnabled?: boolean;
  },
): ConversationStatus {
  const idle: ConversationStatus = aiEnabled ? "bot" : "waiting_human";
  if (status === "closed") return idle;
  if (status === "human") {
    const last = lastStaffAt ? new Date(lastStaffAt).getTime() : null;
    if (last !== null && now - last > idleMs) return idle;
    return "human";
  }
  if (status === "waiting_human") {
    const last = lastMessageAt ? new Date(lastMessageAt).getTime() : null;
    if (last !== null && now - last > waitingTimeoutMs) return idle;
    return "waiting_human";
  }
  // AI 關掉之前建立的對話還停在 bot，這時候要把它接回真人佇列
  if (status === "bot" && !aiEnabled) return "waiting_human";
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
