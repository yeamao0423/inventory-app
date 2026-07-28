// 加購（併單）的前端判定。規則必須與 DB 的 append_to_order 一致：
//   時間閘門（append_deadline）+ 狀態煞車（status）
// 刻意不看 payment_status —— 已付款的訂單一樣能加購，
// 加購後由 trigger 自動轉成「部分付款」，消費者補匯差額即可。

export const APPENDABLE_STATUSES = ['待確認', '處理中']

export function canAppendToOrder(order) {
  if (!order) return false
  if (!APPENDABLE_STATUSES.includes(order.status)) return false
  if (!order.append_deadline) return false
  return new Date(order.append_deadline) > new Date()
}

export function formatDeadline(iso, lang = 'zh') {
  if (!iso) return ''
  return new Date(iso).toLocaleString(lang === 'zh' ? 'zh-TW' : 'en-US', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

export function orderNoOf(order) {
  return String(order?.id ?? '').slice(-6)
}

// token 可另外指定：訂單完成頁的資料來自 get_consumer_order，
// 該 RPC 不回傳 public_token（token 本身就在網址上）
export function appendInfoFor(order, token) {
  return {
    token: token ?? order?.public_token,
    orderNo: orderNoOf(order),
    deadline: order?.append_deadline,
  }
}
