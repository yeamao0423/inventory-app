// 後台 ↔ 即時預覽 iframe 的訊息協定。純函式，沒有 DOM 依賴，方便測。
//
// 流程：iframe 掛好 listener 後主動送 ready → 後台收到才推第一份內容
//（不先握手的話，iframe 還在載入時後台推出去的第一份會被丟掉，預覽會停在空白）。
// 之後後台單向推內容；只有「編輯模式下點到某個區塊」時 iframe 才回話（PREVIEW_SELECT）。
//
// ⚠️ 後台端有一份對應的常數（src/components/LivePreview.jsx），兩邊要一起改。
// 字串刻意帶前綴：同一個 window 上還有 Next.js HMR、瀏覽器擴充套件在丟 message。

export const PREVIEW_READY = 'daigogo:preview-ready'
export const PREVIEW_CONTENT = 'daigogo:preview-content'
// 編輯模式：點預覽裡的區塊 → 後台把左側面板切到那一塊的設定
export const PREVIEW_SELECT = 'daigogo:preview-select'
// 滑鼠移過後台的區塊清單 → 預覽把對應區塊框起來。
// 刻意獨立成一則輕訊息而不是跟著 content 一起重推：hover 一秒可以觸發幾十次，
// 每次都重推整份 blocks 等於讓 iframe 把版面重畫幾十遍。
export const PREVIEW_HIGHLIGHT = 'daigogo:preview-highlight'

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

// 來源 origin 不符、事件形狀不對就不是我們的訊息。兩支 read* 共用這道門。
function readEnvelope(event, parentOrigin, type) {
  if (!isSafeOrigin(parentOrigin)) return null
  if (!event || event.origin !== parentOrigin) return null
  const data = event.data
  if (!data || typeof data !== 'object') return null
  if (data.type !== type) return null
  return data
}

/**
 * message 事件 → 這則推送該不該收，收下之後是什麼。
 * 一律回 null（呼叫端直接忽略）或 { content, editing, selectedId }。
 *
 * editing 與 selectedId 刻意放在**訊息頂層**而不是塞進 content：
 * content 會走 normalizeContent 的白名單正規化，多出來的欄位一定會被剝掉。
 * 兩者是「怎麼看這份內容」而不是內容本身，本來就不該混在一起。
 */
export function readPreviewMessage(event, parentOrigin) {
  const data = readEnvelope(event, parentOrigin, PREVIEW_CONTENT)
  if (!data) return null
  if (!data.content || typeof data.content !== 'object') return null
  return {
    content: data.content,
    editing: !!data.editing,
    selectedId: typeof data.selectedId === 'string' ? data.selectedId : null,
  }
}

/**
 * hover 高亮訊息 → 要框起來的 blockId（沒有就是 null，代表取消框選）。
 * 回傳 undefined 表示「這不是高亮訊息」，呼叫端才分得出「沒收到」與「收到 null」。
 */
export function readHighlightMessage(event, parentOrigin) {
  const data = readEnvelope(event, parentOrigin, PREVIEW_HIGHLIGHT)
  if (!data) return undefined
  return typeof data.blockId === 'string' ? data.blockId : null
}
