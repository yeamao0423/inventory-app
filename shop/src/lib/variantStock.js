// 規格可選性的判斷。商品詳情頁、編排版商品頁、組合商品頁三處共用 ——
// 兩邊算出不同答案的話，同一件商品會在兩個頁面顯示不同的缺貨規格。
//
// 圖片那一組住在 variantImages.js，這裡只管庫存。
//
// skipStock（skip_stock_check 或收單中）永遠優先於庫存數字：預購商品庫存 0
// 仍然要能選、能買，這是既有規則，不可因為「補正後庫存是 0」而被擋掉。

/** 這件商品在該維度實際用到的值，依 sort_order 排序（消費者看到的 chip 順序）。 */
export function valuesForType(type, variants) {
  const ids = [...new Set((variants || []).map(v => v.options?.[String(type.id)]).filter(Boolean))]
  return ids
    .map(vid => type.variant_option_values?.find(v => v.id === vid))
    .filter(Boolean)
    .sort((a, b) => a.sort_order - b.sort_order)
}

/**
 * 在其他維度維持目前選擇的前提下，這個值還有沒有貨。
 * 對不到任何 variant 也算缺貨 —— 那個組合根本不存在，不該讓人選。
 */
export function isValueSoldOut(variants, selectedOptions, typeId, valueId, skipStock) {
  if (skipStock) return false
  const matching = (variants || []).filter(v => {
    if (v.options?.[String(typeId)] !== valueId) return false
    return Object.entries(selectedOptions || {}).every(([tid, vid]) => {
      if (Number(tid) === typeId) return true
      return v.options?.[tid] === undefined || v.options?.[tid] === vid
    })
  })
  if (matching.length === 0) return true
  return matching.every(v => v.stock <= 0)
}

/**
 * 初始選擇：每個維度挑第一個還有貨的值，全缺貨才退回第一個。
 * 逐維度累積 initial，所以後面的維度會考慮前面已經挑好的值。
 */
export function initialOptions(variants, activeTypes, skipStock) {
  const initial = {}
  ;(activeTypes || []).forEach(type => {
    const values = valuesForType(type, variants)
    const avail = values.find(v => !isValueSoldOut(variants, initial, type.id, v.id, skipStock))
    const pick = avail || values[0]
    if (pick) initial[String(type.id)] = pick.id
  })
  return initial
}
