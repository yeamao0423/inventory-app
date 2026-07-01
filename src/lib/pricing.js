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

// 數字陣列 → 區間字串（min≠max 顯示 A~B，相等顯示單值）。
// opts: { prefix 例 'NT$'、suffix 例 ' VND' }。全空回傳 null。
export function fmtRange(nums, { prefix = '', suffix = '' } = {}) {
  const vals = (nums || []).filter(n => n != null && n !== '' && !Number.isNaN(Number(n))).map(Number)
  if (!vals.length) return null
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  return min === max
    ? `${prefix}${min.toLocaleString()}${suffix}`
    : `${prefix}${min.toLocaleString()}~${max.toLocaleString()}${suffix}`
}

// 毛利率區間 → 顯示字串（單一值不顯示成區間）
export function fmtMarginRate(range) {
  if (!range) return null
  const { min, max } = range
  return min.rate === max.rate ? `${min.rate}%` : `${min.rate}%~${max.rate}%`
}

// 毛利金額區間 → 顯示字串（NT$；單一值不顯示成區間）
export function fmtMarginAmount(range) {
  if (!range) return null
  const { min, max } = range
  return min.amount === max.amount
    ? `NT$${min.amount.toLocaleString()}`
    : `NT$${min.amount.toLocaleString()}~${max.amount.toLocaleString()}`
}

// 特價是否在檔期內（開關＋起訖時間，render 時跟現在時間比對）
function inSaleWindow(sp, now) {
  if (!sp?.on_sale) return false
  if (sp.sale_start && new Date(sp.sale_start) > now) return false
  if (sp.sale_end && new Date(sp.sale_end) < now) return false
  return true
}

// 跨所有規格算出「原價」與「有效價（含特價）」兩組價格陣列。
// 兩層回退與商城 shop/src/lib/salePrice.js#getCardPricing 對齊：
//   原價 = variant_price ?? shop_price
//   特價 = variant.sale_price ?? storefront_products.sale_price（且需在檔期內、低於原價）
// listing 需帶 products.product_variants(variant_price, sale_price)。
// 回傳 { onSale, regulars[], effectives[] }；無規格時視為單一虛擬規格＝商品層價格。
export function getEffectivePrices(listing, now = new Date()) {
  const base = Number(listing?.shop_price) || 0
  const variants = listing?.products?.product_variants || []
  const inWindow = inSaleWindow(listing, now)
  const productSale = listing?.sale_price != null ? Number(listing.sale_price) : null

  const rows = variants.length ? variants : [null]
  const regulars = []
  const effectives = []
  let anySale = false

  for (const v of rows) {
    const reg = v && v.variant_price != null ? Number(v.variant_price) : base
    const candidate = v && v.sale_price != null ? Number(v.sale_price) : productSale
    const on = inWindow && candidate != null && candidate < reg
    if (on) anySale = true
    regulars.push(reg)
    effectives.push(on ? candidate : reg)
  }

  return { onSale: anySale, regulars, effectives }
}

// 逐規格原幣成本（variant_cost ?? products.cost），未換算。順序與 getEffectivePrices 對齊。
// 無規格時視為單一虛擬規格＝商品層成本。回傳陣列（某格缺值為 null）。
export function getRawCosts(listing) {
  const baseCost = listing?.products?.cost
  const variants = listing?.products?.product_variants || []
  const rows = variants.length ? variants : [null]
  return rows.map(v => {
    const c = v && v.variant_cost != null ? v.variant_cost : baseCost
    return c == null || c === '' ? null : Number(c)
  })
}

// 逐規格 TWD 成本（variant_cost ?? products.cost，依 products.currency 換算）。
// 順序與 getEffectivePrices 對齊；某格缺匯率無法換算 → 該格為 null。回傳陣列。
export function getEffectiveCosts(listing, rates = {}) {
  const cur = listing?.products?.currency || 'TWD'
  return getRawCosts(listing).map(c => toTwdCost(c, cur, rates))
}

// 對一組售價算毛利區間。逐價算 calcMargin 後依毛利率取 min/max。
// costTwd 可為單一值（所有規格共用）或陣列（逐規格，與 pricesTwd 對齊）。
// 回傳 { min, max }（各為 { amount, rate }）或 null（無有效價/缺成本）。
export function calcMarginRange(pricesTwd, costTwd) {
  if (!Array.isArray(pricesTwd)) return null
  const costs = Array.isArray(costTwd) ? costTwd : null
  const margins = pricesTwd.map((p, i) => calcMargin(p, costs ? costs[i] : costTwd)).filter(Boolean)
  if (margins.length === 0) return null
  let min = margins[0]
  let max = margins[0]
  for (const m of margins) {
    if (m.rate < min.rate) min = m
    if (m.rate > max.rate) max = m
  }
  return { min, max }
}
