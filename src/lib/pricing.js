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

// 對一組售價算毛利區間。逐價算 calcMargin 後依毛利率取 min/max。
// 回傳 { min, max }（各為 { amount, rate }）或 null（無有效價/缺成本）。
export function calcMarginRange(pricesTwd, costTwd) {
  if (!Array.isArray(pricesTwd) || costTwd == null) return null
  const margins = pricesTwd.map(p => calcMargin(p, costTwd)).filter(Boolean)
  if (margins.length === 0) return null
  let min = margins[0]
  let max = margins[0]
  for (const m of margins) {
    if (m.rate < min.rate) min = m
    if (m.rate > max.rate) max = m
  }
  return { min, max }
}
