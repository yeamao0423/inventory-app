import { computeOrderFinance, round2 } from './orderFinance'

/**
 * 行程報表的客戶維度聚合。
 *
 * 財務不在這裡算 —— 每張單都丟給 computeOrderFinance，這裡只換一個聚合鍵。
 *
 * 利潤口徑刻意跟報表主數字不同：
 *   報表主數字 grossProfit = 淨營收(不含運費) − 商品成本，運費損益獨立一條，
 *   免運單才不會灌大營收分母。
 *   客戶維度問的是「這個人幫我賺了多少」，他付的運費與我們付的物流費都該算進去，
 *   所以 profit = grossProfit + shippingNet。
 *   兩個數字不會互相加總，看到不一樣不是 bug。
 *
 * shipping_cost 為 null 時 shippingNet 是 0（既有安全語意：成本不明就當收支相抵），
 * 這會讓利潤偏高，所以要把張數記在 unknownShippingCount 讓 UI 標出來。
 */
export function buildCustomerSummaries(orders = [], ctx = {}) {
  const historicalEmails = ctx.historicalEmails || new Set()
  const map = {}

  ;(orders || []).forEach(order => {
    const f = computeOrderFinance(order, ctx)
    if (f.isVoid) return // 品項全取消，等於沒這張單，跟 summarizeOrders 一致

    const key = (order.email || order.customer_name || '').toLowerCase()
    if (!key) return

    if (!map[key]) {
      map[key] = {
        key,
        name: order.customer_name || order.email || '',
        email: order.email || null,
        isNew: true,
        paidTotal: 0,
        profit: 0,
        orderCount: 0,
        firstOrderAt: null,
        lastOrderAt: null,
        unknownShippingCount: 0,
        orders: [],
        productAgg: {},
      }
    }
    const c = map[key]
    const profit = round2(f.grossProfit + f.shippingNet)

    c.paidTotal += f.totalAmount
    c.profit += profit
    c.orderCount += 1
    if (!f.shippingCostKnown) c.unknownShippingCount += 1

    const at = order.created_at || null
    if (at && (!c.firstOrderAt || at < c.firstOrderAt)) c.firstOrderAt = at
    if (at && (!c.lastOrderAt || at > c.lastOrderAt)) c.lastOrderAt = at

    c.orders.push({
      id: order.id,
      createdAt: at,
      paidTotal: f.totalAmount,
      profit,
      lines: f.lines,
    })

    f.lines.forEach(l => {
      // 同商品不同規格要分開列，客人買的是 M 還是 L 是有意義的
      const pk = `${l.productId ?? 'x'}|${l.variantLabel || ''}`
      if (!c.productAgg[pk]) {
        c.productAgg[pk] = {
          key: pk,
          name: l.name,
          variantLabel: l.variantLabel || '',
          qty: 0,
          netRevenue: 0,
          grossProfit: 0,
        }
      }
      const a = c.productAgg[pk]
      a.qty += l.qty
      a.netRevenue += l.netRevenue
      a.grossProfit += l.grossProfit
    })
  })

  return Object.values(map)
    .map(({ productAgg, ...c }) => ({
      ...c,
      paidTotal: round2(c.paidTotal),
      profit: round2(c.profit),
      isNew: !(c.email && historicalEmails.has(c.email.toLowerCase())),
      orders: c.orders.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')),
      products: Object.values(productAgg)
        .map(p => ({
          ...p,
          netRevenue: round2(p.netRevenue),
          grossProfit: round2(p.grossProfit),
        }))
        .sort((a, b) => b.netRevenue - a.netRevenue),
    }))
    .sort((a, b) => b.paidTotal - a.paidTotal)
}

/** 回新陣列，不動原本的（React state 直接餵進來也安全） */
export function sortCustomers(customers = [], sortBy = 'amount') {
  const list = [...(customers || [])]
  if (sortBy === 'profit') return list.sort((a, b) => b.profit - a.profit)
  if (sortBy === 'recent') return list.sort((a, b) => (b.lastOrderAt || '').localeCompare(a.lastOrderAt || ''))
  return list.sort((a, b) => b.paidTotal - a.paidTotal)
}
