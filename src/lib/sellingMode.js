// 銷售模式的單一定義：collection_end 有值 = 限時單；沒有但 skip_stock_check 為真 = 預購單
// （永遠開放、沒有截止時間）；都沒有 = 現貨。三個上架入口（快速/批量/既有商品新增）與商城前台
// 共用同一組判斷，任何一處各自 reimplement 都會漂移。

export function clampStock(stock, skipStockCheck) {
  if (skipStockCheck) return 0
  return Number(stock) || 0
}

export function deriveSellingMode({ collectionEnd, skipStockCheck }) {
  if (collectionEnd) return 'collection'
  if (skipStockCheck) return 'preorder'
  return 'stock'
}
