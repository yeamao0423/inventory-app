// 規格對應圖片的純函式。商品詳情頁、編排版商品頁、組合商品頁三處共用。
//
// tag_filter 是每張圖選擇性綁定的規格值（migration 20250033）：
//   null          → 共用圖，任何規格都顯示
//   某維度沒有 key → 該維度不設限
//   {"3":[7,9]}   → 只有第 3 種規格選到 7 或 9 時才顯示
//
// 這三支原本各自散在 ProductDetail.jsx 與 ProductStateProvider.jsx，內容相同。
// 組合商品頁要用第三次，所以收成一份 —— 三份副本必然漂移。
//
// 壞資料是前提不是例外：tag_filter 由店主在後台手動綁，任何形狀都可能出現。
// 這裡的每一支都必須「不丟例外」，看不懂的一律當作不設限。

/** 這張圖在目前選到的規格下該不該顯示。 */
export function imageMatches(img, selectedOptions) {
  const tf = img?.tag_filter
  if (!tf || typeof tf !== 'object') return true
  return Object.entries(tf).every(([typeId, vals]) => {
    if (!Array.isArray(vals) || vals.length === 0) return true
    const sel = selectedOptions?.[typeId]
    return sel == null || vals.map(Number).includes(Number(sel))
  })
}

/** 某規格值的代表圖：images 需已依 sort_order 排序，取第一張綁到該值的圖。 */
export function repImageFor(images, typeId, valueId) {
  return (images || []).find(img => {
    const allowed = img?.tag_filter?.[String(typeId)]
    return Array.isArray(allowed) && allowed.map(Number).includes(Number(valueId))
  }) || null
}

/** 某規格值的代表圖在指定圖片陣列中的 index（通常傳 visibleImages 進來），用來讓 gallery 預覽直接切過去；找不到回 -1。 */
export function indexOfRepImage(images, typeId, valueId) {
  return (images || []).findIndex(img => {
    const allowed = img?.tag_filter?.[String(typeId)]
    return Array.isArray(allowed) && allowed.map(Number).includes(Number(valueId))
  })
}

/**
 * 目前該顯示哪幾張圖。
 * 過濾後為空就退回全部 —— 該規格沒有專屬圖也沒有共用圖時不能開天窗。
 * 這個 fallback 是既有行為（ProductDetail.jsx 原本的第 44 行），拿掉會讓某些商品的圖庫整個消失。
 */
export function visibleImages(sortedImages, selectedOptions) {
  const all = sortedImages || []
  const matched = all.filter(img => imageMatches(img, selectedOptions))
  return matched.length ? matched : all
}
