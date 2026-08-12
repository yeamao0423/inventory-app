// ══════════════════════════════════════════════════════════════
// 訂單財務口徑 — 全站唯一計算來源
//
// 名詞對齊電商標準，畫面上的字要跟這裡的公式一致：
//   商品總額 (Gross Item Sales) = Σ 未取消品項的 售價 × 數量
//   淨營收   (Net Sales)        = 商品總額 − 折扣           ← 不含運費
//   商品成本 (COGS)             = Σ 未取消品項的 進貨成本(TWD) × 數量
//   商品毛利 (Gross Profit)     = 淨營收 − 商品成本
//
// 運費不計入營收與毛利，但**它的損益要算**：
//   運費淨損益 = shipping_fee(向客戶收) − shipping_cost(實際付給物流)
//     有收運費 →  60 − 60 =   0
//     滿額免運 →   0 − 60 = −60   ← 店家實付出去的錢
// 過去把運費當「代收轉付、淨額 0」，那只在有收運費時成立；免運訂單的
// 物流費是實實在在的支出，不扣會讓盈餘虛高、分潤多發。
//
// 毛利口徑與 revenue_report_orders 的 profit 一致（都不含運費），
// 避免同一批訂單在營收報表和行程報告看到兩個不同的利潤。
//
// 折扣按品項營收比例分攤，所以「每個商品的毛利加總」必然等於「總毛利」，
// 客戶自己拿明細加總不會對不上。
//
// 成本軸優先序（越前面越可信）：
//   0. trips.exchange_rates —— 該趟行程自己設的匯率。每趟出國實際換到的
//      價格不一樣，同一件日本貨這趟 0.21、下趟 0.25，老闆要的是「這趟真的
//      花了多少」，所以它蓋過下面所有回退值，含快照。
//      代價要知道：改一次行程匯率，該趟歷史毛利就跟著變，已拆過的帳要
//      作廢重算才對得起來。只有行程報告會帶 tripRateMap，營收報表不帶。
//   1. consumer_order_item_costs —— 下單當下由 DB trigger 凍結的快照，
//      日後改商品成本、改匯率都不會回頭改寫歷史（見 20250057 migration）。
//      刻意存在獨立表而不是 items_json，因為消費者讀得到自己的訂單。
//   2. product_variants.variant_cost —— 規格層成本，可覆蓋商品層
//   3. products.cost
//   2/3 都得用「當前」全域匯率換算，屬於會隨時間漂移的回退值，只有快照
//   上線前的舊訂單、或成本沒填過的商品才會走到。
// ══════════════════════════════════════════════════════════════

// 台北是固定 UTC+8，不用管日光節約
const TAIPEI_OFFSET = '+08:00'

/** 台北時區某日的起點，可直接丟給 PostgREST 的 gte */
export function taipeiDayStart(dateStr) {
  return `${dateStr}T00:00:00${TAIPEI_OFFSET}`
}

/** 台北時區某日的終點，可直接丟給 PostgREST 的 lte */
export function taipeiDayEnd(dateStr) {
  return `${dateStr}T23:59:59.999${TAIPEI_OFFSET}`
}

export function isActiveItem(item) {
  return (item?.status || 'active') !== 'cancelled'
}

export function round2(n) {
  return Math.round(n * 100) / 100
}

/**
 * 從 consumer_order_item_costs 建索引：{ [orderId]: { [itemIndex]: unit_cost_twd } }
 */
export function buildCostSnapshotMap(rows = []) {
  const map = {}
  rows.forEach(r => {
    const oid = String(r.order_id)
    if (!map[oid]) map[oid] = {}
    map[oid][r.item_index] = Number(r.unit_cost_twd)
  })
  return map
}

/**
 * 某幣別該用的匯率：行程匯率 > 全域匯率，TWD 恆為 1。
 * 回 0 代表換不出來（缺匯率），呼叫端要當「未知」處理而不是 0 元。
 *
 * 採購批次成本與代墊返還走這支，訂單商品成本走 itemUnitCost —— 兩邊
 * 「行程匯率優先且需為正數」的規則必須一致，改一邊要記得改另一邊。
 */
export function effectiveRate(currency, { rateMap = {}, tripRateMap = null } = {}) {
  const cur = currency || 'TWD'
  if (cur === 'TWD') return 1
  const trip = Number(tripRateMap?.[cur])
  if (Number.isFinite(trip) && trip > 0) return trip
  const global = Number(rateMap[cur])
  return Number.isFinite(global) && global > 0 ? global : 0
}

/**
 * 單一品項的進貨成本（TWD）。
 * ctx.tripRateMap 有該幣別就用它換算現值（source 'trip'）；
 * 否則 snapshotTwd（來自 consumer_order_item_costs）；再否則全域匯率換算現值。
 * 回傳 { twd, source }；source 為 null 代表這個品項算不出成本，
 * 上層要把它當「未設定成本」示警，而不是當成 0 元進貨。
 */
export function itemUnitCost(item, ctx = {}, snapshotTwd = null) {
  const { productMap = {}, variantMap = {}, rateMap = {}, tripRateMap = null } = ctx

  const variant = item?.variantId != null && item.variantId !== ''
    ? variantMap[String(item.variantId)]
    : null
  const product = productMap[item?.id]

  let raw = null
  let source = null
  if (variant?.variant_cost != null && Number(variant.variant_cost) > 0) {
    raw = Number(variant.variant_cost)
    source = 'variant'
  } else if (product?.cost != null && Number(product.cost) > 0) {
    raw = Number(product.cost)
    source = 'product'
  }

  const currency = product?.currency || 'TWD'

  // 行程匯率最優先，連快照都蓋過去（見檔頭成本軸說明）。
  // 只在算得出原幣成本、且該幣別真的填了正數匯率時生效；
  // 填 0 或留空視為沒設，不能讓成本掉成 0 元。
  if (raw != null && currency !== 'TWD') {
    const tripRate = Number(tripRateMap?.[currency])
    if (Number.isFinite(tripRate) && tripRate > 0) {
      return { twd: raw * tripRate, source: 'trip' }
    }
  }

  const snapshot = Number(snapshotTwd ?? item?.unitCostTwd)
  if (Number.isFinite(snapshot) && snapshot > 0) {
    return { twd: snapshot, source: 'snapshot' }
  }

  if (raw == null) return { twd: 0, source: null }
  if (currency === 'TWD') return { twd: raw, source }

  const rate = Number(rateMap[currency])
  // 缺匯率就算不出成本 —— 當成 0 會讓毛利虛高，寧可標示未知
  if (!rate) return { twd: 0, source: null }
  return { twd: raw * rate, source }
}

/**
 * 單張訂單的財務拆解。折扣分攤到品項，零頭補在最後一列，
 * 保證 Σ lines.netRevenue === netSales、Σ lines.grossProfit === grossProfit。
 */
export function computeOrderFinance(order, ctx = {}) {
  const items = Array.isArray(order?.items_json) ? order.items_json : []
  const snapshots = ctx.costSnapshots?.[String(order?.id)] || {}
  const lines = []
  let grossItemSales = 0
  let cogs = 0

  // 走原始 index，快照表是以 items_json 的位置對應的
  items.forEach((item, index) => {
    if (!isActiveItem(item)) return
    const qty = Number(item.qty) || 1
    const price = Number(item.price) || 0
    const revenue = price * qty
    const { twd, source } = itemUnitCost(item, ctx, snapshots[index])
    const cost = twd * qty
    grossItemSales += revenue
    cogs += cost
    lines.push({
      productId: item.id,
      name: item.name,
      variantLabel: item.variantLabel || '',
      qty,
      price,
      revenue,
      unitCostTwd: twd,
      cost,
      costSource: source,
      hasCost: source != null,
    })
  })

  // 折扣不可能大於商品總額（全取消的訂單 grossItemSales = 0）
  const discount = Math.min(Math.max(Number(order?.discount_amount) || 0, 0), grossItemSales)

  let allocated = 0
  lines.forEach((l, i) => {
    if (i === lines.length - 1) {
      l.discount = round2(discount - allocated)
    } else {
      l.discount = grossItemSales > 0 ? round2(discount * l.revenue / grossItemSales) : 0
      allocated += l.discount
    }
    l.netRevenue = round2(l.revenue - l.discount)
    l.grossProfit = round2(l.netRevenue - l.cost)
  })

  const netSales = round2(grossItemSales - discount)
  // 整張取消的訂單沒出貨，運費的收與付都不發生
  const isVoid = grossItemSales === 0
  const shippingFee = isVoid ? 0 : Number(order?.shipping_fee) || 0

  // shipping_cost 為 null＝這筆訂單還沒有物流成本資料（20250058 尚未套用，
  // 或建單早於該版本）。此時「不知道付了多少」，絕不能當成付了 0 元 ——
  // 那會讓運費變成純收入灌進盈餘，比舊版只把運費排除還糟。
  // 資料不明時退回舊行為：運費收付相抵、淨額 0，不影響盈餘。
  const rawCost = order?.shipping_cost
  const costKnown = rawCost != null && rawCost !== ''
  const shippingCost = isVoid || !costKnown ? 0 : Number(rawCost) || 0
  const shippingNet = isVoid || !costKnown ? 0 : round2(shippingFee - shippingCost)

  const totalAmount = Number(order?.total_amount) || 0
  const paid = Number(order?.paid_amount) || 0

  return {
    lines,
    grossItemSales: round2(grossItemSales),
    discount,
    netSales,
    shippingFee,
    shippingCost,
    // 負數＝這單的運費是店家倒貼（多半是滿額免運）
    shippingNet,
    // false＝物流成本不明，運費損益被當 0 處理，盈餘會偏高
    shippingCostKnown: isVoid || costKnown,
    cogs: round2(cogs),
    grossProfit: round2(netSales - cogs),
    totalAmount,
    paid,
    // 貨賣了錢還沒收 → 這部分營收只是應收帳款
    unpaid: Math.max(0, round2(totalAmount - paid)),
    // 收多了還沒退（多半是退貨/取消後尚未退款）
    refundDue: Math.max(0, round2(paid - totalAmount)),
    isVoid,
  }
}

/**
 * 一批訂單的彙總 + 商品層聚合。
 * products 依毛利由高到低排序，欄位與 computeOrderFinance 的 line 同名。
 */
export function summarizeOrders(orders = [], ctx = {}) {
  const totals = {
    orderCount: 0,
    grossItemSales: 0,
    discount: 0,
    netSales: 0,
    shippingFee: 0,
    shippingCost: 0,
    shippingNet: 0,
    freeShippingCount: 0,
    unknownShippingCostCount: 0,
    cogs: 0,
    grossProfit: 0,
    unpaid: 0,
    refundDue: 0,
  }
  const agg = {}

  orders.forEach(order => {
    const f = computeOrderFinance(order, ctx)
    if (f.isVoid) return // 品項全取消，等於沒這張單
    totals.orderCount += 1
    totals.grossItemSales += f.grossItemSales
    totals.discount += f.discount
    totals.netSales += f.netSales
    totals.shippingFee += f.shippingFee
    totals.shippingCost += f.shippingCost
    totals.shippingNet += f.shippingNet
    // 沒跟客戶收運費、但還是付了物流錢的訂單
    if (f.shippingFee === 0 && f.shippingCost > 0) totals.freeShippingCount += 1
    if (!f.shippingCostKnown) totals.unknownShippingCostCount += 1
    totals.cogs += f.cogs
    totals.grossProfit += f.grossProfit
    totals.unpaid += f.unpaid
    totals.refundDue += f.refundDue

    f.lines.forEach(l => {
      const pid = l.productId
      if (pid == null) return
      if (!agg[pid]) {
        agg[pid] = {
          id: pid,
          name: l.name,
          qty: 0,
          revenue: 0,
          discount: 0,
          netRevenue: 0,
          cost: 0,
          grossProfit: 0,
          hasCost: true,
          costSource: l.costSource,
        }
      }
      const a = agg[pid]
      a.qty += l.qty
      a.revenue += l.revenue
      a.discount += l.discount
      a.netRevenue += l.netRevenue
      a.cost += l.cost
      a.grossProfit += l.grossProfit
      // 同一商品只要有一筆算不出成本，整項就標示成本不完整
      if (!l.hasCost) a.hasCost = false
    })
  })

  Object.keys(totals).forEach(k => { totals[k] = round2(totals[k]) })

  const products = Object.values(agg)
    .map(a => ({
      ...a,
      revenue: round2(a.revenue),
      discount: round2(a.discount),
      netRevenue: round2(a.netRevenue),
      cost: round2(a.cost),
      grossProfit: round2(a.grossProfit),
      margin: a.netRevenue > 0 ? (a.grossProfit / a.netRevenue) * 100 : 0,
    }))
    .sort((a, b) => b.grossProfit - a.grossProfit)

  return {
    ...totals,
    grossMargin: totals.netSales > 0 ? (totals.grossProfit / totals.netSales) * 100 : 0,
    products,
    noCostCount: products.filter(p => !p.hasCost).length,
  }
}

/**
 * 行程層的完整財務。
 *   可分配盈餘 = 商品毛利 − 行程費用 + 運費淨損益
 * 運費淨損益幾乎都是負的（免運訂單），等於從盈餘扣掉倒貼的物流費。
 * 這是拆賬的基準，刻意不叫「淨利」：它還沒扣金流手續費與其他營運費用。
 */
export function computeTripFinance(summary, { tripExpense = 0, procurementCost = 0 } = {}) {
  const distributable = round2(summary.grossProfit - tripExpense + summary.shippingNet)
  return {
    ...summary,
    tripExpense: round2(tripExpense),
    procurementCost: round2(procurementCost),
    distributable,
    distributableMargin: summary.netSales > 0 ? (distributable / summary.netSales) * 100 : 0,
    // 本趟買進但這段期間還沒賣掉的貨，錢已經付出去了但不該算成本
    // 負數代表這趟賣掉的多半是先前批次的舊庫存
    retainedInventory: round2(procurementCost - summary.cogs),
  }
}
