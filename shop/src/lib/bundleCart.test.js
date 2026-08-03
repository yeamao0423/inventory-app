import { describe, it, expect } from 'vitest'
import {
  cartLineKey,
  bundleIdsInCart,
  evaluateBundle,
  evaluateBundles,
  computeCartTotals,
  evaluateSelection,
} from './bundleCart'

// 三件商品的組合：原價加總 3000，套裝價 2500
const BUNDLE = { id: 7, name: '春季外出三件組', bundle_price: 2500, productIds: [1, 2, 3] }

function line(id, price, extra = {}) {
  return { id, name: `商品${id}`, price, qty: 1, variantLabel: '', ...extra }
}

const fullCart = [
  line(1, 1000, { bundleId: 7 }),
  line(2, 1200, { bundleId: 7 }),
  line(3, 800, { bundleId: 7 }),
]

describe('cartLineKey', () => {
  it('同商品同規格但屬於不同組合時，是兩列不同的項目', () => {
    expect(cartLineKey(line(1, 100, { bundleId: 7 })))
      .not.toBe(cartLineKey(line(1, 100, { bundleId: 8 })))
  })

  it('沒掛組合的項目沿用「id-規格」舊格式，既有購物車不會失憶', () => {
    expect(cartLineKey({ id: 5, variantLabel: 'M / 黑' })).toBe('5-M / 黑')
    expect(cartLineKey({ id: 5 })).toBe('5-')
  })

  it('套裝列與單買列不會被合併成同一列', () => {
    expect(cartLineKey(line(1, 100, { bundleId: 7 }))).not.toBe(cartLineKey(line(1, 100)))
  })
})

describe('bundleIdsInCart', () => {
  it('只列出真的有掛組合的項目，且不重複', () => {
    expect(bundleIdsInCart([...fullCart, line(9, 500)])).toEqual([7])
  })

  it('空購物車回空陣列', () => {
    expect(bundleIdsInCart([])).toEqual([])
    expect(bundleIdsInCart(null)).toEqual([])
  })
})

describe('evaluateBundle', () => {
  it('整套齊全 → 套裝價成立，折扣為原價加總與套裝價的差額', () => {
    const r = evaluateBundle(fullCart, BUNDLE)
    expect(r.complete).toBe(true)
    expect(r.applies).toBe(true)
    expect(r.originalTotal).toBe(3000)
    expect(r.discount).toBe(500)
    expect(r.payable).toBe(2500)
    expect(r.missingProductIds).toEqual([])
  })

  it('刪掉其中一件 → 套裝價失效，其餘以原價購買', () => {
    const r = evaluateBundle(fullCart.filter(i => i.id !== 2), BUNDLE)
    expect(r.complete).toBe(false)
    expect(r.applies).toBe(false)
    expect(r.discount).toBe(0)
    expect(r.originalTotal).toBe(1800)
    expect(r.payable).toBe(1800)
    expect(r.missingProductIds).toEqual([2])
  })

  it('缺件時列出所有缺的商品，讓畫面說得清楚少了什麼', () => {
    const r = evaluateBundle([fullCart[0]], BUNDLE)
    expect(r.missingProductIds).toEqual([2, 3])
  })

  it('同商品另外單買（沒掛組合）不算數，套裝仍視為缺件', () => {
    const cart = [fullCart[0], fullCart[1], line(3, 800)] // 第三件沒掛 bundleId
    expect(evaluateBundle(cart, BUNDLE).complete).toBe(false)
  })

  it('數量超過一套的部分照原價，不進套裝折扣', () => {
    const cart = [
      line(1, 1000, { bundleId: 7, qty: 2 }),
      line(2, 1200, { bundleId: 7 }),
      line(3, 800, { bundleId: 7 }),
    ]
    const r = evaluateBundle(cart, BUNDLE)
    // 基準組（每件各一）＝3000，折 500；多的那件 1000 元照原價
    expect(r.originalTotal).toBe(3000)
    expect(r.discount).toBe(500)
    expect(r.lineTotal).toBe(4000)
  })

  it('套裝價不低於原價加總時不打折（店家設錯價也不會倒貼）', () => {
    const r = evaluateBundle(fullCart, { ...BUNDLE, bundle_price: 3200 })
    expect(r.complete).toBe(true)
    expect(r.applies).toBe(false)
    expect(r.discount).toBe(0)
    expect(r.payable).toBe(3000)
  })

  it('同商品在同一組合意外出現兩列時取較低單價（寧可少折）', () => {
    const cart = [
      line(1, 1000, { bundleId: 7 }),
      { ...line(1, 900, { bundleId: 7 }), variantLabel: 'L' },
      line(2, 1200, { bundleId: 7 }),
      line(3, 800, { bundleId: 7 }),
    ]
    expect(evaluateBundle(cart, BUNDLE).originalTotal).toBe(2900)
  })

  it('組合沒有任何商品時不成立', () => {
    expect(evaluateBundle(fullCart, { ...BUNDLE, productIds: [] }).applies).toBe(false)
  })
})

describe('evaluateBundles / computeCartTotals', () => {
  const B8 = { id: 8, name: '配件二件組', bundle_price: 400, productIds: [4, 5] }
  const twoBundleCart = [
    ...fullCart,
    line(4, 300, { bundleId: 8 }),
    line(5, 250, { bundleId: 8 }),
    line(9, 999), // 單買
  ]

  it('多個組合各自獨立成立，折扣相加', () => {
    const results = evaluateBundles(twoBundleCart, [BUNDLE, B8])
    expect(results.map(r => r.discount)).toEqual([500, 150])
  })

  it('小計為原價加總，總折扣為各組合差額之和', () => {
    const t = computeCartTotals(twoBundleCart, [BUNDLE, B8])
    expect(t.subtotal).toBe(3000 + 550 + 999)
    expect(t.bundleDiscount).toBe(650)
    expect(t.itemsTotal).toBe(t.subtotal - 650)
  })

  it('其中一個組合被拆散，只有它失去套裝價', () => {
    const t = computeCartTotals(twoBundleCart.filter(i => i.id !== 5), [BUNDLE, B8])
    expect(t.bundleDiscount).toBe(500)
  })

  it('購物車裡的組合已下架（查不到定義）→ 一律原價，不當機', () => {
    const t = computeCartTotals(fullCart, [])
    expect(t.bundleDiscount).toBe(0)
    expect(t.itemsTotal).toBe(3000)
  })

  it('折扣不會超過小計', () => {
    const t = computeCartTotals(fullCart, [{ ...BUNDLE, bundle_price: -1000 }])
    expect(t.bundleDiscount).toBe(3000)
    expect(t.itemsTotal).toBe(0)
  })
})

describe('evaluateSelection（落地頁逐件勾選）', () => {
  const picks = [
    { productId: 1, price: 1000, included: true },
    { productId: 2, price: 1200, included: true },
    { productId: 3, price: 800, included: true },
  ]

  it('全部勾選 → 套裝價', () => {
    const r = evaluateSelection(picks, 2500)
    expect(r.applies).toBe(true)
    expect(r.payable).toBe(2500)
    expect(r.originalTotal).toBe(3000)
    expect(r.discount).toBe(500)
  })

  it('取消勾選一件 → 總價退回其餘商品的原價加總，並標示不適用套裝價', () => {
    const r = evaluateSelection(picks.map(p => p.productId === 2 ? { ...p, included: false } : p), 2500)
    expect(r.applies).toBe(false)
    expect(r.payable).toBe(1800)
    expect(r.discount).toBe(0)
  })

  it('全部取消勾選 → 0 元、不成立', () => {
    const r = evaluateSelection(picks.map(p => ({ ...p, included: false })), 2500)
    expect(r.applies).toBe(false)
    expect(r.payable).toBe(0)
    expect(r.includedCount).toBe(0)
  })
})
