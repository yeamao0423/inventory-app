import { describe, it, expect } from 'vitest'
import {
  taipeiDayStart, taipeiDayEnd, isActiveItem, itemUnitCost, buildCostSnapshotMap,
  computeOrderFinance, summarizeOrders, computeTripFinance,
} from './orderFinance'

const ctx = {
  productMap: {
    1: { id: 1, cost: 100, currency: 'TWD' },
    2: { id: 2, cost: 1000, currency: 'JPY' },
    3: { id: 3, cost: null, currency: 'TWD' },
    4: { id: 4, cost: 50, currency: 'VND' },
  },
  variantMap: {
    v1: { id: 'v1', variant_cost: 180 },
    v2: { id: 'v2', variant_cost: null },
  },
  rateMap: { JPY: 0.22 },
}

describe('taipei day boundaries', () => {
  it('用 +08:00 而不是 UTC 午夜', () => {
    expect(taipeiDayStart('2026-07-01')).toBe('2026-07-01T00:00:00+08:00')
    expect(taipeiDayEnd('2026-07-05')).toBe('2026-07-05T23:59:59.999+08:00')
  })
  it('轉成 UTC 後正好是台北的整日', () => {
    expect(new Date(taipeiDayStart('2026-07-01')).toISOString()).toBe('2026-06-30T16:00:00.000Z')
  })
})

describe('isActiveItem', () => {
  it('沒有 status 視為 active', () => {
    expect(isActiveItem({})).toBe(true)
    expect(isActiveItem({ status: 'active' })).toBe(true)
    expect(isActiveItem({ status: 'cancelled' })).toBe(false)
  })
})

describe('buildCostSnapshotMap', () => {
  it('依 order_id / item_index 建索引', () => {
    const map = buildCostSnapshotMap([
      { order_id: 7, item_index: 0, unit_cost_twd: '120.00' },
      { order_id: 7, item_index: 2, unit_cost_twd: '80.50' },
      { order_id: 9, item_index: 0, unit_cost_twd: '5' },
    ])
    expect(map).toEqual({ 7: { 0: 120, 2: 80.5 }, 9: { 0: 5 } })
  })
  it('空輸入回空物件', () => {
    expect(buildCostSnapshotMap()).toEqual({})
  })
})

describe('itemUnitCost 成本軸', () => {
  it('快照優先於現值', () => {
    expect(itemUnitCost({ id: 1 }, ctx, 88)).toEqual({ twd: 88, source: 'snapshot' })
  })
  it('快照為 0 或空就回退現值', () => {
    expect(itemUnitCost({ id: 1 }, ctx, 0)).toEqual({ twd: 100, source: 'product' })
    expect(itemUnitCost({ id: 1 }, ctx, null)).toEqual({ twd: 100, source: 'product' })
  })
  it('規格成本覆蓋商品成本', () => {
    expect(itemUnitCost({ id: 1, variantId: 'v1' }, ctx)).toEqual({ twd: 180, source: 'variant' })
  })
  it('規格成本留空就回退商品成本', () => {
    expect(itemUnitCost({ id: 1, variantId: 'v2' }, ctx)).toEqual({ twd: 100, source: 'product' })
  })
  it('外幣用當前匯率換算', () => {
    expect(itemUnitCost({ id: 2 }, ctx)).toEqual({ twd: 220, source: 'product' })
  })
  it('沒設成本 → source null', () => {
    expect(itemUnitCost({ id: 3 }, ctx)).toEqual({ twd: 0, source: null })
    expect(itemUnitCost({ id: 999 }, ctx)).toEqual({ twd: 0, source: null })
  })
  it('缺匯率不當成 0 元進貨，標示為未知', () => {
    expect(itemUnitCost({ id: 4 }, ctx)).toEqual({ twd: 0, source: null })
  })
})

describe('computeOrderFinance', () => {
  const order = {
    total_amount: 1100,     // 1200 商品 + 100 運費 − 200 折扣
    shipping_fee: 100,
    discount_amount: 200,
    paid_amount: 1100,
    items_json: [
      { id: 1, qty: 2, price: 300 },   // 600
      { id: 2, qty: 1, price: 600 },   // 600
    ],
  }

  it('營收不含運費、已扣折扣', () => {
    const f = computeOrderFinance(order, ctx)
    expect(f.grossItemSales).toBe(1200)
    expect(f.discount).toBe(200)
    expect(f.netSales).toBe(1000)
    expect(f.shippingFee).toBe(100)
  })

  it('有收運費且收付相等 → 運費淨損益 0', () => {
    const f = computeOrderFinance({ ...order, shipping_fee: 60, shipping_cost: 60 }, ctx)
    expect(f.shippingNet).toBe(0)
  })

  it('滿額免運 → 運費淨損益為負，等於店家倒貼', () => {
    const f = computeOrderFinance({ ...order, shipping_fee: 0, shipping_cost: 60 }, ctx)
    expect(f.shippingFee).toBe(0)
    expect(f.shippingCost).toBe(60)
    expect(f.shippingNet).toBe(-60)
  })

  it('收的比付的多 → 運費淨損益為正', () => {
    const f = computeOrderFinance({ ...order, shipping_fee: 100, shipping_cost: 60 }, ctx)
    expect(f.shippingNet).toBe(40)
  })

  it('物流成本不明時運費損益歸零，不會把運費當成純收入', () => {
    // 20250058 還沒套用時 shipping_cost 讀不到；當成付 0 元會讓
    // shippingNet = +60 灌進盈餘，比舊版把運費排除還糟
    const f = computeOrderFinance({ ...order, shipping_fee: 60, shipping_cost: null }, ctx)
    expect(f.shippingCost).toBe(0)
    expect(f.shippingNet).toBe(0)
    expect(f.shippingCostKnown).toBe(false)
  })

  it('shipping_cost 是 0（真的免費寄送）跟不明要分得開', () => {
    const f = computeOrderFinance({ ...order, shipping_fee: 60, shipping_cost: 0 }, ctx)
    expect(f.shippingCostKnown).toBe(true)
    expect(f.shippingNet).toBe(60)
  })

  it('淨營收 + 運費 === total_amount', () => {
    const f = computeOrderFinance(order, ctx)
    expect(f.netSales + f.shippingFee).toBe(f.totalAmount)
  })

  it('成本用成本軸換算', () => {
    const f = computeOrderFinance(order, ctx)
    expect(f.cogs).toBe(420) // 100×2 + 220×1
    expect(f.grossProfit).toBe(580)
  })

  it('折扣分攤後品項毛利加總 === 訂單毛利', () => {
    const f = computeOrderFinance(order, ctx)
    const sum = f.lines.reduce((s, l) => s + l.grossProfit, 0)
    expect(Math.round(sum * 100) / 100).toBe(f.grossProfit)
    const sumNet = f.lines.reduce((s, l) => s + l.netRevenue, 0)
    expect(Math.round(sumNet * 100) / 100).toBe(f.netSales)
  })

  it('除不盡的折扣零頭補在最後一列，不會漏錢', () => {
    const odd = {
      total_amount: 200, shipping_fee: 0, discount_amount: 100, paid_amount: 200,
      items_json: [
        { id: 1, qty: 1, price: 100 },
        { id: 1, qty: 1, price: 100 },
        { id: 1, qty: 1, price: 100 },
      ],
    }
    const f = computeOrderFinance(odd, ctx)
    const sum = f.lines.reduce((s, l) => s + l.discount, 0)
    expect(Math.round(sum * 100) / 100).toBe(100)
  })

  it('取消的品項不算營收也不算成本', () => {
    const partial = {
      total_amount: 700, shipping_fee: 100, discount_amount: 0, paid_amount: 700,
      items_json: [
        { id: 1, qty: 2, price: 300 },
        { id: 2, qty: 1, price: 600, status: 'cancelled' },
      ],
    }
    const f = computeOrderFinance(partial, ctx)
    expect(f.grossItemSales).toBe(600)
    expect(f.cogs).toBe(200)
    expect(f.lines).toHaveLength(1)
  })

  it('整張取消：沒出貨，運費的收與付都歸零', () => {
    const voided = {
      total_amount: 0, shipping_fee: 100, shipping_cost: 60, discount_amount: 200, paid_amount: 0,
      items_json: [{ id: 1, qty: 2, price: 300, status: 'cancelled' }],
    }
    const f = computeOrderFinance(voided, ctx)
    expect(f.isVoid).toBe(true)
    expect(f.netSales).toBe(0)
    expect(f.shippingFee).toBe(0)
    expect(f.shippingCost).toBe(0)
    expect(f.shippingNet).toBe(0)
    expect(f.discount).toBe(0)
  })

  it('快照以 items_json 的原始位置對應，取消品項不會讓後面錯位', () => {
    const withCancelled = {
      total_amount: 900, shipping_fee: 0, discount_amount: 0, paid_amount: 900,
      items_json: [
        { id: 1, qty: 1, price: 300, status: 'cancelled' }, // index 0
        { id: 1, qty: 1, price: 300 },                       // index 1
        { id: 2, qty: 1, price: 600 },                       // index 2
      ],
    }
    const snapCtx = { ...ctx, costSnapshots: { 42: { 0: 999, 1: 55, 2: 66 } } }
    const f = computeOrderFinance({ ...withCancelled, id: 42 }, snapCtx)
    expect(f.lines.map(l => l.unitCostTwd)).toEqual([55, 66])
    expect(f.cogs).toBe(121)
  })

  it('快照缺某個 index 時只有那一項回退現值', () => {
    const f = computeOrderFinance(
      { ...order, id: 7 },
      { ...ctx, costSnapshots: { 7: { 0: 10 } } },
    )
    expect(f.lines.map(l => l.unitCostTwd)).toEqual([10, 220])
    expect(f.lines.map(l => l.costSource)).toEqual(['snapshot', 'product'])
  })

  it('未收款與待退款分開計算', () => {
    expect(computeOrderFinance({ ...order, paid_amount: 400 }, ctx).unpaid).toBe(700)
    expect(computeOrderFinance({ ...order, paid_amount: 400 }, ctx).refundDue).toBe(0)
    expect(computeOrderFinance({ ...order, paid_amount: 1500 }, ctx).refundDue).toBe(400)
    expect(computeOrderFinance({ ...order, paid_amount: 1500 }, ctx).unpaid).toBe(0)
  })
})

describe('summarizeOrders', () => {
  const orders = [
    {
      total_amount: 1100, shipping_fee: 100, discount_amount: 200, paid_amount: 1100,
      items_json: [{ id: 1, qty: 2, price: 300 }, { id: 2, qty: 1, price: 600 }],
    },
    {
      total_amount: 400, shipping_fee: 100, discount_amount: 0, paid_amount: 0,
      items_json: [{ id: 3, qty: 1, price: 300 }],
    },
    {
      total_amount: 0, shipping_fee: 100, discount_amount: 0, paid_amount: 0,
      items_json: [{ id: 1, qty: 1, price: 300, status: 'cancelled' }],
    },
  ]

  it('全取消的訂單不計入訂單數與任何金額', () => {
    const s = summarizeOrders(orders, ctx)
    expect(s.orderCount).toBe(2)
    expect(s.shippingFee).toBe(200)
  })

  it('商品毛利加總 === 總毛利', () => {
    const s = summarizeOrders(orders, ctx)
    const sum = s.products.reduce((acc, p) => acc + p.grossProfit, 0)
    expect(Math.round(sum * 100) / 100).toBe(s.grossProfit)
  })

  it('商品淨營收加總 === 總淨營收', () => {
    const s = summarizeOrders(orders, ctx)
    const sum = s.products.reduce((acc, p) => acc + p.netRevenue, 0)
    expect(Math.round(sum * 100) / 100).toBe(s.netSales)
  })

  it('沒成本的商品被數出來', () => {
    const s = summarizeOrders(orders, ctx)
    expect(s.noCostCount).toBe(1)
    expect(s.products.find(p => p.id === 3).hasCost).toBe(false)
  })

  it('未收款彙總', () => {
    expect(summarizeOrders(orders, ctx).unpaid).toBe(400)
  })

  it('毛利率以淨營收為分母', () => {
    const s = summarizeOrders([orders[0]], ctx)
    expect(s.netSales).toBe(1000)
    expect(s.grossMargin).toBeCloseTo(58, 5)
  })
})

describe('運費彙總', () => {
  const orders = [
    { // 有收運費，收付相抵
      total_amount: 660, shipping_fee: 60, shipping_cost: 60, discount_amount: 0, paid_amount: 660,
      items_json: [{ id: 1, qty: 2, price: 300 }],
    },
    { // 滿額免運，店家倒貼 60
      total_amount: 4000, shipping_fee: 0, shipping_cost: 60, discount_amount: 0, paid_amount: 4000,
      items_json: [{ id: 1, qty: 1, price: 4000 }],
    },
    { // 又一張免運
      total_amount: 5000, shipping_fee: 0, shipping_cost: 60, discount_amount: 0, paid_amount: 5000,
      items_json: [{ id: 1, qty: 1, price: 5000 }],
    },
  ]

  it('免運訂單被數出來', () => {
    expect(summarizeOrders(orders, ctx).freeShippingCount).toBe(2)
  })

  it('運費淨損益 = 收 − 付', () => {
    const s = summarizeOrders(orders, ctx)
    expect(s.shippingFee).toBe(60)
    expect(s.shippingCost).toBe(180)
    expect(s.shippingNet).toBe(-120)
  })

  it('全免運的店（門檻 0）每一單都在倒貼', () => {
    const allFree = orders.map(o => ({ ...o, shipping_fee: 0 }))
    const s = summarizeOrders(allFree, ctx)
    expect(s.freeShippingCount).toBe(3)
    expect(s.shippingNet).toBe(-180)
  })

  it('migration 未套用時整批訂單的運費損益都是 0，盈餘不被灌水', () => {
    const noCostCol = orders.map(({ shipping_cost, ...o }) => o)
    const s = summarizeOrders(noCostCol, ctx)
    expect(s.shippingFee).toBe(60)
    expect(s.shippingNet).toBe(0)
    expect(s.unknownShippingCostCount).toBe(3)
  })
})

describe('computeTripFinance', () => {
  const summary = summarizeOrders([{
    total_amount: 1100, shipping_fee: 100, shipping_cost: 100, discount_amount: 200, paid_amount: 1100,
    items_json: [{ id: 1, qty: 2, price: 300 }, { id: 2, qty: 1, price: 600 }],
  }], ctx)

  it('可分配盈餘 = 商品毛利 − 行程費用 + 運費淨損益', () => {
    const t = computeTripFinance(summary, { tripExpense: 300, procurementCost: 1000 })
    expect(t.grossProfit).toBe(580)
    expect(t.shippingNet).toBe(0)
    expect(t.distributable).toBe(280)
  })

  it('免運倒貼會壓低可分配盈餘', () => {
    const freeShip = summarizeOrders([{
      total_amount: 1000, shipping_fee: 0, shipping_cost: 60, discount_amount: 200, paid_amount: 1000,
      items_json: [{ id: 1, qty: 2, price: 300 }, { id: 2, qty: 1, price: 600 }],
    }], ctx)
    const t = computeTripFinance(freeShip, { tripExpense: 300 })
    expect(t.grossProfit).toBe(580)
    expect(t.shippingNet).toBe(-60)
    expect(t.distributable).toBe(220) // 580 − 300 − 60
  })

  it('留存庫存 = 本趟進貨 − 本趟已售成本', () => {
    const t = computeTripFinance(summary, { tripExpense: 0, procurementCost: 1000 })
    expect(t.retainedInventory).toBe(580) // 1000 − 420
  })

  it('賣舊庫存時留存庫存為負', () => {
    const t = computeTripFinance(summary, { tripExpense: 0, procurementCost: 100 })
    expect(t.retainedInventory).toBe(-320)
  })

  it('運費收付相抵時不影響可分配盈餘', () => {
    const t = computeTripFinance(summary, { tripExpense: 0 })
    expect(t.distributable).toBe(t.grossProfit)
    expect(t.shippingFee).toBe(100)
  })
})
