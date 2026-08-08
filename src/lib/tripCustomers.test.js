import { describe, it, expect } from 'vitest'
import { buildCustomerSummaries, sortCustomers } from './tripCustomers'

// 成本都寫死在 productMap，測的是聚合不是成本軸
const ctx = {
  productMap: {
    1: { id: 1, cost: 100, currency: 'TWD' },
    2: { id: 2, cost: 300, currency: 'TWD' },
  },
  variantMap: {},
  rateMap: {},
  historicalEmails: new Set(['old@example.test']),
}

function order(over = {}) {
  return {
    id: 'o1',
    created_at: '2026-07-02T10:00:00+08:00',
    email: 'new@example.test',
    customer_name: '測試客甲',
    items_json: [{ id: 1, name: 'A 商品', qty: 2, price: 250 }],
    discount_amount: 0,
    shipping_fee: 60,
    shipping_cost: 60,
    total_amount: 560,
    paid_amount: 560,
    ...over,
  }
}

describe('buildCustomerSummaries 基本聚合', () => {
  it('利潤 = 商品毛利 + 運費淨額', () => {
    // 淨營收 500、成本 200 → 毛利 300；運費 60 收 60 付 → 淨額 0
    const [c] = buildCustomerSummaries([order()], ctx)
    expect(c.profit).toBe(300)
    expect(c.paidTotal).toBe(560)
    expect(c.orderCount).toBe(1)
  })

  it('免運單的運費是店家倒貼，要吃掉利潤', () => {
    const [c] = buildCustomerSummaries([order({ shipping_fee: 0, shipping_cost: 60, total_amount: 500 })], ctx)
    expect(c.profit).toBe(240) // 300 − 60
  })

  it('物流成本不明時運費淨額算 0，並計入 unknownShippingCount', () => {
    const [c] = buildCustomerSummaries([order({ shipping_cost: null })], ctx)
    expect(c.profit).toBe(300) // 不能變成 360
    expect(c.unknownShippingCount).toBe(1)
  })

  it('客戶利潤等於旗下各單利潤相加', () => {
    const orders = [
      order({ id: 'o1' }),
      order({ id: 'o2', shipping_fee: 0, shipping_cost: 60, total_amount: 500 }),
    ]
    const [c] = buildCustomerSummaries(orders, ctx)
    expect(c.profit).toBe(c.orders.reduce((s, o) => s + o.profit, 0))
    expect(c.profit).toBe(540)
  })
})

describe('buildCustomerSummaries 分組與時間', () => {
  it('同一 email 的多張單合併，記錄首末下單時間', () => {
    const orders = [
      order({ id: 'o1', created_at: '2026-07-02T10:00:00+08:00' }),
      order({ id: 'o2', created_at: '2026-07-04T10:00:00+08:00' }),
    ]
    const [c] = buildCustomerSummaries(orders, ctx)
    expect(c.orderCount).toBe(2)
    expect(c.firstOrderAt).toBe('2026-07-02T10:00:00+08:00')
    expect(c.lastOrderAt).toBe('2026-07-04T10:00:00+08:00')
  })

  it('客戶旗下訂單由新到舊排序', () => {
    const orders = [
      order({ id: 'old', created_at: '2026-07-02T10:00:00+08:00' }),
      order({ id: 'new', created_at: '2026-07-04T10:00:00+08:00' }),
    ]
    const [c] = buildCustomerSummaries(orders, ctx)
    expect(c.orders.map(o => o.id)).toEqual(['new', 'old'])
  })

  it('沒有 email 就用姓名當 key，兩者都沒有就跳過', () => {
    const orders = [
      order({ id: 'a', email: null, customer_name: '無信箱客' }),
      order({ id: 'b', email: null, customer_name: null }),
    ]
    const list = buildCustomerSummaries(orders, ctx)
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('無信箱客')
  })

  it('新客判定看行程開始前有沒有下過單', () => {
    const orders = [
      order({ id: 'a', email: 'new@example.test' }),
      order({ id: 'b', email: 'old@example.test', customer_name: '回頭客' }),
    ]
    const list = buildCustomerSummaries(orders, ctx)
    expect(list.find(c => c.email === 'new@example.test').isNew).toBe(true)
    expect(list.find(c => c.email === 'old@example.test').isNew).toBe(false)
  })

  it('品項全取消的訂單不產生客戶列', () => {
    const dead = order({ items_json: [{ id: 1, name: 'A 商品', qty: 2, price: 250, status: 'cancelled' }] })
    expect(buildCustomerSummaries([dead], ctx)).toHaveLength(0)
  })
})

describe('buildCustomerSummaries 買了什麼', () => {
  it('跨單合併同一商品的數量與毛利', () => {
    const orders = [
      order({ id: 'o1', items_json: [{ id: 1, name: 'A 商品', qty: 2, price: 250 }] }),
      order({ id: 'o2', items_json: [{ id: 1, name: 'A 商品', qty: 1, price: 250 }] }),
    ]
    const [c] = buildCustomerSummaries(orders, ctx)
    expect(c.products).toHaveLength(1)
    expect(c.products[0].qty).toBe(3)
    expect(c.products[0].netRevenue).toBe(750)
    expect(c.products[0].grossProfit).toBe(450)
  })

  it('同商品不同規格分開列', () => {
    const o = order({
      items_json: [
        { id: 1, name: 'A 商品', variantLabel: 'M', qty: 1, price: 250 },
        { id: 1, name: 'A 商品', variantLabel: 'L', qty: 1, price: 250 },
      ],
      total_amount: 560,
    })
    const [c] = buildCustomerSummaries([o], ctx)
    expect(c.products.map(p => p.variantLabel).sort()).toEqual(['L', 'M'])
  })
})

describe('sortCustomers', () => {
  const list = [
    { key: 'a', paidTotal: 100, profit: 90, lastOrderAt: '2026-07-01T00:00:00+08:00' },
    { key: 'b', paidTotal: 300, profit: 10, lastOrderAt: '2026-07-05T00:00:00+08:00' },
    { key: 'c', paidTotal: 200, profit: 50, lastOrderAt: '2026-07-03T00:00:00+08:00' },
  ]

  it('金額由大到小', () => {
    expect(sortCustomers(list, 'amount').map(c => c.key)).toEqual(['b', 'c', 'a'])
  })
  it('利潤由大到小', () => {
    expect(sortCustomers(list, 'profit').map(c => c.key)).toEqual(['a', 'c', 'b'])
  })
  it('最近下單由新到舊', () => {
    expect(sortCustomers(list, 'recent').map(c => c.key)).toEqual(['b', 'c', 'a'])
  })
  it('不認得的排序鍵退回金額，且不改動原陣列', () => {
    const before = list.map(c => c.key)
    expect(sortCustomers(list, 'nonsense').map(c => c.key)).toEqual(['b', 'c', 'a'])
    expect(list.map(c => c.key)).toEqual(before)
  })
})
