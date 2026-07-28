// datetime-local input 與 ISO 字串的互轉。
// datetime-local 只吃「本地時間、無時區」的 YYYY-MM-DDTHH:mm，
// 而 DB 存的是 timestamptz，兩邊必須明確轉換，不能直接塞 ISO 字串。

export function utcToLocal(isoStr) {
  if (!isoStr) return ''
  const d = new Date(isoStr)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function localToISO(localStr) {
  if (!localStr) return null
  return new Date(localStr).toISOString()
}
