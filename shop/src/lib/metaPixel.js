// Meta Pixel：依店家設定（stores.settings.meta_pixel_id）動態載入。
// 未設定 ID 的店所有 track 呼叫皆為 no-op，商城不會載入任何 Meta 程式。

let ready = false
let pending = [] // init 前發生的事件先暫存，init 後補發（例：直接落地商品頁時的 ViewContent）

// 官方 fbevents.js 載入器（改寫自 Meta 提供的壓縮版基底碼）
function loadFbEvents() {
  if (window.fbq) return
  const n = (window.fbq = function () {
    n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments)
  })
  if (!window._fbq) window._fbq = n
  n.push = n
  n.loaded = true
  n.version = '2.0'
  n.queue = []
  const s = document.createElement('script')
  s.async = true
  s.src = 'https://connect.facebook.net/en_US/fbevents.js'
  document.head.appendChild(s)
}

export function initMetaPixel(pixelId) {
  if (ready || !pixelId || typeof window === 'undefined') return
  loadFbEvents()
  window.fbq('init', String(pixelId).trim())
  window.fbq('track', 'PageView')
  ready = true
  pending.forEach(([event, params, opts]) => window.fbq('track', event, params, opts))
  pending = []
}

// 標準事件（ViewContent / AddToCart / InitiateCheckout / Purchase…）
// opts 可帶 { eventID }，之後接 Conversions API 時用來去重
export function trackPixel(event, params, opts) {
  if (typeof window === 'undefined') return
  if (!ready) {
    pending.push([event, params, opts])
    if (pending.length > 20) pending.shift() // 沒設定 Pixel 的店不讓暫存無限長大
    return
  }
  window.fbq('track', event, params, opts)
}

// SPA 換頁補發 PageView（init 時已發首次，未 init 前不補、不暫存）
export function trackPageView() {
  if (typeof window === 'undefined' || !ready) return
  window.fbq('track', 'PageView')
}
