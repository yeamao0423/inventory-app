// 「商品精選」區塊要顯示哪幾件商品 —— 純函式，沒有任何 I/O。
//
// 刻意獨立成一支：正式渲染在 server 端拿快取過的商品清單來挑（lib/data.js 的 getBlockProducts），
// 後台的即時預覽則在瀏覽器裡拿商品快照挑同一批。兩邊必須挑出一模一樣的東西，
// 所以規則只能有一份 —— 而這支不 import next/*，client component 也載得動。

/**
 * @param products   getProductList 的 storefront_products 陣列（或同形狀的精簡快照）
 * @param categories 該店分類（要有 id / parent_id）
 * @param block      已正規化的 products 區塊
 */
export function pickBlockProducts(products, categories, block) {
  const list = Array.isArray(products) ? products : []
  if (!list.length) return []
  const { mode, productIds, categoryId, limit } = block || {}

  let picked
  if (mode === 'category' && categoryId != null) {
    // 二層分類：選父分類時，子分類的商品也要一起出現（與選單樹的行為一致）
    const childIds = (categories || []).filter(c => c.parent_id === categoryId).map(c => c.id)
    const wanted = new Set([categoryId, ...childIds])
    picked = list.filter(sp => wanted.has(sp.products?.category_id))
  } else {
    // 手動挑選：依店主排的順序輸出，不是依商品建立時間
    const byId = new Map(list.map(sp => [sp.product_id, sp]))
    picked = (productIds || []).map(id => byId.get(id)).filter(Boolean)
  }
  return picked.slice(0, limit)
}
