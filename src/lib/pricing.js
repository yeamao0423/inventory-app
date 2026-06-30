// 毛利計算（單一來源）
// 成本以商品自身幣別計、售價一律 TWD；先把成本換算成 TWD 再算毛利與毛利率。
// 兩個頁面（庫存頁/商城頁）共用，避免邏輯重複。

// 成本換算成 TWD。無法換算（缺匯率）回傳 null。
export function toTwdCost(cost, currency, rates = {}) {
  if (cost == null || cost === '') return null
  const c = Number(cost)
  if (Number.isNaN(c)) return null
  const cur = currency || 'TWD'
  if (cur === 'TWD') return c
  const rate = rates[cur]
  if (!rate) return null
  return Math.round(c * rate * 10) / 10
}

// priceTwd 售價(TWD)、costTwd 成本(TWD)。回傳 { amount, rate }（rate 為百分比、一位小數）或 null。
export function calcMargin(priceTwd, costTwd) {
  const p = Number(priceTwd)
  if (!p || costTwd == null) return null
  const amount = Math.round((p - costTwd) * 10) / 10
  const rate = Math.round((amount / p) * 1000) / 10
  return { amount, rate }
}
