// 客服收件匣的純規則：對話狀態機、限流判斷、記憶取用範圍、工作台排序。
//
// 這些規則沒有副作用，所以拆出來單獨測（見 customerInbox.test.js）。
// 後台工作台（src/pages/InboxPage.jsx）直接用這裡；
// Edge Function 端有一份等價的 TypeScript 複本在
// supabase/functions/_shared/assistant/policy.ts —— 兩份必須同步維護，
// 刻意不跨資料夾 import，避免 Edge Function 打包時把後台程式碼拉進去。

// ── 對話狀態機 ──────────────────────────────────────────────
//   bot →（助理舉手／消費者要求）→ waiting_human
//   waiting_human →（店主接手）→ human
//   human →（交還／閒置 30 分鐘）→ bot
//   closed 由店主手動關閉，消費者再次發話會重新開啟

export const IDLE_HANDBACK_MS = 30 * 60 * 1000

/** 助理是否該自動回覆這條對話。接管期間助理靜音。 */
export function shouldRunAssistant(status) {
  return status === 'bot'
}

/**
 * 消費者發話時對話該落到什麼狀態。
 * 只有兩種會變：真人接管後閒置太久自動交還、已關閉的對話被重新開啟。
 */
export function nextStatusOnConsumerMessage({ status, lastStaffAt, now = Date.now(), idleMs = IDLE_HANDBACK_MS }) {
  if (status === 'closed') return 'bot'
  if (status === 'human') {
    const last = lastStaffAt ? new Date(lastStaffAt).getTime() : null
    // 沒有任何真人訊息就視為剛接管，不算閒置
    if (last !== null && now - last > idleMs) return 'bot'
    return 'human'
  }
  return status
}

/** 舉手轉真人（助理呼叫 request_human，或消費者按「找真人」）。 */
export function nextStatusOnRequestHuman(status) {
  // 已經有真人在處理就不用再排隊
  if (status === 'human') return 'human'
  return 'waiting_human'
}

/** 店主接管。 */
export function nextStatusOnTakeover() {
  return 'human'
}

/** 店主交還給助理。 */
export function nextStatusOnHandback() {
  return 'bot'
}

// ── 限流 ────────────────────────────────────────────────────
// 兩層上限：每訪客每分鐘、每店每日。任何一層滿了就擋，且擋下時「不呼叫 Anthropic API」。

export const DEFAULT_RATE_PER_MIN = 6
export const DEFAULT_RATE_PER_DAY = 300

/**
 * @param {{ perVisitorCount:number, perStoreCount:number, perVisitorLimit?:number, perStoreLimit?:number }} args
 * @returns {{ ok:boolean, reason?:'visitor'|'store', message?:string }}
 */
export function rateLimitDecision({
  perVisitorCount,
  perStoreCount,
  perVisitorLimit = DEFAULT_RATE_PER_MIN,
  perStoreLimit = DEFAULT_RATE_PER_DAY,
}) {
  if (perVisitorCount >= perVisitorLimit) {
    return { ok: false, reason: 'visitor', message: '你問得有點快，稍等幾秒再傳一次好嗎 🙏' }
  }
  if (perStoreCount >= perStoreLimit) {
    return { ok: false, reason: 'store', message: '今天客服量比較滿，稍後再來找我問喔 🙏' }
  }
  return { ok: true }
}

// ── 記憶取用範圍 ────────────────────────────────────────────
// 記憶掛在「人」身上：有 consumer_id 就用它、否則用訪客識別碼，
// 取該身分在「該店」的最近 N 則，不限時間、不限 session（與 LINE 版最大的差異）。

export const DEFAULT_MEMORY_LIMIT = 20

/**
 * 決定要用哪個身分鍵去撈記憶。跨店紅線：一定帶 storeId。
 * @returns {{ storeId:number, key:'consumer_id'|'visitor_token', value:string }}
 */
export function memoryScope({ storeId, consumerId, visitorToken }) {
  if (!storeId) throw new Error('memoryScope 必須帶 storeId（跨店隔離）')
  if (consumerId) return { storeId, key: 'consumer_id', value: consumerId }
  if (visitorToken) return { storeId, key: 'visitor_token', value: visitorToken }
  throw new Error('memoryScope 需要 consumerId 或 visitorToken')
}

/**
 * 把資料庫撈出的訊息整理成可以送進 Anthropic 的對話序列。
 *   1. 只留最近 limit 則
 *   2. sender 對應 role：consumer→user，assistant/staff→assistant
 *   3. 開頭若是 assistant 先剔除（Anthropic 要求首則為 user）
 *   4. 合併連續同角色（連發訊息會產生兩則 user）
 * @param {{sender:string, content:string}[]} rows 由舊到新
 */
export function memoryWindow(rows, limit = DEFAULT_MEMORY_LIMIT) {
  const recent = rows.slice(-limit)
  const turns = recent.map(r => ({
    role: r.sender === 'consumer' ? 'user' : 'assistant',
    content: r.content,
  }))
  while (turns.length && turns[0].role !== 'user') turns.shift()
  const merged = []
  for (const t of turns) {
    const last = merged[merged.length - 1]
    if (last && last.role === t.role) last.content += '\n' + t.content
    else merged.push({ ...t })
  }
  return merged
}

// ── 訪客識別碼 ──────────────────────────────────────────────
// 隨機 UUID，存 localStorage。不可放進 URL 或任何會被記錄的地方（ADR-0002）。

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidVisitorToken(token) {
  return typeof token === 'string' && UUID_RE.test(token)
}

// ── 工作台排序 ──────────────────────────────────────────────
// 等真人的排最前面，其次是有未讀的，再來才照最後訊息時間。

const STATUS_RANK = { waiting_human: 0, human: 1, bot: 2, closed: 3 }

export function sortConversations(list) {
  return [...list].sort((a, b) => {
    const sa = STATUS_RANK[a.status] ?? 9
    const sb = STATUS_RANK[b.status] ?? 9
    if (sa !== sb) return sa - sb
    const ua = (a.unread_for_store ?? 0) > 0 ? 0 : 1
    const ub = (b.unread_for_store ?? 0) > 0 ? 0 : 1
    if (ua !== ub) return ua - ub
    return new Date(b.last_message_at ?? 0) - new Date(a.last_message_at ?? 0)
  })
}
