// 採購彙整的「要買幾件」。
//
// 下單一律扣庫存（consumer_orders 的 reconcile_stock trigger），所以訂單需求
// 已經反映在庫存數字裡了——負庫存就是欠客人的量。再去掃訂單重算會重複計數。
//
//   待採購 = max(0, −庫存 − 在途量)

export function stockKey(productId, variantId) {
  return `${productId}:${variantId ?? ''}`
}

export function needFor(stock, inTransit) {
  return Math.max(0, -(Number(stock) || 0) - (Number(inTransit) || 0))
}

// batchItems: procurement_items 帶 batch:batch_id(inventory_synced)
// 已入庫的批次不算在途——它的量已經進到庫存數字裡了
export function buildInTransitMap(batchItems) {
  const map = {}
  ;(batchItems || []).forEach(bi => {
    if (bi.batch?.inventory_synced) return
    let qty = 0
    if (bi.status === 'bought' || bi.status === 'partial') qty = bi.actual_qty ?? bi.quantity
    else if (bi.status === 'pending') qty = bi.quantity
    if (!qty || qty <= 0) return
    const key = stockKey(bi.product_id, bi.variant_id)
    map[key] = (map[key] || 0) + qty
  })
  return map
}
