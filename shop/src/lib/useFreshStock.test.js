import { describe, it, expect } from 'vitest'
import { mergeStock, mergeQuantity } from './useFreshStock'

describe('mergeStock — 用新鮮庫存覆蓋 SSR 快照', () => {
  const variants = [{ id: 1, stock: 5 }, { id: 2, stock: 0 }]

  it('有新值就換掉，沒有的維持原值', () => {
    const out = mergeStock(variants, { variants: { 1: 0 } })
    expect(out).toEqual([{ id: 1, stock: 0 }, { id: 2, stock: 0 }])
  })

  it('新值是 0 也要覆蓋（不能被當成沒有值）', () => {
    expect(mergeStock([{ id: 1, stock: 9 }], { variants: { 1: 0 } })[0].stock).toBe(0)
  })

  it('fresh 是 null / 沒有 variants 時原樣回傳', () => {
    expect(mergeStock(variants, null)).toBe(variants)
    expect(mergeStock(variants, {})).toBe(variants)
  })

  it('不就地改動輸入', () => {
    const src = [{ id: 1, stock: 5 }]
    mergeStock(src, { variants: { 1: 0 } })
    expect(src[0].stock).toBe(5)
  })

  it('variants 是 null 時回空陣列，不丟例外', () => {
    expect(mergeStock(null, { variants: { 1: 0 } })).toEqual([])
  })

  it('保留 variant 上其他欄位（價格、options 不能被 merge 弄丟）', () => {
    const src = [{ id: 1, stock: 5, variant_price: 300, options: { 3: 7 } }]
    expect(mergeStock(src, { variants: { 1: 2 } })[0])
      .toEqual({ id: 1, stock: 2, variant_price: 300, options: { 3: 7 } })
  })
})

describe('mergeQuantity — 沒有規格的商品用 products.quantity', () => {
  it('有新值就用新的，包含 0', () => {
    expect(mergeQuantity(7, 3, { products: { 3: 0 } })).toBe(0)
  })

  it('查不到該商品就沿用原值', () => {
    expect(mergeQuantity(7, 3, { products: { 9: 1 } })).toBe(7)
    expect(mergeQuantity(7, 3, null)).toBe(7)
    expect(mergeQuantity(7, 3, {})).toBe(7)
  })
})
