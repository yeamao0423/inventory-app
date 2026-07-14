// 極簡 Markdown → HTML（不引第三方套件）。
// 支援：## / ### 標題、- 清單、--- 分隔線、段落、**粗體**、[文字](網址)。
// 安全：先 escape HTML 再套內聯格式，網址只允許 http(s)/mailto，杜絕 XSS。
// ⚠️ 後台（src/lib）與商城（shop/src/lib）各一份，需同步維護。
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function inline(text) {
  let out = escapeHtml(text)
  // [文字](網址)：僅允許安全協定
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, url) => {
    const safe = /^(https?:\/\/|mailto:)/i.test(url.trim())
    return safe
      ? `<a href="${escapeHtml(url.trim())}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : label
  })
  // **粗體**
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  return out
}

export function renderMarkdown(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n')
  const html = []
  let para = []      // 累積段落行
  let list = []      // 累積清單項

  const flushPara = () => {
    if (para.length) { html.push(`<p>${para.map(inline).join('<br>')}</p>`); para = [] }
  }
  const flushList = () => {
    if (list.length) { html.push(`<ul>${list.map(li => `<li>${inline(li)}</li>`).join('')}</ul>`); list = [] }
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (/^###\s+/.test(line)) { flushPara(); flushList(); html.push(`<h4>${inline(line.replace(/^###\s+/, ''))}</h4>`); continue }
    if (/^##\s+/.test(line))  { flushPara(); flushList(); html.push(`<h3>${inline(line.replace(/^##\s+/, ''))}</h3>`); continue }
    if (/^---+\s*$/.test(line)) { flushPara(); flushList(); html.push('<hr>'); continue }
    if (/^[-*]\s+/.test(line)) { flushPara(); list.push(line.replace(/^[-*]\s+/, '')); continue }
    if (line.trim() === '') { flushPara(); flushList(); continue }
    flushList(); para.push(line)
  }
  flushPara(); flushList()
  return html.join('\n')
}
