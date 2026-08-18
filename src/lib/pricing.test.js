import { describe, it, expect } from 'vitest'
import { calcInventoryValue, productContributesInventoryValue } from './pricing'

describe('calcInventoryValue', () => {
  it('無規格商品：庫存 × 成本', () => {
    const products = [{ quantity: 10, cost: 100, currency: 'TWD', product_variants: [] }]
    expect(calcInventoryValue(products, {})).toEqual({ totalTwd: 1000, excludedCount: 0 })
  })

  it('有規格商品：逐規格 variant_cost，沒有就退回商品成本', () => {
    const products = [{
      cost: 50, currency: 'TWD',
      product_variants: [
        { stock: 3, variant_cost: 200 },
        { stock: 2, variant_cost: null },
      ],
    }]
    // 3×200 + 2×50 = 700
    expect(calcInventoryValue(products, {})).toEqual({ totalTwd: 700, excludedCount: 0 })
  })

  it('負庫存當 0，不倒扣', () => {
    const products = [{ quantity: -5, cost: 100, currency: 'TWD', product_variants: [] }]
    expect(calcInventoryValue(products, {})).toEqual({ totalTwd: 0, excludedCount: 0 })
  })

  it('缺成本的正庫存商品：不計入總值，但算進 excludedCount', () => {
    const products = [{ quantity: 4, cost: null, currency: 'TWD', product_variants: [] }]
    expect(calcInventoryValue(products, {})).toEqual({ totalTwd: 0, excludedCount: 1 })
  })

  it('缺成本但庫存是 0：不算 excluded（反正沒有庫存可算）', () => {
    const products = [{ quantity: 0, cost: null, currency: 'TWD', product_variants: [] }]
    expect(calcInventoryValue(products, {})).toEqual({ totalTwd: 0, excludedCount: 0 })
  })

  it('跨幣別換算', () => {
    const products = [{ quantity: 10, cost: 100, currency: 'JPY', product_variants: [] }]
    expect(calcInventoryValue(products, { JPY: 0.22 })).toEqual({ totalTwd: 220, excludedCount: 0 })
  })

  it('缺匯率：不計入總值，算進 excludedCount', () => {
    const products = [{ quantity: 10, cost: 100, currency: 'JPY', product_variants: [] }]
    expect(calcInventoryValue(products, {})).toEqual({ totalTwd: 0, excludedCount: 1 })
  })

  it('多商品加總', () => {
    const products = [
      { quantity: 10, cost: 100, currency: 'TWD', product_variants: [] },
      { quantity: 5, cost: 50, currency: 'TWD', product_variants: [] },
    ]
    expect(calcInventoryValue(products, {})).toEqual({ totalTwd: 1250, excludedCount: 0 })
  })
})

describe('productContributesInventoryValue', () => {
  it('庫存 > 0 且成本齊全 → 貢獻', () => {
    const p = { quantity: 3, cost: 100, currency: 'TWD', product_variants: [] }
    expect(productContributesInventoryValue(p, {})).toBe(true)
  })

  it('庫存 = 0 → 不貢獻', () => {
    const p = { quantity: 0, cost: 100, currency: 'TWD', product_variants: [] }
    expect(productContributesInventoryValue(p, {})).toBe(false)
  })

  it('負庫存 → 不貢獻', () => {
    const p = { quantity: -3, cost: 100, currency: 'TWD', product_variants: [] }
    expect(productContributesInventoryValue(p, {})).toBe(false)
  })

  it('庫存 > 0 但缺成本 → 不貢獻（算在 excludedCount，不是這裡）', () => {
    const p = { quantity: 3, cost: null, currency: 'TWD', product_variants: [] }
    expect(productContributesInventoryValue(p, {})).toBe(false)
  })

  it('庫存 > 0 但缺匯率 → 不貢獻', () => {
    const p = { quantity: 3, cost: 100, currency: 'JPY', product_variants: [] }
    expect(productContributesInventoryValue(p, {})).toBe(false)
  })

  it('多規格：至少一個規格貢獻，商品整體就算貢獻', () => {
    const p = {
      cost: 50, currency: 'TWD',
      product_variants: [
        { stock: 0, variant_cost: null },
        { stock: 2, variant_cost: 200 },
      ],
    }
    expect(productContributesInventoryValue(p, {})).toBe(true)
  })

  it('多規格：全部都不貢獻才算不貢獻', () => {
    const p = {
      cost: 50, currency: 'TWD',
      product_variants: [
        { stock: 0, variant_cost: 200 },
        { stock: -1, variant_cost: 200 },
      ],
    }
    expect(productContributesInventoryValue(p, {})).toBe(false)
  })
})
