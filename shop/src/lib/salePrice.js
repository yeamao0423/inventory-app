// 特價判斷（兩層回退：規格特價 ?? 全品特價）
//
// 價格兩個獨立的軸：
//   原價 = variant_price ?? shop_price
//   特價 = variant.sale_price ?? storefront_products.sale_price
// 開關與檔期在商品層共用：on_sale / sale_start / sale_end。
//
// 「是否在檔期內」於 render 時跟現在時間比對，即使資料被 SSR 快取，
// 起訖切換時間仍會準。

function inSaleWindow(sp, now) {
  if (!sp?.on_sale) return false
  if (sp.sale_start && new Date(sp.sale_start) > now) return false
  if (sp.sale_end && new Date(sp.sale_end) < now) return false
  return true
}

// 單一規格／單價的特價判斷（詳情頁用）
// regularPrice: 該情境原價；variantSalePrice: 該規格的 sale_price（沒有就傳 null）
// 回傳 { onSale, price, original }
export function getActivePrice(sp, regularPrice, variantSalePrice = null, now = new Date()) {
  const reg = Number(regularPrice) || 0
  const candidate =
    variantSalePrice != null
      ? Number(variantSalePrice)
      : sp?.sale_price != null
        ? Number(sp.sale_price)
        : null
  const active = inSaleWindow(sp, now) && candidate != null && candidate < reg // 特價需低於原價
  return active
    ? { onSale: true, price: candidate, original: reg }
    : { onSale: false, price: reg, original: reg }
}

// 列表卡片用：跨所有規格算出原價區間與特價（有效價）區間
// 需要 sp.products.product_variants 帶有 variant_price / sale_price
// 回傳 { onSale, regularMin, regularMax, saleMin, saleMax }
export function getCardPricing(sp, now = new Date()) {
  const base = Number(sp?.shop_price) || 0
  const variants = sp?.products?.product_variants || []
  const inWindow = inSaleWindow(sp, now)
  const productSale = sp?.sale_price != null ? Number(sp.sale_price) : null

  // 沒有規格時，視為單一「虛擬規格」＝商品層價格
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

  return {
    onSale: anySale,
    regularMin: Math.min(...regulars),
    regularMax: Math.max(...regulars),
    saleMin: Math.min(...effectives),
    saleMax: Math.max(...effectives),
  }
}
