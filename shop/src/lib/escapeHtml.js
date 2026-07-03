// Email／HTML 用：把使用者或 DB 來的文字轉成安全的 HTML 實體，防止 HTML 注入（XSS）。
// 原則：只用於「值／文字」，不要包住我方自己組的 HTML 結構、標籤、URL 或數字。
// 純函式、零依賴。
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
