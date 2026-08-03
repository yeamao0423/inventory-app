// 商城站內聊天：訪客識別碼與 chat Edge Function 的呼叫封裝。
//
// 消費者端不直接連資料庫（ADR-0002），所有讀寫都經過這支 Edge Function。
// 訪客識別碼是隨機 UUID，只存 localStorage —— 它同時是 Realtime Broadcast 的頻道名，
// 等同一把能力型鑰匙，「不可」放進 URL 或任何會被記錄的地方。

const TOKEN_KEY = 'daigogo_visitor_token'
const FN_URL = `${process.env.NEXT_PUBLIC_SUPABASE_URL || ''}/functions/v1/chat`
const ANON = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

/** 取得（必要時建立）這個瀏覽器的訪客識別碼。 */
export function getVisitorToken() {
  if (typeof window === 'undefined') return null
  let token = null
  try { token = localStorage.getItem(TOKEN_KEY) } catch { return null }
  if (!token) {
    token = crypto.randomUUID()
    try { localStorage.setItem(TOKEN_KEY, token) } catch { /* 無痕模式寫不進去就算了 */ }
  }
  return token
}

/** Broadcast 頻道名：訪客識別碼。猜不到就聽不到。 */
export function visitorTopic(visitorToken) {
  return `chat:${visitorToken}`
}

function headers(accessToken) {
  return {
    'Content-Type': 'application/json',
    apikey: ANON,
    Authorization: `Bearer ${accessToken || ANON}`,
  }
}

async function parse(res) {
  let payload = null
  try { payload = await res.json() } catch { /* 空回應 */ }
  if (!res.ok) {
    const err = new Error(payload?.error || '連線失敗，請稍後再試')
    err.status = res.status
    err.rateLimited = !!payload?.rateLimited
    throw err
  }
  return payload
}

/** 載入歷史或輪詢新訊息。sinceId 給輪詢用（只取比它新的）。 */
export async function loadHistory({ storeId, visitorToken, conversationId, sinceId = 0 }) {
  const qs = new URLSearchParams({ storeId: String(storeId), visitorToken, sinceId: String(sinceId) })
  if (conversationId) qs.set('conversationId', String(conversationId))
  const res = await fetch(`${FN_URL}?${qs}`, { headers: headers() })
  return parse(res)
}

/** 送出一則訊息。turnstileToken 只有「開新對話」時才需要。 */
export async function sendMessage({ storeId, visitorToken, conversationId, text, turnstileToken }) {
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ action: 'send', storeId, visitorToken, conversationId, text, turnstileToken }),
  })
  return parse(res)
}

/** 消費者主動要求真人客服。 */
export async function requestHuman({ storeId, visitorToken, conversationId }) {
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ action: 'request_human', storeId, visitorToken, conversationId }),
  })
  return parse(res)
}

/**
 * 認領：登入或下單、身分揭曉時，把訪客識別碼底下屬於該店的對話歸到那位消費者名下。
 * 身分由 accessToken 證明，不能由前端指定 consumer_id。
 */
export async function claimConversations({ storeId, visitorToken, accessToken }) {
  if (!accessToken) return { claimed: 0 }
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: headers(accessToken),
    body: JSON.stringify({ action: 'claim', storeId, visitorToken }),
  })
  return parse(res)
}
