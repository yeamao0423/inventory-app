// 後台 ↔ 即時預覽 iframe 的訊息協定。純函式，沒有 DOM 依賴，方便測。
//
// 流程：iframe 掛好 listener 後主動送 ready → 後台收到才推第一份內容
//（不先握手的話，iframe 還在載入時後台推出去的第一份會被丟掉，預覽會停在空白）。
// 之後只有後台單向推內容，iframe 不回傳任何東西。
//
// ⚠️ 後台端有一份對應的常數（src/components/LivePreview.jsx），兩邊要一起改。
// 字串刻意帶前綴：同一個 window 上還有 Next.js HMR、瀏覽器擴充套件在丟 message。

export const PREVIEW_READY = 'daigogo:preview-ready'
export const PREVIEW_CONTENT = 'daigogo:preview-content'

// parentOrigin 由網址帶進來，會被拿去當 postMessage 的 targetOrigin 與比對基準，
// 所以只收「純 origin」形狀的字串：有路徑、有查詢字串、不是 http(s) 的一律拒絕。
export function isSafeOrigin(value) {
  if (typeof value !== 'string' || !value) return false
  try {
    const u = new URL(value)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    return u.origin === value
  } catch {
    return false
  }
}

/**
 * message 事件 → 這份內容該不該收。
 * 來源 origin 不符、型別不對、形狀不對，一律回 null（呼叫端直接忽略）。
 */
export function readPreviewMessage(event, parentOrigin) {
  if (!isSafeOrigin(parentOrigin)) return null
  if (!event || event.origin !== parentOrigin) return null
  const data = event.data
  if (!data || typeof data !== 'object') return null
  if (data.type !== PREVIEW_CONTENT) return null
  if (!data.content || typeof data.content !== 'object') return null
  return data.content
}
