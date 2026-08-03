import { describe, it, expect } from 'vitest'
import { pickBlockProducts } from './blockProducts'

const sp = (id, categoryId) => ({ product_id: id, products: { name: `P${id}`, category_id: categoryId } })

const PRODUCTS = [sp(1, 10), sp(2, 11), sp(3, 20), sp(4, null)]
const CATEGORIES = [
  { id: 10, parent_id: null },
  { id: 11, parent_id: 10 },   // 10 的子分類
  { id: 20, parent_id: null },
]

describe('pickBlockProducts', () => {
  it('手動挑選依店主排的順序，不是資料庫順序', () => {
    const out = pickBlockProducts(PRODUCTS, CATEGORIES, { mode: 'manual', productIds: [3, 1], limit: 8 })
    expect(out.map(x => x.product_id)).toEqual([3, 1])
  })

  it('手動挑選會略過已下架／不存在的商品', () => {
    const out = pickBlockProducts(PRODUCTS, CATEGORIES, { mode: 'manual', productIds: [1, 999], limit: 8 })
    expect(out.map(x => x.product_id)).toEqual([1])
  })

  it('選父分類時，子分類的商品也會一起出現', () => {
    const out = pickBlockProducts(PRODUCTS, CATEGORIES, { mode: 'category', categoryId: 10, limit: 8 })
    expect(out.map(x => x.product_id)).toEqual([1, 2])
  })

  it('選子分類時只出現該分類', () => {
    const out = pickBlockProducts(PRODUCTS, CATEGORIES, { mode: 'category', categoryId: 11, limit: 8 })
    expect(out.map(x => x.product_id)).toEqual([2])
  })

  it('limit 會截斷', () => {
    const out = pickBlockProducts(PRODUCTS, CATEGORIES, { mode: 'manual', productIds: [1, 2, 3], limit: 2 })
    expect(out.map(x => x.product_id)).toEqual([1, 2])
  })

  it('分類模式沒選分類時退回手動清單（與正規化後的預設一致）', () => {
    const out = pickBlockProducts(PRODUCTS, CATEGORIES, { mode: 'category', categoryId: null, productIds: [2], limit: 8 })
    expect(out.map(x => x.product_id)).toEqual([2])
  })

  it('沒有商品時回空陣列，不丟例外', () => {
    expect(pickBlockProducts([], CATEGORIES, { mode: 'manual', productIds: [1], limit: 8 })).toEqual([])
    expect(pickBlockProducts(null, null, null)).toEqual([])
  })
})
