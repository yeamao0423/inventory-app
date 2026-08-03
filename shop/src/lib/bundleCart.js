// ══════════════════════════════════════════════════════════════
// 組合商品（Bundle）的購物車邏輯 — 純函式，零依賴，可測。
//
// 支點（docs/adr/0004）：**組合不成為訂單品項**。購物車裡放的仍然是各件商品，
// 只是每列多帶一個 bundleId 標記所屬組合。套裝價與各件原價加總的差額，
// 下單時寫進訂單的 discount_amount，出貨／庫存／成本／拆賬一律不受影響。
//
// 唯一的規則：**套裝價只在整套齊全時成立**。消費者在購物車拿掉其中一件，
// 價格就退回各件原價。這裡的函式就是在回答「現在齊不齊」與「差多少」。
//
// 這份計算在結帳時 DB 端還會再做一次（見 20250071 migration）——
// 前端 localStorage 不可信，這裡算的只是「給消費者看的畫面」。
// ══════════════════════════════════════════════════════════════

function num(n) {
  const v = Number(n)
  return Number.isFinite(v) ? v : 0
}

/**
 * 購物車單列的唯一鍵。
 * 掛了組合的列要與同商品的單買列分開 —— 否則兩者會被併成一列，
 * 使用者刪掉「單買的那件」時會連套裝那件一起消失。
 */
export function cartLineKey(item) {
  const base = `${item?.id}-${item?.variantLabel || ''}`
  return item?.bundleId != null && item.bundleId !== '' ? `${base}-b${item.bundleId}` : base
}

/** 購物車裡出現過的組合 id（去重，保持加入順序） */
export function bundleIdsInCart(cart) {
  const seen = []
  ;(Array.isArray(cart) ? cart : []).forEach(i => {
    const id = i?.bundleId
    if (id == null || id === '') return
    if (!seen.includes(id)) seen.push(id)
  })
  return seen
}

/** 該組合在購物車裡的所有列 */
export function bundleLines(cart, bundleId) {
  return (Array.isArray(cart) ? cart : []).filter(i => i?.bundleId === bundleId)
}

/**
 * 單一組合的狀態。
 * bundle: { id, name, bundle_price, productIds: [] }
 *
 * 回傳：
 *   complete         整套齊全（組合裡每件商品都有一列掛在這個組合下）
 *   applies          套裝價成立（齊全且套裝價確實低於原價加總）
 *   missingProductIds 缺哪幾件 —— 畫面要據此說清楚發生了什麼事
 *   originalTotal    基準組（每件各一）的原價加總
 *   payable          這個基準組實際要付的錢
 *   discount         差額（＝寫進 discount_amount 的那筆）
 *   lineTotal        這個組合在購物車佔掉的原價總額（含數量超過一套的部分）
 */
export function evaluateBundle(cart, bundle) {
  const productIds = Array.isArray(bundle?.productIds) ? bundle.productIds : []
  const lines = bundleLines(cart, bundle?.id)

  const missingProductIds = productIds.filter(pid => !lines.some(l => l.id === pid))
  const complete = productIds.length > 0 && missingProductIds.length === 0

  // 基準組原價：組合內每件各一。數量超過一套的部分照原價，不打折 ——
  // 一口價買的是「一套」。同商品意外出現多列時取最低單價（保守，寧可少折）。
  const basisIds = complete ? productIds : productIds.filter(pid => !missingProductIds.includes(pid))
  const originalTotal = basisIds.reduce((sum, pid) => {
    const prices = lines.filter(l => l.id === pid).map(l => num(l.price))
    return sum + (prices.length ? Math.min(...prices) : 0)
  }, 0)

  const bundlePrice = num(bundle?.bundle_price)
  const applies = complete && bundlePrice < originalTotal
  const lineTotal = lines.reduce((s, l) => s + num(l.price) * (num(l.qty) || 1), 0)

  return {
    id: bundle?.id,
    name: bundle?.name || '',
    complete,
    applies,
    missingProductIds,
    originalTotal,
    bundlePrice,
    payable: applies ? bundlePrice : originalTotal,
    discount: applies ? originalTotal - bundlePrice : 0,
    lineTotal,
    lines,
  }
}

/** 所有組合的狀態（只算購物車裡真的有出現的組合定義） */
export function evaluateBundles(cart, bundles) {
  return (Array.isArray(bundles) ? bundles : []).map(b => evaluateBundle(cart, b))
}

/** 購物車小計（一律原價加總，折扣另計，與訂單的「商品總額」口徑一致） */
export function cartSubtotal(cart) {
  return (Array.isArray(cart) ? cart : []).reduce((s, i) => s + num(i?.price) * (num(i?.qty) || 1), 0)
}

/**
 * 購物車總計。
 * subtotal 是原價加總（＝訂單的商品總額），bundleDiscount 是套裝差額
 * （＝訂單的 discount_amount），itemsTotal 是兩者相減後消費者實付的商品金額。
 * 折扣不含運費，也永遠不會超過小計 —— 與 orderFinance.js 的口徑對齊。
 */
export function computeCartTotals(cart, bundles) {
  const subtotal = cartSubtotal(cart)
  const states = evaluateBundles(cart, bundles)
  const raw = states.reduce((s, b) => s + b.discount, 0)
  const bundleDiscount = Math.min(Math.max(raw, 0), subtotal)
  return { subtotal, bundleDiscount, itemsTotal: subtotal - bundleDiscount, bundles: states }
}

/**
 * 落地頁逐件勾選的即時試算。
 * picks: [{ productId, price, included }]
 * 取消勾選任何一件，套裝價就不成立，總價退回其餘商品的原價加總。
 */
export function evaluateSelection(picks, bundlePrice) {
  const all = Array.isArray(picks) ? picks : []
  const included = all.filter(p => p?.included)
  const originalTotal = included.reduce((s, p) => s + num(p?.price), 0)
  const complete = all.length > 0 && included.length === all.length
  const price = num(bundlePrice)
  const applies = complete && price < originalTotal
  return {
    complete,
    applies,
    includedCount: included.length,
    totalCount: all.length,
    originalTotal,
    bundlePrice: price,
    payable: applies ? price : originalTotal,
    discount: applies ? originalTotal - price : 0,
  }
}
