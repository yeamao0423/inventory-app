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
//
// AI 自動回覆可以整店關掉（stores.settings.ai_reply，預設關）。關掉時 bot 是「不可能狀態」——
// 標著助理在服務、實際上沒有任何人會回話。所以每一條原本會落到 bot 的路徑都得吃 aiEnabled，
// 一律改落 waiting_human：顧客看到的是「已通知真人客服」，收件匣也會把它排到最前面。
// aiEnabled 預設 true，呼叫端沒帶就是舊行為。

export const IDLE_HANDBACK_MS = 30 * 60 * 1000

/** 助理是否該自動回覆這條對話。接管期間、以及整店關閉 AI 時靜音。 */
export function shouldRunAssistant(status, { aiEnabled = true } = {}) {
  if (!aiEnabled) return false
  return status === 'bot'
}

/** 新對話的起始狀態。 */
export function initialStatus({ aiEnabled = true } = {}) {
  return aiEnabled ? 'bot' : 'waiting_human'
}

/**
 * 消費者發話時對話該落到什麼狀態。
 * 只有兩種會變：真人接管後閒置太久自動交還、已關閉的對話被重新開啟。
 */
export function nextStatusOnConsumerMessage({
  status, lastStaffAt, now = Date.now(), idleMs = IDLE_HANDBACK_MS, aiEnabled = true,
}) {
  const idle = aiEnabled ? 'bot' : 'waiting_human'
  if (status === 'closed') return idle
  if (status === 'human') {
    const last = lastStaffAt ? new Date(lastStaffAt).getTime() : null
    // 沒有任何真人訊息就視為剛接管，不算閒置
    if (last !== null && now - last > idleMs) return idle
    return 'human'
  }
  // AI 關掉之前建立的對話還停在 bot，這時候要把它接回真人佇列
  if (status === 'bot' && !aiEnabled) return 'waiting_human'
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

/** 店主交還給助理。AI 關著就沒有助理可交還，退回真人佇列。 */
export function nextStatusOnHandback({ aiEnabled = true } = {}) {
  return aiEnabled ? 'bot' : 'waiting_human'
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

function rank(status) {
  return STATUS_RANK[status] ?? 9
}

export function sortConversations(list) {
  return [...list].sort((a, b) => {
    const sa = rank(a.status)
    const sb = rank(b.status)
    if (sa !== sb) return sa - sb
    const ua = (a.unread_for_store ?? 0) > 0 ? 0 : 1
    const ub = (b.unread_for_store ?? 0) > 0 ? 0 : 1
    if (ua !== ub) return ua - ub
    return new Date(b.last_message_at ?? 0) - new Date(a.last_message_at ?? 0)
  })
}

// ── 依「人」分組 ────────────────────────────────────────────
// 同一位會員可能在好幾台裝置留下好幾條對話（換瀏覽器、清快取、換手機）。
// 客服要處理的是「這個人」，不是「這條記錄」，所以列表以人為單位。
//
// 這是純顯示層的收斂：資料表不動、既有對話不搬。
// 只有後台用 —— 不要複製到 Edge Function 的 policy.ts。

/** a 是不是比 b 新。b 為空視為「還沒有值」，所以 a 只要有值就算新。 */
function newer(a, b) {
  if (!a) return false
  if (!b) return true
  return new Date(a) > new Date(b)
}

/**
 * @param {Array} list conversations 的原始列（可含壞資料）
 * @returns {Array} 每位顧客一組
 */
export function groupConversations(list) {
  const map = new Map()
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || typeof c !== 'object') continue
    // 已識別的以人為鍵；未識別的訪客各自成組（他們之間本來就是不同的人）
    const key = c.consumer_id ? `c:${c.consumer_id}` : `v:${c.id}`
    let g = map.get(key)
    if (!g) {
      g = {
        key,
        consumerId: c.consumer_id ?? null,
        conversationIds: [],
        label: null,
        channel: c.channel ?? 'web',
        status: null,
        unread: 0,
        assignedTo: null,
        lastMessageAt: null,
        lastMessagePreview: null,
        lastMessageSender: null,
        _assignedAt: null,
      }
      map.set(key, g)
    }
    g.conversationIds.push(c.id)
    g.unread += Number(c.unread_for_store) || 0
    if (!g.label && c.customer_label) g.label = c.customer_label
    // 狀態取最急的：客服看列表是在找「誰在等我」
    if (g.status === null || rank(c.status) < rank(g.status)) g.status = c.status
    // 最後訊息與指派對象跟著最新那條走
    if (newer(c.last_message_at, g.lastMessageAt)) {
      g.lastMessageAt = c.last_message_at ?? g.lastMessageAt
      g.lastMessagePreview = c.last_message_preview ?? null
      g.lastMessageSender = c.last_message_sender ?? null
    }
    if (c.assigned_to && newer(c.last_message_at, g._assignedAt)) {
      g.assignedTo = c.assigned_to
      g._assignedAt = c.last_message_at ?? null
    }
  }
  return [...map.values()].map(({ _assignedAt, ...g }) => ({
    ...g,
    status: g.status ?? 'bot',
    conversationIds: g.conversationIds.filter(id => id != null),
  }))
}

/** 與 sortConversations 同一套規則，只是吃分組後的形狀。 */
export function sortGroups(list) {
  return [...list].sort((a, b) => {
    const sa = rank(a.status)
    const sb = rank(b.status)
    if (sa !== sb) return sa - sb
    const ua = (a.unread ?? 0) > 0 ? 0 : 1
    const ub = (b.unread ?? 0) > 0 ? 0 : 1
    if (ua !== ub) return ua - ub
    return new Date(b.lastMessageAt ?? 0) - new Date(a.lastMessageAt ?? 0)
  })
}
