import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { SUPPORTED_CURRENCIES } from '../constants/currency'
import { useAuth } from '../hooks/useAuth'
import { fetchStoreMembers } from '../components/ProcurementBatchTab'
import {
  taipeiDayStart, taipeiDayEnd, summarizeOrders, computeTripFinance, buildCostSnapshotMap,
} from '../lib/orderFinance'
import { splitOrdersByTrip } from '../lib/tripScope'

// 三張 slide 共用：手機一次滿版一張、可左右滑；桌機由 .trip-carousel 攤平成三欄
const SLIDE_STYLE = {
  minWidth: '100%',
  flexShrink: 0,
  scrollSnapAlign: 'start',
  boxSizing: 'border-box',
  paddingRight: 20,
}

const FIXED_CATEGORIES = [
  { key: 'flight',    label: '機票' },
  { key: 'hotel',     label: '住宿' },
  { key: 'transport', label: '交通' },
  { key: 'luggage',   label: '行李' },
]

export default function TripsPage() {
  const { profile, storeId } = useAuth()
  const [trips, setTrips] = useState([])
  const [procurementCostByTrip, setProcurementCostByTrip] = useState({})
  const [loading, setLoading] = useState(true)
  const [sheet, setSheet] = useState(null) // null | 'add' | trip obj (for editing)
  const [reportTrip, setReportTrip] = useState(null) // trip obj to show report

  useEffect(() => {
    if (!storeId) return
    fetchTrips()
  }, [storeId])

  async function fetchTrips() {
    setLoading(true)
    const { data } = await supabase
      .from('trips')
      .select('*, trip_expenses(*)')
      .eq('store_id', storeId)
      .order('depart_date', { ascending: false })
    setTrips(data || [])

    const tripIds = (data || []).map(t => t.id)
    if (tripIds.length > 0) {
      const [{ data: batches }, { data: rates }] = await Promise.all([
        supabase.from('procurement_batches')
          .select('trip_id, procurement_items(unit_cost, currency, quantity, actual_qty, status)')
          .eq('store_id', storeId).in('trip_id', tripIds),
        supabase.from('exchange_rates').select('*'),
      ])
      const rateMap = {}
      ;(rates || []).forEach(r => { rateMap[r.currency] = Number(r.rate) })
      const costMap = {}
      ;(batches || []).forEach(batch => {
        const items = batch.procurement_items || []
        const batchCost = items.reduce((s, item) => {
          if (item.status === 'missed') return s
          const qty = item.actual_qty ?? item.quantity
          const cost = (Number(item.unit_cost) || 0) * qty
          const cur = item.currency || 'TWD'
          return s + (cur === 'TWD' ? cost : cost * (rateMap[cur] || 0))
        }, 0)
        costMap[batch.trip_id] = (costMap[batch.trip_id] || 0) + batchCost
      })
      setProcurementCostByTrip(costMap)
    } else {
      setProcurementCostByTrip({})
    }

    setLoading(false)
  }

  if (profile?.role !== 'super_admin') {
    return <div className="page" style={{ padding: 40, textAlign: 'center', color: 'var(--text-3)' }}>無權限</div>
  }

  function totalExpense(trip) {
    return (trip.trip_expenses || []).reduce((s, e) => s + Number(e.amount || 0), 0)
  }

  function formatDate(d) {
    if (!d) return ''
    const date = new Date(d)
    return `${date.getMonth() + 1}/${date.getDate()}`
  }

  // 含頭尾的天數，跟一般人說「去幾天」的算法一致
  function tripDays(trip) {
    if (!trip.depart_date || !trip.return_date) return 0
    const ms = new Date(trip.return_date) - new Date(trip.depart_date)
    return Math.max(1, Math.round(ms / 86400000) + 1)
  }

  async function deleteTrip(id) {
    if (!window.confirm('確定刪除此行程？所有費用紀錄也會一併刪除。')) return
    await supabase.from('trips').delete().eq('id', id)
    fetchTrips()
  }

  // Show report view
  if (reportTrip) {
    return (
      <>
        <TripReport
          trip={reportTrip}
          onBack={() => setReportTrip(null)}
          onEdit={() => { setSheet(reportTrip); }}
          onDelete={(id) => { setReportTrip(null); deleteTrip(id) }}
        />
        {sheet && (
          <TripSheet
            trip={sheet === 'add' ? null : sheet}
            onClose={() => setSheet(null)}
            onSaved={() => { setSheet(null); setReportTrip(null); fetchTrips() }}
            onDelete={(id) => { setSheet(null); setReportTrip(null); deleteTrip(id) }}
          />
        )}
      </>
    )
  }

  return (
    <div className="page">
      <div className="ph">
        <div>
          <div className="ph-title">行程管理</div>
          <div className="ph-sub">{trips.length} 趟行程</div>
        </div>
        <button className="icon-btn" onClick={() => setSheet('add')}>+</button>
      </div>

      {loading ? (
        <div className="muted" style={{ textAlign: 'center', padding: 40 }}>載入中…</div>
      ) : trips.length === 0 ? (
        <div className="muted" style={{ textAlign: 'center', padding: 40 }}>尚無行程，點右上角 + 新增</div>
      ) : (
        <div className="card">
          {trips.map(trip => (
            <div
              key={trip.id}
              className="card-row"
              onClick={() => setReportTrip(trip)}
              style={{ cursor: 'pointer', alignItems: 'flex-start' }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="fw600" style={{ fontSize: 15 }}>{trip.destination}</div>
                <div className="muted fs12 num" style={{ marginTop: 3 }}>
                  {formatDate(trip.depart_date)} – {formatDate(trip.return_date)}
                  <span style={{ margin: '0 5px' }}>·</span>
                  {tripDays(trip)} 天
                </div>
                {trip.note && (
                  <div className="muted fs12" style={{ marginTop: 5 }}>{trip.note}</div>
                )}
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div className="fw600 num" style={{ fontSize: 15 }}>
                  ${totalExpense(trip).toLocaleString()}
                </div>
                <div className="muted" style={{ fontSize: 11, marginTop: 1 }}>行程費用</div>
                {procurementCostByTrip[trip.id] > 0 && (
                  <div className="muted fs12 num" style={{ marginTop: 6 }}>
                    進貨 ${Math.round(procurementCostByTrip[trip.id]).toLocaleString()}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {sheet && (
        <TripSheet
          trip={sheet === 'add' ? null : sheet}
          onClose={() => setSheet(null)}
          onSaved={() => { setSheet(null); fetchTrips() }}
          onDelete={(id) => { setSheet(null); deleteTrip(id) }}
        />
      )}
    </div>
  )
}

// ─── Trip Report Dashboard ──────────────────────────────────────
function TripReport({ trip, onBack, onEdit, onDelete }) {
  const { storeId } = useAuth()
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState(null)
  const [costEdits, setCostEdits] = useState({}) // { productId: { cost, currency } }
  const [savingCost, setSavingCost] = useState(null)
  const [detailSheet, setDetailSheet] = useState(null) // null | 'products' | 'customers'
  const [selectedProduct, setSelectedProduct] = useState(null) // product obj for detail popup
  const [showSettleSheet, setShowSettleSheet] = useState(false)
  const [activeSlide, setActiveSlide] = useState(0)
  const carouselRef = useRef(null)
  const SLIDE_COUNT = 3

  const handleScroll = useCallback(() => {
    const el = carouselRef.current
    if (!el) return
    const idx = Math.round(el.scrollLeft / el.offsetWidth)
    setActiveSlide(idx)
  }, [])

  useEffect(() => {
    if (!storeId) return
    fetchReportData()
  }, [trip.id, storeId])

  async function fetchReportData() {
    setLoading(true)

    // 日界線用台北時區，不能讓 PostgREST 把純日期當成 UTC 午夜
    // （那會固定漏掉出發日早上 8 點前、多算回國隔天早上 8 點前的訂單）
    const rangeStart = taipeiDayStart(trip.depart_date)
    const rangeEnd = taipeiDayEnd(trip.return_date)

    const [{ data: orders }, { data: products }, { data: variants }, { data: spProducts }, { data: rates }, { data: allOrders }, { data: images }, { data: procurementBatches }, { data: settlement }, { data: participants }, members, { data: pinnedOrders, error: pinnedErr }, { data: allTrips }] = await Promise.all([
      supabase.from('consumer_orders').select('*')
        .eq('store_id', storeId)
        .gte('created_at', rangeStart)
        .lte('created_at', rangeEnd)
        .neq('status', '已取消')
        .order('created_at', { ascending: false }),
      supabase.from('products').select('id, name, sku, source, cost, currency').eq('store_id', storeId),
      supabase.from('product_variants').select('id, variant_cost').eq('store_id', storeId),
      supabase.from('storefront_products').select('product_id, shop_price').eq('store_id', storeId),
      supabase.from('exchange_rates').select('*'),
      supabase.from('consumer_orders').select('email, created_at')
        .eq('store_id', storeId)
        .lt('created_at', rangeStart)
        .neq('status', '已取消'),
      supabase.from('product_images').select('product_id, url, sort_order').order('sort_order', { ascending: true }),
      supabase.from('procurement_batches').select('id, status, buyer_id, procurement_items(unit_cost, currency, quantity, actual_qty, status, paid_by)')
        .eq('store_id', storeId).eq('trip_id', trip.id),
      supabase.from('trip_settlements').select('*, trip_settlement_lines(*)')
        .eq('trip_id', trip.id).eq('status', 'active').maybeSingle(),
      supabase.from('trip_participants').select('user_id, share_pct').eq('trip_id', trip.id),
      fetchStoreMembers(storeId),
      // 釘在本趟、但可能落在區間外的訂單。
      // 分兩支查詢而不是用 .or()：時間字串含 + 與 :，塞進 PostgREST 的 or 運算式
      // 要額外跳脫，分開查比較不會出事，反正本來就在 Promise.all 裡平行跑。
      supabase.from('consumer_orders').select('*')
        .eq('store_id', storeId)
        .eq('trip_id', trip.id)
        .neq('status', '已取消'),
      // 顯示「已歸 ⟨destination⟩」用的行程名對照
      supabase.from('trips').select('id, destination').eq('store_id', storeId),
    ])

    const imageMap = {}
    ;(images || []).forEach(img => {
      if (!imageMap[img.product_id]) imageMap[img.product_id] = []
      imageMap[img.product_id].push(img.url)
    })

    // trip_id 欄位還沒套 migration 時這支查詢會 400。此時安靜退回純區間模式，
    // 報表照常出得來，只是不能編輯訂單範圍（跟成本快照的降級策略一致）。
    const tripScopeReady = !pinnedErr

    const byId = new Map()
    ;[...(orders || []), ...(pinnedOrders || [])].forEach(o => byId.set(o.id, o))
    const candidateOrders = [...byId.values()]
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))

    // 一次判定、兩邊共用：財務只吃 included，勾選清單兩組都要畫
    const { included: tripOrders, excluded: excludedOrders } = splitOrdersByTrip(candidateOrders, trip)
    // 勾選清單一列一列查歸屬，用 Set 才不會變成 O(n²)
    const excludedOrderIds = new Set(excludedOrders.map(o => o.id))

    const tripNameById = {}
    ;(allTrips || []).forEach(t => { tripNameById[t.id] = t.destination })
    const historicalEmails = new Set((allOrders || []).map(o => o.email?.toLowerCase()).filter(Boolean))

    const productMap = {}
    ;(products || []).forEach(p => { productMap[p.id] = p })

    const variantMap = {}
    ;(variants || []).forEach(v => { variantMap[String(v.id)] = v })

    const priceMap = {}
    ;(spProducts || []).forEach(sp => { priceMap[sp.product_id] = Number(sp.shop_price) })

    const rateMap = {}
    ;(rates || []).forEach(r => { rateMap[r.currency] = Number(r.rate) })

    const tripExpenseTotal = (trip.trip_expenses || []).reduce((s, e) => s + Number(e.amount || 0), 0)

    // 本趟進貨成本：純呈現用，不併入淨利計算
    const procurementCost = (procurementBatches || []).reduce((sum, batch) => {
      const items = batch.procurement_items || []
      const batchCost = items.reduce((s, item) => {
        if (item.status === 'missed') return s
        const qty = item.actual_qty ?? item.quantity
        const cost = (Number(item.unit_cost) || 0) * qty
        const cur = item.currency || 'TWD'
        return s + (cur === 'TWD' ? cost : cost * (rateMap[cur] || 0))
      }, 0)
      return sum + batchCost
    }, 0)

    // 本趟未結清的代墊：按付款人歸戶（品項有指定付款人就用品項的，否則落回批次預設）
    // 只算真的買到的品項，pending / missed 都還沒付錢出去
    const unsettledBatches = (procurementBatches || []).filter(b => b.status !== 'settled')
    const advanceByPayer = {}
    unsettledBatches.forEach(batch => {
      ;(batch.procurement_items || []).forEach(item => {
        if (item.status === 'pending' || item.status === 'missed') return
        const payerId = item.paid_by || batch.buyer_id
        if (!payerId) return
        const qty = item.actual_qty ?? item.quantity
        const cost = (Number(item.unit_cost) || 0) * qty
        const cur = item.currency || 'TWD'
        advanceByPayer[payerId] = (advanceByPayer[payerId] || 0) + (cur === 'TWD' ? cost : cost * (rateMap[cur] || 0))
      })
    })

    // 墊錢的人不一定還在後台成員名單裡，補查 profile 才不會顯示成「未知」
    const memberList = members || []
    const missingPayerIds = Object.keys(advanceByPayer).filter(id => !memberList.some(m => m.id === id))
    let extraMembers = []
    if (missingPayerIds.length > 0) {
      const { data: extra } = await supabase.from('profiles').select('id, name, email').in('id', missingPayerIds)
      extraMembers = (extra || []).map(p => ({ ...p, role: null }))
    }

    // 成本快照：下單當下凍結的進貨成本，優先於現在的商品設定。
    // 前端部署跟 migration 套用不會同時發生，表還沒建好時（PostgREST 回 404）
    // 就安靜退回用現值算，報告照常出得來，只是成本會隨商品設定漂移。
    const { data: costRows, error: costErr } = tripOrders.length > 0
      ? await supabase.from('consumer_order_item_costs')
          .select('order_id, item_index, unit_cost_twd')
          .in('order_id', tripOrders.map(o => o.id))
      : { data: [], error: null }
    const costSnapshots = buildCostSnapshotMap(costRows || [])
    const snapshotReady = !costErr

    // 財務一律走 orderFinance：淨營收不含運費、折扣分攤到品項，
    // 所以下面商品列表的毛利加總必然等於總毛利
    const finance = computeTripFinance(
      summarizeOrders(tripOrders, { productMap, variantMap, rateMap, costSnapshots }),
      { tripExpense: tripExpenseTotal, procurementCost },
    )

    // 補上展示欄位（財務數字全部來自 finance，這裡只接名稱/圖片/售價）
    const productList = finance.products.map(p => {
      const prod = productMap[p.id]
      return {
        ...p,
        sku: prod?.sku || '',
        source: prod?.source || '',
        currency: prod?.currency || 'TWD',
        unitCost: prod?.cost != null ? Number(prod.cost) : null,
        shopPrice: priceMap[p.id] || null,
        images: imageMap[p.id] || [],
      }
    })

    // Customer insights
    const customerMap = {}
    tripOrders.forEach(order => {
      const key = (order.email || order.customer_name || '').toLowerCase()
      if (!key) return
      if (!customerMap[key]) {
        customerMap[key] = { name: order.customer_name, email: order.email, total: 0, orderCount: 0, isNew: false }
      }
      customerMap[key].total += Number(order.total_amount || 0)
      customerMap[key].orderCount += 1
    })

    const customers = Object.values(customerMap).sort((a, b) => b.total - a.total)
    let newCount = 0, returnCount = 0
    customers.forEach(c => {
      if (c.email && historicalEmails.has(c.email.toLowerCase())) {
        returnCount++
      } else {
        newCount++
        c.isNew = true
      }
    })

    // 客單價是客群指標，看的是客戶實際付了多少（含運費），跟財務口徑分開
    const customerPaidTotal = tripOrders.reduce((s, o) => s + Number(o.total_amount || 0), 0)
    const avgOrderValue = finance.orderCount > 0 ? customerPaidTotal / finance.orderCount : 0

    // finance.products 已經在上面接好展示欄位成為 productList，不再重複帶出去
    const { products: _rawProducts, ...financeTotals } = finance

    setData({
      ...financeTotals,
      snapshotReady,
      orders: tripOrders,
      productList,
      productTypeCount: productList.length,
      customers,
      newCount,
      returnCount,
      avgOrderValue,
      advanceByPayer,
      unsettledBatchCount: unsettledBatches.length,
      members: [...memberList, ...extraMembers],
      participants: participants || [],
      settlement: settlement || null,
      candidateOrders,
      excludedOrders,
      excludedOrderIds,
      tripScopeReady,
      tripNameById,
    })
    setLoading(false)
  }

  async function saveCost(productId) {
    const edit = costEdits[productId]
    if (!edit?.cost) return
    setSavingCost(productId)
    const { error } = await supabase.from('products').update({
      cost: Number(edit.cost),
      currency: edit.currency || 'TWD',
    }).eq('id', productId)
    setSavingCost(null)
    if (error) {
      alert('儲存失敗：' + error.message)
    } else {
      setCostEdits(prev => { const n = { ...prev }; delete n[productId]; return n })
      fetchReportData()
    }
  }

  // 已結算的行程不能改範圍：settle_trip 存的是當下算好的快照，
  // 改了訂單會讓報表跟結算對不起來。要改先作廢結算。
  const scopeLocked = !!data?.settlement

  async function setOrderScope(orderId, include) {
    if (scopeLocked) return
    // 勾回一律釘上 trip_id 而不是還原成 null：使用者親手勾回來的單就該固定住，
    // 之後改行程日期也不會又掉出去。
    const patch = include
      ? { trip_id: trip.id, trip_excluded: false }
      : { trip_id: null, trip_excluded: true }
    const { error } = await supabase.from('consumer_orders').update(patch).eq('id', orderId)
    if (error) {
      alert('更新失敗：' + error.message)
      return
    }
    fetchReportData()
  }

  function formatDate(d) {
    if (!d) return ''
    const date = new Date(d)
    return `${date.getMonth() + 1}/${date.getDate()}`
  }

  return (
    <div className="page">
      {/* Header */}
      <div className="ph">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <button
            onClick={onBack}
            aria-label="返回行程列表"
            style={{
              width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
              background: 'var(--card)', border: '0.5px solid var(--border)',
              fontSize: 15, cursor: 'pointer', color: 'var(--text)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              marginTop: 4,
            }}
          >←</button>
          <div style={{ minWidth: 0 }}>
            <div className="ph-title">{trip.destination}</div>
            <div className="ph-sub num">{formatDate(trip.depart_date)} – {formatDate(trip.return_date)}</div>
          </div>
        </div>
        <button className="chip-btn" onClick={onEdit} style={{ marginTop: 4 }}>編輯</button>
      </div>

      {loading ? (
        <div className="muted" style={{ textAlign: 'center', padding: 40 }}>載入報告中…</div>
      ) : !data ? (
        <div className="muted" style={{ textAlign: 'center', padding: 40 }}>載入失敗</div>
      ) : (
        <>
          {/* ── Missing cost warning ── */}
          {data.noCostCount > 0 && (
            <div className="notice notice-warn">
              {data.noCostCount} 件商品未設定成本，目前以 0 元進貨計算，毛利會被高估。
              可在下方商品列表直接補上。
            </div>
          )}

          {(!data.snapshotReady || data.unknownShippingCostCount > 0) && (
            <div className="notice notice-warn">
              {!data.snapshotReady && (
                <div>
                  成本快照尚未啟用（資料庫還沒套 20250057），目前用商品的現值成本計算，
                  改商品成本或匯率會回頭改動這裡的歷史數字。
                </div>
              )}
              {data.unknownShippingCostCount > 0 && (
                <div style={{ marginTop: !data.snapshotReady ? 8 : 0 }}>
                  {data.unknownShippingCostCount} 張訂單沒有物流成本資料（資料庫還沒套 20250058），
                  運費損益暫時以 0 計算。實際上免運單的物流費是店家自付，補上後盈餘會下降。
                </div>
              )}
            </div>
          )}

          {/* ── Slide Carousel：核心財務／現金與庫存／客群概覽 ── */}
          <div
            ref={carouselRef}
            onScroll={handleScroll}
            className="trip-carousel"
            style={{
              display: 'flex',
              overflowX: 'auto',
              scrollSnapType: 'x mandatory',
              WebkitOverflowScrolling: 'touch',
              scrollbarWidth: 'none',
            }}
          >
            {/* Slide 1: 核心財務 —— 一條由上而下的算式，每一步都看得到怎麼來的 */}
            <div className="trip-slide" style={SLIDE_STYLE}>
              <FinanceWaterfall data={data} />
            </div>

            {/* Slide 2: 現金與庫存 */}
            <div className="trip-slide" style={SLIDE_STYLE}>
              <MetricCard title="現金與庫存">
                <MetricRow
                  label="運費收入"
                  hint={`實付物流 $${Math.round(data.shippingCost).toLocaleString()}`}
                  value={`$${Math.round(data.shippingFee).toLocaleString()}`}
                />
                <MetricRow
                  label="免運倒貼"
                  hint={data.freeShippingCount > 0 ? `${data.freeShippingCount} 張免運單` : '本趟沒有免運單'}
                  value={`− $${Math.abs(Math.round(Math.min(data.shippingNet, 0))).toLocaleString()}`}
                  tone={data.shippingNet < 0 ? 'var(--red)' : undefined}
                />
                <div className="wf-rule" />
                <MetricRow
                  label="尚未收款"
                  hint="營收已認列但錢還沒進來"
                  value={`$${Math.round(data.unpaid).toLocaleString()}`}
                  tone={data.unpaid > 0 ? 'var(--red)' : undefined}
                />
                <MetricRow
                  label="待退客戶"
                  value={`$${Math.round(data.refundDue).toLocaleString()}`}
                />
                <div className="wf-rule" />
                <MetricRow
                  label="本趟進貨"
                  hint="這趟實際買了多少貨"
                  value={`$${Math.round(data.procurementCost).toLocaleString()}`}
                />
                <MetricRow
                  level="sub"
                  label={data.retainedInventory >= 0 ? '本趟留存庫存' : '本趟賣掉的舊庫存'}
                  hint={data.retainedInventory >= 0
                    ? '買了還沒賣掉，錢付了但不計入這趟成本'
                    : '賣的是先前批次進的貨，成本已在當時算過'}
                  value={`$${Math.abs(Math.round(data.retainedInventory)).toLocaleString()}`}
                />
              </MetricCard>
            </div>

            {/* Slide 3: 客群概覽 */}
            <div className="trip-slide" style={SLIDE_STYLE}>
              <MetricCard title="客群概覽">
                <MetricRow label="訂單數" value={data.orderCount} />
                <MetricRow label="商品種類" value={data.productTypeCount} />
                <MetricRow
                  label="平均客單價"
                  hint="客戶實付，含運費"
                  value={`$${Math.round(data.avgOrderValue).toLocaleString()}`}
                />
                <div className="wf-rule" />
                <MetricRow label="新客" value={data.newCount} />
                <MetricRow label="回購客" value={data.returnCount} />
              </MetricCard>
            </div>
          </div>

          {/* Dots indicator */}
          <div className="trip-dots" style={{ display: 'flex', justifyContent: 'center', gap: 6, marginTop: 12 }}>
            {Array.from({ length: SLIDE_COUNT }).map((_, i) => (
              <div key={i} style={{
                width: activeSlide === i ? 18 : 6,
                height: 6,
                borderRadius: 3,
                background: activeSlide === i ? 'var(--text)' : 'var(--border)',
                transition: 'all .2s',
              }} />
            ))}
          </div>

          {/* ── Section: 拆賬 ── */}
          <div className="sec">拆賬</div>
          {data.settlement ? (
            <SettlementResult settlement={data.settlement} data={data} onChanged={fetchReportData} />
          ) : (
            <div className="card" style={{ padding: '14px 16px' }}>
              <div className="row-sb" style={{ marginBottom: 7 }}>
                <span className="muted fs13">可分配盈餘</span>
                <span className="fw600 num fs15" style={{ color: data.distributable >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  ${Math.round(data.distributable).toLocaleString()}
                </span>
              </div>
              <div className="row-sb" style={{ marginBottom: 7 }}>
                <span className="muted fs13">待結清批次</span>
                <span className="fs13 num">{data.unsettledBatchCount} 批</span>
              </div>
              <div className="row-sb" style={{ marginBottom: 14 }}>
                <span className="muted fs13">待還代墊</span>
                <span className="fs13 num">
                  ${Math.round(Object.values(data.advanceByPayer).reduce((s, v) => s + v, 0)).toLocaleString()}
                </span>
              </div>
              <button className="btn" style={{ padding: 12, fontSize: 15 }} onClick={() => setShowSettleSheet(true)}>
                開始拆賬
              </button>
            </div>
          )}

          {/* ── Section 2: Product Performance (top 5) ── */}
          <div className="sec row-sb">
            <span>商品表現</span>
            {data.productList.length > 5 && (
              <button className="link-btn" onClick={() => setDetailSheet('products')}>
                全部 {data.productList.length} 件 →
              </button>
            )}
          </div>
          {data.productList.length === 0 ? (
            <div className="muted fs13">此區間無商品銷售紀錄</div>
          ) : (
            <div>
              {data.productList.slice(0, 5).map((p, i) => (
                <ProductRow key={p.id} p={p} i={i} costEdits={costEdits} setCostEdits={setCostEdits} saveCost={saveCost} savingCost={savingCost} onSelect={setSelectedProduct} />
              ))}
            </div>
          )}

          {/* ── Section 2.5: 本趟訂單範圍 ── */}
          <div className="sec row-sb">
            <span>本趟訂單</span>
            <button className="link-btn" onClick={() => setDetailSheet('orders')}>
              納入 {data.orderCount} 張
              {data.excludedOrders.length > 0 && ` / 排除 ${data.excludedOrders.length} 張`} →
            </button>
          </div>

          {/* ── Section 3: Customer Insights (top 5) ── */}
          {data.customers.length > 0 && (
            <>
              <div className="sec row-sb">
                <span>Top 客戶</span>
                {data.customers.length > 5 && (
                  <button className="link-btn" onClick={() => setDetailSheet('customers')}>
                    全部 {data.customers.length} 位 →
                  </button>
                )}
              </div>
              <div>
                {data.customers.slice(0, 5).map((c, i) => (
                  <CustomerRow key={i} c={c} i={i} />
                ))}
              </div>
            </>
          )}

          {/* ── Section 4: Expense Breakdown ── */}
          <div className="sec">行程費用明細</div>
          <div className="card" style={{ marginBottom: 40 }}>
            {(trip.trip_expenses || []).length === 0 && (
              <div className="card-row muted fs13">尚未登記行程費用</div>
            )}
            {(trip.trip_expenses || []).map((e, i) => (
              <div key={i} className="card-row row-sb">
                <span className="fs13">{e.label}</span>
                <span className="fs13 num">${Number(e.amount).toLocaleString()}</span>
              </div>
            ))}
            <div className="card-row row-sb">
              <span className="fw600 fs13">合計</span>
              <span className="fw600 fs15 num">${Math.round(data.tripExpense).toLocaleString()}</span>
            </div>
          </div>
        </>
      )}

      {/* ── 拆賬 Sheet ── */}
      {showSettleSheet && data && (
        <SettleSheet
          trip={trip}
          data={data}
          onClose={() => setShowSettleSheet(false)}
          onSaved={() => { setShowSettleSheet(false); fetchReportData() }}
        />
      )}

      {/* ── Detail Sheets ── */}
      {detailSheet === 'products' && (
        <div className="sheet-overlay" onClick={e => e.target === e.currentTarget && setDetailSheet(null)}>
          <div className="sheet" style={{ maxHeight: '85dvh' }}>
            <div className="sheet-handle" />
            <div className="row-sb" style={{ marginBottom: 16 }}>
              <div className="sheet-title" style={{ margin: 0 }}>全部商品 ({data.productList.length})</div>
              <button onClick={() => setDetailSheet(null)} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-3)' }}>×</button>
            </div>
            <div style={{ overflowY: 'auto', flex: 1 }}>
              <div>
                {data.productList.map((p, i) => (
                  <ProductRow key={p.id} p={p} i={i} costEdits={costEdits} setCostEdits={setCostEdits} saveCost={saveCost} savingCost={savingCost} onSelect={setSelectedProduct} />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {detailSheet === 'customers' && (
        <div className="sheet-overlay" onClick={e => e.target === e.currentTarget && setDetailSheet(null)}>
          <div className="sheet" style={{ maxHeight: '85dvh' }}>
            <div className="sheet-handle" />
            <div className="row-sb" style={{ marginBottom: 16 }}>
              <div className="sheet-title" style={{ margin: 0 }}>全部客戶 ({data.customers.length})</div>
              <button onClick={() => setDetailSheet(null)} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-3)' }}>×</button>
            </div>
            <div style={{ overflowY: 'auto', flex: 1 }}>
              <div>
                {data.customers.map((c, i) => (
                  <CustomerRow key={i} c={c} i={i} />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {detailSheet === 'orders' && (
        <div className="sheet-overlay" onClick={e => e.target === e.currentTarget && setDetailSheet(null)}>
          <div className="sheet" style={{ maxHeight: '85dvh' }}>
            <div className="sheet-handle" />
            <div className="row-sb" style={{ marginBottom: 8 }}>
              <div className="sheet-title" style={{ margin: 0 }}>
                本趟訂單（納入 {data.orderCount} / 排除 {data.excludedOrders.length}）
              </div>
              <button onClick={() => setDetailSheet(null)} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-3)' }}>×</button>
            </div>

            {!data.tripScopeReady && (
              <div className="notice notice-warn">
                資料庫還沒套 20260808120000，訂單範圍暫時只能靠日期區間，無法手動勾選。
              </div>
            )}
            {scopeLocked && (
              <div className="notice notice-warn">
                本趟已完成拆賬，訂單範圍鎖定。要調整請先作廢拆賬結果。
              </div>
            )}
            {data.tripScopeReady && !scopeLocked && (
              <div className="muted fs13" style={{ marginBottom: 8 }}>
                取消勾選＝這張是常規訂單，不屬於任何行程。若它其實屬於別趟，到那趟的清單勾回來即可。
              </div>
            )}

            <div style={{ overflowY: 'auto', flex: 1 }}>
              {data.candidateOrders.length === 0 ? (
                <div className="muted fs13">此區間無訂單</div>
              ) : (
                data.candidateOrders.map(o => (
                  <OrderScopeRow
                    key={o.id}
                    order={o}
                    included={!data.excludedOrderIds.has(o.id)}
                    otherTripName={
                      o.trip_id != null && String(o.trip_id) !== String(trip.id)
                        ? (data.tripNameById[o.trip_id] || '其他行程')
                        : null
                    }
                    disabled={!data.tripScopeReady || scopeLocked}
                    onToggle={setOrderScope}
                  />
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Product Detail Sheet ── */}
      {selectedProduct && (
        <div className="sheet-overlay" onClick={e => e.target === e.currentTarget && setSelectedProduct(null)}>
          <div className="sheet" style={{ maxHeight: '85dvh' }}>
            <div className="sheet-handle" />
            <div className="row-sb" style={{ marginBottom: 16 }}>
              <div className="sheet-title" style={{ margin: 0 }}>{selectedProduct.name}</div>
              <button onClick={() => setSelectedProduct(null)} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-3)' }}>×</button>
            </div>

            {/* Images */}
            {selectedProduct.images?.length > 0 && (
              <div style={{
                display: 'flex',
                gap: 8,
                overflowX: 'auto',
                marginBottom: 16,
                scrollSnapType: 'x mandatory',
                WebkitOverflowScrolling: 'touch',
                scrollbarWidth: 'none',
              }}>
                {selectedProduct.images.map((url, i) => (
                  <img
                    key={i}
                    src={url}
                    alt=""
                    style={{
                      width: selectedProduct.images.length === 1 ? '100%' : '80%',
                      maxHeight: 250,
                      borderRadius: 10,
                      objectFit: 'cover',
                      flexShrink: 0,
                      scrollSnapAlign: 'start',
                    }}
                  />
                ))}
              </div>
            )}

            {/* Info rows */}
            <div>
              {selectedProduct.sku && <InfoRow label="SKU" value={selectedProduct.sku} />}
              {selectedProduct.source && <InfoRow label="來源" value={selectedProduct.source} />}
              <InfoRow
                label="商品設定成本"
                value={selectedProduct.unitCost != null
                  ? `${selectedProduct.unitCost} ${selectedProduct.currency}`
                  : '未設定'}
              />
              {selectedProduct.shopPrice && (
                <InfoRow label="售價" value={`$${selectedProduct.shopPrice.toLocaleString()}`} />
              )}

              <div className="wf-rule" style={{ margin: '10px 0' }} />

              <InfoRow label="此趟銷量" value={selectedProduct.qty} strong />
              <InfoRow label="商品總額" value={`$${Math.round(selectedProduct.revenue).toLocaleString()}`} strong />
              {selectedProduct.discount > 0 && (
                <InfoRow label="分攤折扣" value={`− $${Math.round(selectedProduct.discount).toLocaleString()}`} strong />
              )}
              <InfoRow label="此趟淨營收" value={`$${Math.round(selectedProduct.netRevenue).toLocaleString()}`} strong />
              <InfoRow label="此趟商品成本" value={`− $${Math.round(selectedProduct.cost).toLocaleString()}`} strong />
              {selectedProduct.hasCost ? (
                <>
                  <InfoRow
                    label="此趟毛利" strong
                    value={`$${Math.round(selectedProduct.grossProfit).toLocaleString()}`}
                    tone={selectedProduct.grossProfit >= 0 ? 'var(--green)' : 'var(--red)'}
                  />
                  <InfoRow
                    label="毛利率" strong
                    value={`${selectedProduct.margin.toFixed(1)}%`}
                    tone={selectedProduct.margin >= 0 ? 'var(--green)' : 'var(--red)'}
                  />
                  <div className="muted" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.6 }}>
                    {selectedProduct.costSource === 'snapshot'
                      ? '成本取自下單當下的快照，日後改成本或匯率不會變動'
                      : '成本取自目前的商品/規格設定，改動會回頭影響這個數字'}
                  </div>
                </>
              ) : (
                <div className="notice notice-warn" style={{ marginTop: 10, marginBottom: 0, fontSize: 12 }}>
                  此商品有品項算不出成本，毛利未列出以免誤導
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── 小元件 ──────────────────────────────────────────────────────
// 三張 slide 共用的一列：左邊標籤（可帶說明），右邊數值。
// level: undefined 一般列｜'sub' 小計｜'total' 結論列
function MetricRow({ label, value, hint, tone, level }) {
  return (
    <div className={`wf-row ${level ? `wf-row--${level}` : ''}`}>
      <div>
        <div className="wf-label">{label}</div>
        {hint && <div className="wf-hint">{hint}</div>}
      </div>
      <div className="wf-val" style={{ color: tone }}>{value}</div>
    </div>
  )
}

// slide 外觀統一：標題 + 一張卡，卡內是等距的 MetricRow
function MetricCard({ title, children, footer }) {
  return (
    <>
      <div className="sec" style={{ marginTop: 0 }}>{title}</div>
      <div className="card wf" style={{ marginBottom: 0 }}>
        {children}
        {footer && <div className="wf-foot">{footer}</div>}
      </div>
    </>
  )
}

function InfoRow({ label, value, tone, strong }) {
  return (
    <div className="row-sb" style={{ padding: '5px 0' }}>
      <span className="muted fs13">{label}</span>
      <span className={`num fs13 ${strong ? 'fw600' : ''}`} style={{ color: tone }}>{value}</span>
    </div>
  )
}

// ─── 核心財務瀑布 ────────────────────────────────────────────────
// 一條由上而下的算式，每個數字都看得到是誰減誰來的。
// 刻意不用「淨利」這個字：這裡只扣到行程費用，金流手續費、寄送成本、
// 廣告與人事都還沒扣，叫淨利會讓人以為是最終落袋的錢。
function FinanceWaterfall({ data }) {
  const money = n => `$${Math.round(n).toLocaleString()}`
  const tone = n => (n >= 0 ? 'var(--green)' : 'var(--red)')

  return (
    <MetricCard
      title="核心財務"
      footer="尚未扣除金流手續費、廣告與人事等營運費用，因此不等於帳面淨利。"
    >
      <MetricRow label="商品總額" hint={`${data.orderCount} 張訂單`} value={money(data.grossItemSales)} />
      {data.discount > 0 && <MetricRow label="折扣" value={`− ${money(data.discount)}`} />}
      <div className="wf-rule" />
      <MetricRow level="sub" label="淨營收" hint="不含運費" value={money(data.netSales)} />
      <MetricRow label="商品成本" value={`− ${money(data.cogs)}`} />
      <div className="wf-rule" />
      <MetricRow
        level="sub"
        label="商品毛利"
        hint={`毛利率 ${data.grossMargin.toFixed(1)}%`}
        value={money(data.grossProfit)}
        tone={tone(data.grossProfit)}
      />
      <MetricRow label="行程費用" hint="機票、住宿、交通、行李" value={`− ${money(data.tripExpense)}`} />
      <MetricRow
        label={data.shippingNet <= 0 ? '運費倒貼' : '運費淨收'}
        hint={`收 ${money(data.shippingFee)}／付 ${money(data.shippingCost)}`}
        value={`${data.shippingNet <= 0 ? '−' : '+'} ${money(Math.abs(data.shippingNet))}`}
      />
      <div className="wf-rule" />
      <MetricRow
        level="total"
        label="可分配盈餘"
        hint={`佔淨營收 ${data.distributableMargin.toFixed(1)}%・拆賬分的就是這筆`}
        value={money(data.distributable)}
        tone={tone(data.distributable)}
      />
    </MetricCard>
  )
}

// ─── 拆賬 ────────────────────────────────────────────────────────

// 參與者平均分配；除不盡的零頭補在最後一位，讓合計剛好 100
function evenSplit(rows) {
  const included = rows.filter(r => r.included)
  if (included.length === 0) return rows.map(r => ({ ...r, share_pct: 0 }))
  const each = Math.floor(100 / included.length * 1000) / 1000
  let assigned = 0
  let seen = 0
  return rows.map(r => {
    if (!r.included) return { ...r, share_pct: 0 }
    seen++
    if (seen === included.length) return { ...r, share_pct: Math.round((100 - assigned) * 1000) / 1000 }
    assigned += each
    return { ...r, share_pct: each }
  })
}

function SettleSheet({ trip, data, onClose, onSaved }) {
  // 拆賬基準是可分配盈餘（毛利 − 行程費用），不是會計上的淨利
  const distributable = Math.round(data.distributable)
  const advance = data.advanceByPayer || {}
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  // 成本沒填完就拆賬會多分錢出去，要老闆明確認知才放行
  const [ackNoCost, setAckNoCost] = useState(false)

  const [rows, setRows] = useState(() => {
    const saved = {}
    ;(data.participants || []).forEach(p => { saved[p.user_id] = Number(p.share_pct) })
    const hasSaved = Object.keys(saved).length > 0
    const base = (data.members || []).map(m => ({
      user_id: m.id,
      name: m.name || m.email || '未命名',
      included: hasSaved ? saved[m.id] !== undefined : true,
      share_pct: hasSaved ? (saved[m.id] ?? 0) : 0,
    }))
    // 沒設定過就預設全員平均，之後可以個別調整
    return hasSaved ? base : evenSplit(base)
  })

  function toggle(userId) {
    setRows(prev => evenSplit(prev.map(r => r.user_id === userId ? { ...r, included: !r.included } : r)))
  }

  function setShare(userId, val) {
    setRows(prev => prev.map(r => r.user_id === userId ? { ...r, share_pct: val } : r))
  }

  // 沒分潤但有代墊的人也要列出來 —— 錢一樣要還他
  const visible = rows.filter(r => r.included || (advance[r.user_id] || 0) > 0)
  const lines = visible.map(r => {
    const pct = r.included ? Number(r.share_pct) || 0 : 0
    const profitShare = distributable > 0 ? Math.round(distributable * pct / 100) : 0
    const reimbursement = Math.round(advance[r.user_id] || 0)
    return {
      user_id: r.user_id,
      user_name: r.name,
      share_pct: pct,
      profit_share: profitShare,
      reimbursement,
      payout: profitShare + reimbursement,
    }
  })

  const totalPct = rows.filter(r => r.included).reduce((s, r) => s + (Number(r.share_pct) || 0), 0)
  const totalPayout = lines.reduce((s, l) => s + l.payout, 0)
  const distributed = lines.reduce((s, l) => s + l.profit_share, 0)
  const storeKeep = distributable - distributed
  const blockedByCost = data.noCostCount > 0 && !ackNoCost

  async function submit() {
    const msg = [
      `本趟可分配盈餘 $${distributable.toLocaleString()}`,
      `共發出 $${totalPayout.toLocaleString()} 給 ${lines.length} 人`,
      `並將 ${data.unsettledBatchCount} 批進貨一次標記已結清`,
      '',
      '確定完成拆賬？',
    ].join('\n')
    if (!window.confirm(msg)) return

    setSaving(true)
    const { error } = await supabase.rpc('settle_trip', {
      p_trip_id: trip.id,
      p_revenue: Math.round(data.netSales),
      p_product_cost: Math.round(data.cogs),
      p_trip_expense: Math.round(data.tripExpense),
      p_net_profit: distributable,
      p_lines: lines,
      p_note: note || null,
    })
    if (error) {
      setSaving(false)
      alert('拆賬失敗：' + error.message)
      return
    }
    // 記住這趟誰參加、比例多少，下次同一趟重算時直接帶回來
    await supabase.from('trip_participants').delete().eq('trip_id', trip.id)
    const included = rows.filter(r => r.included)
    if (included.length > 0) {
      await supabase.from('trip_participants').insert(included.map(r => ({
        trip_id: trip.id,
        user_id: r.user_id,
        share_pct: Number(r.share_pct) || 0,
      })))
    }
    setSaving(false)
    onSaved()
  }

  const calcRow = (label, value, opts = {}) => (
    <div className="row-sb" style={{ padding: '5px 0' }}>
      <span className={opts.strong ? 'fw600 fs13' : 'muted fs13'}>{label}</span>
      <span className={`num ${opts.strong ? 'fw600 fs15' : 'fs13'}`} style={{ color: opts.color }}>{value}</span>
    </div>
  )

  return (
    <div className="sheet-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="sheet" style={{ maxHeight: '90dvh' }}>
        <div className="sheet-handle" />
        <div className="row-sb" style={{ marginBottom: 16 }}>
          <div className="sheet-title" style={{ margin: 0 }}>拆賬 — {trip.destination}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-3)' }}>×</button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1 }}>
          {data.noCostCount > 0 && (
            <div className="notice notice-warn">
              <div style={{ marginBottom: 9 }}>
                有 {data.noCostCount} 件商品沒填成本，目前以 0 元進貨計算，
                可分配盈餘被高估、分出去的錢會比實際賺的多。建議先回報告補完成本再拆。
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600 }}>
                <input
                  type="checkbox"
                  checked={ackNoCost}
                  onChange={e => setAckNoCost(e.target.checked)}
                  style={{ width: 16, height: 16, cursor: 'pointer', flexShrink: 0 }}
                />
                我知道成本不完整，仍要用現在的數字拆賬
              </label>
            </div>
          )}

          {/* 可分配盈餘驗算 */}
          <div className="card" style={{ padding: '12px 16px', marginBottom: 8 }}>
            {calcRow('商品總額', `$${Math.round(data.grossItemSales).toLocaleString()}`)}
            {calcRow('折扣', `− $${Math.round(data.discount).toLocaleString()}`)}
            {calcRow('淨營收', `$${Math.round(data.netSales).toLocaleString()}`, { strong: true })}
            {calcRow('商品成本', `− $${Math.round(data.cogs).toLocaleString()}`)}
            {calcRow('行程費用', `− $${Math.round(data.tripExpense).toLocaleString()}`)}
            {calcRow(
              data.shippingNet <= 0 ? '運費倒貼' : '運費淨收',
              `${data.shippingNet <= 0 ? '−' : '+'} $${Math.abs(Math.round(data.shippingNet)).toLocaleString()}`,
            )}
            <div className="wf-rule" style={{ margin: '6px 0' }} />
            {calcRow('可分配盈餘', `$${distributable.toLocaleString()}`, {
              strong: true, color: distributable >= 0 ? 'var(--green)' : 'var(--red)',
            })}
          </div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 16, lineHeight: 1.6 }}>
            運費收 ${Math.round(data.shippingFee).toLocaleString()}、實付物流 ${Math.round(data.shippingCost).toLocaleString()}
            {data.freeShippingCount > 0 && `（其中 ${data.freeShippingCount} 張免運單沒收運費但仍付了物流費）`}。
            這個數字尚未扣除金流手續費與其他營運費用，不等於帳面淨利。
          </div>

          {distributable < 0 && (
            <div className="notice notice-danger">
              本趟短少 ${Math.abs(distributable).toLocaleString()}，由店家承擔。分潤一律為 0，代墊款照樣全額退還。
            </div>
          )}

          {data.unpaid > 0 && (
            <div className="notice notice-warn">
              本趟還有 ${Math.round(data.unpaid).toLocaleString()} 尚未收款。
              盈餘已把這筆算成營收，但錢還沒進帳，現在拆等於先用店家的現金墊付分潤。
            </div>
          )}

          {/* 參與者與比例 */}
          <div className="sec row-sb" style={{ marginTop: 4 }}>
            <span>工作人員與比例</span>
            <button className="chip-btn" onClick={() => setRows(prev => evenSplit(prev))}>平均分配</button>
          </div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 10, lineHeight: 1.6 }}>
            比例合計目前 {totalPct.toFixed(1)}%，沒分配到的 ${Math.round(Math.max(storeKeep, 0)).toLocaleString()} 由店家保留。
          </div>

          <div style={{ marginBottom: 16 }}>
            {rows.map(r => {
              const adv = Math.round(advance[r.user_id] || 0)
              if (!r.included && adv === 0) return null
              const line = lines.find(l => l.user_id === r.user_id)
              return (
                <div key={r.user_id} className="lrow" style={{ opacity: r.included || adv > 0 ? 1 : 0.5 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <input
                      type="checkbox"
                      checked={r.included}
                      onChange={() => toggle(r.user_id)}
                      style={{ width: 18, height: 18, cursor: 'pointer', flexShrink: 0 }}
                    />
                    <span className="fw600 fs13" style={{ flex: 1, minWidth: 0 }}>{r.name}</span>
                    {r.included && (
                      <>
                        <input
                          type="number"
                          inputMode="decimal"
                          value={r.share_pct}
                          onChange={e => setShare(r.user_id, e.target.value)}
                          style={{
                            width: 68, padding: '6px 8px', borderRadius: 8,
                            border: '0.5px solid var(--border)', fontSize: 13,
                            background: 'var(--bg)', textAlign: 'right', color: 'var(--text)',
                          }}
                        />
                        <span className="muted fs13">%</span>
                      </>
                    )}
                  </div>
                  <div className="lrow-meta" style={{ paddingLeft: 28 }}>
                    <span>分潤 ${(line?.profit_share || 0).toLocaleString()}</span>
                    <span>代墊 ${adv.toLocaleString()}</span>
                    <span className="fw600" style={{ color: 'var(--text)' }}>
                      實拿 ${(line?.payout || 0).toLocaleString()}
                    </span>
                  </div>
                  {!r.included && adv > 0 && (
                    <div className="muted" style={{ fontSize: 11, paddingLeft: 28, marginTop: 5 }}>
                      不參與分潤，只退還代墊
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* 備註 */}
          <input
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="拆賬備註（選填）"
            style={{
              width: '100%', padding: '10px 12px', borderRadius: 10,
              border: '0.5px solid var(--border)', fontSize: 13,
              background: 'var(--bg)', color: 'var(--text)', boxSizing: 'border-box', marginBottom: 16,
            }}
          />
        </div>

        {/* 總計與送出 */}
        <div style={{ borderTop: '0.5px solid var(--border)', paddingTop: 14 }}>
          <div className="row-sb" style={{ marginBottom: 5 }}>
            <span className="fw600 fs15">合計發出</span>
            <span className="fw600 num" style={{ fontSize: 19 }}>${totalPayout.toLocaleString()}</span>
          </div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 12, lineHeight: 1.6 }}>
            分潤 ${distributed.toLocaleString()} ＋ 代墊返還 ${(totalPayout - distributed).toLocaleString()}
            ・送出後會把本趟 {data.unsettledBatchCount} 批進貨一次標記已結清
          </div>
          <button
            className="btn"
            onClick={submit}
            disabled={saving || lines.length === 0 || blockedByCost}
            style={{
              padding: 13, fontSize: 15,
              background: (lines.length === 0 || blockedByCost) ? 'var(--border)' : 'var(--text)',
              color: (lines.length === 0 || blockedByCost) ? 'var(--text-3)' : '#fff',
              cursor: (lines.length === 0 || blockedByCost) ? 'default' : 'pointer',
            }}
          >{saving ? '處理中…' : blockedByCost ? '請先補完成本或勾選上方確認' : '完成拆賬'}</button>
        </div>
      </div>
    </div>
  )
}

function SettlementResult({ settlement, data, onChanged }) {
  const [busy, setBusy] = useState(false)
  const [showDrift, setShowDrift] = useState(false)
  const lines = [...(settlement.trip_settlement_lines || [])].sort((a, b) => b.payout - a.payout)
  const totalPaid = lines.filter(l => l.paid).reduce((s, l) => s + Number(l.payout), 0)

  // 拆賬單存的是當時的快照；報告上方永遠是即時重算。
  // 兩者一旦分岔（補了成本、匯率變動、事後又有訂單或取消），要講清楚是哪裡不同。
  const snap = {
    revenue: Number(settlement.revenue),
    cost: Number(settlement.product_cost),
    expense: Number(settlement.trip_expense),
    profit: Number(settlement.net_profit),
  }
  const now = data ? {
    revenue: Math.round(data.netSales),
    cost: Math.round(data.cogs),
    expense: Math.round(data.tripExpense),
    profit: Math.round(data.distributable),
  } : null
  const drift = now ? now.profit - snap.profit : 0
  const hasDrift = now != null && Math.abs(drift) >= 1

  async function togglePaid(line) {
    setBusy(true)
    await supabase.from('trip_settlement_lines').update({ paid: !line.paid }).eq('id', line.id)
    setBusy(false)
    onChanged()
  }

  async function voidSettlement() {
    if (!window.confirm('作廢這張拆賬單？本趟批次會退回未結清狀態，可以重新拆一次。')) return
    setBusy(true)
    const { error } = await supabase.rpc('void_trip_settlement', { p_settlement_id: settlement.id })
    setBusy(false)
    if (error) { alert('作廢失敗：' + error.message); return }
    onChanged()
  }

  return (
    <div className="card" style={{ padding: 16 }}>
      <div className="row-sb" style={{ marginBottom: 12 }}>
        <span className="muted fs12">
          已於 {new Date(settlement.settled_at).toLocaleDateString('zh-TW')} 完成拆賬
        </span>
        <span className="badge badge-ok">已拆賬</span>
      </div>

      <div className="row-sb" style={{ marginBottom: hasDrift ? 10 : 14 }}>
        <span className="fs13">
          <span className="muted">當時盈餘 </span>
          <span className="fw600 num">${snap.profit.toLocaleString()}</span>
        </span>
        <span className="fs13">
          <span className="muted">合計發出 </span>
          <span className="fw600 num">${Number(settlement.total_payout).toLocaleString()}</span>
        </span>
      </div>

      {hasDrift && (
        <div style={{
          border: '0.5px solid var(--border)', borderRadius: 10,
          padding: '10px 12px', marginBottom: 12, fontSize: 12, color: 'var(--text-2)',
        }}>
          <div className="row-sb" style={{ gap: 10 }}>
            <span style={{ lineHeight: 1.5 }}>
              現在重算是 <strong className="num">${now.profit.toLocaleString()}</strong>，
              比當時{drift > 0 ? '多' : '少'} <span className="num">${Math.abs(drift).toLocaleString()}</span>
            </span>
            <button className="link-btn" style={{ flexShrink: 0 }} onClick={() => setShowDrift(v => !v)}>
              {showDrift ? '收合' : '看差在哪'}
            </button>
          </div>
          {showDrift && (
            <div style={{ marginTop: 10 }}>
              {[
                ['淨營收', snap.revenue, now.revenue],
                ['商品成本', snap.cost, now.cost],
                ['行程費用', snap.expense, now.expense],
              ].map(([label, a, b]) => (
                <div key={label} className="row-sb" style={{ padding: '3px 0' }}>
                  <span className="muted">{label}</span>
                  <span className="num">
                    ${a.toLocaleString()} → ${b.toLocaleString()}
                    {b !== a && <strong>（{b > a ? '+' : ''}{(b - a).toLocaleString()}）</strong>}
                  </span>
                </div>
              ))}
              <div className="muted" style={{ marginTop: 8, lineHeight: 1.6 }}>
                多半是事後補了商品成本、匯率變動，或這段期間又有訂單成立/取消。
                發出去的錢以拆賬當時的快照為準；要照新數字重發，請作廢重算。
              </div>
            </div>
          )}
        </div>
      )}

      <div style={{ marginBottom: 12 }}>
        {lines.map(l => (
          <div key={l.id} className="lrow row-sb" style={{ gap: 10, background: l.paid ? 'var(--bg)' : undefined }}>
            <input
              type="checkbox"
              checked={l.paid}
              disabled={busy}
              onChange={() => togglePaid(l)}
              style={{ width: 18, height: 18, cursor: 'pointer', flexShrink: 0 }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                className="fw600 fs13"
                style={{ textDecoration: l.paid ? 'line-through' : 'none', color: l.paid ? 'var(--text-3)' : 'var(--text)' }}
              >
                {l.user_name || '未知'}
              </div>
              <div className="muted num" style={{ fontSize: 11, marginTop: 3 }}>
                分潤 ${Number(l.profit_share).toLocaleString()}（{Number(l.share_pct)}%）＋ 代墊 ${Number(l.reimbursement).toLocaleString()}
              </div>
            </div>
            <div className="fw600 num fs15">${Number(l.payout).toLocaleString()}</div>
          </div>
        ))}
      </div>

      <div className="row-sb">
        <span className="muted num" style={{ fontSize: 11 }}>
          已付 ${totalPaid.toLocaleString()} / ${Number(settlement.total_payout).toLocaleString()}
        </span>
        <button className="chip-btn" onClick={voidSettlement} disabled={busy} style={{ color: 'var(--red)' }}>
          作廢重算
        </button>
      </div>
      {settlement.note && (
        <div className="muted" style={{ fontSize: 11, marginTop: 10 }}>備註：{settlement.note}</div>
      )}
    </div>
  )
}

// ─── Shared Row Components ──────────────────────────────────────
function ProductRow({ p, i, costEdits, setCostEdits, saveCost, savingCost, onSelect }) {
  return (
    <div className="lrow" onClick={() => onSelect?.(p)} style={{ cursor: onSelect ? 'pointer' : undefined }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {p.images?.[0] ? (
          <img src={p.images[0]} alt="" style={{ width: 36, height: 36, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }} />
        ) : (
          <span className="lrow-rank fs13" style={{ minWidth: 20 }}>{i + 1}</span>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="fw600 fs13" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {p.images?.[0] && <span className="lrow-rank">{i + 1}</span>}
            {p.name}
          </div>
          <div className="lrow-meta">
            <span>{p.qty} 件</span>
            <span>淨營收 ${Math.round(p.netRevenue).toLocaleString()}</span>
            {p.hasCost && (
              <span style={{ color: p.grossProfit >= 0 ? 'var(--green)' : 'var(--red)' }}>
                毛利 ${Math.round(p.grossProfit).toLocaleString()}・{p.margin.toFixed(1)}%
              </span>
            )}
          </div>
        </div>
      </div>
      {!p.hasCost && (
        <div style={{ marginTop: 10, display: 'flex', gap: 6, alignItems: 'center' }} onClick={e => e.stopPropagation()}>
          <select
            value={costEdits[p.id]?.currency || p.currency || 'TWD'}
            onChange={e => setCostEdits(prev => ({
              ...prev,
              [p.id]: { ...prev[p.id], currency: e.target.value, cost: prev[p.id]?.cost || '' }
            }))}
            style={{ padding: '7px 8px', borderRadius: 8, border: '0.5px solid var(--border)', fontSize: 12, background: 'var(--bg)' }}
          >
            {SUPPORTED_CURRENCIES.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <input
            type="number"
            inputMode="decimal"
            placeholder="補上進貨成本"
            value={costEdits[p.id]?.cost || ''}
            onChange={e => setCostEdits(prev => ({
              ...prev,
              [p.id]: { ...prev[p.id], cost: e.target.value, currency: prev[p.id]?.currency || p.currency || 'TWD' }
            }))}
            style={{
              flex: 1, minWidth: 0, padding: '7px 10px', borderRadius: 8,
              border: '0.5px solid var(--amber)', fontSize: 13, background: 'var(--amber-bg)', color: 'var(--text)',
            }}
          />
          <button
            onClick={() => saveCost(p.id)}
            disabled={!costEdits[p.id]?.cost || savingCost === p.id}
            style={{
              padding: '7px 14px', borderRadius: 8, border: 'none', flexShrink: 0,
              background: costEdits[p.id]?.cost ? 'var(--text)' : 'var(--border)',
              color: '#fff', fontSize: 12, fontWeight: 600,
              cursor: costEdits[p.id]?.cost ? 'pointer' : 'default',
            }}
          >
            {savingCost === p.id ? '…' : '儲存'}
          </button>
        </div>
      )}
    </div>
  )
}

// ─── 訂單範圍勾選列 ──────────────────────────────────────────────
function OrderScopeRow({ order, included, otherTripName, disabled, onToggle }) {
  const at = order.created_at ? new Date(order.created_at) : null
  const stamp = at
    ? `${at.getMonth() + 1}/${at.getDate()} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
    : ''
  // 釘在別趟的單只能到那趟操作，這裡不給改，免得兩邊互搶
  const lockedByOther = !!otherTripName

  return (
    <div className="lrow row-sb" style={{ opacity: included ? 1 : 0.5 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, cursor: disabled || lockedByOther ? 'default' : 'pointer' }}>
        <input
          type="checkbox"
          checked={included}
          disabled={disabled || lockedByOther}
          onChange={e => onToggle(order.id, e.target.checked)}
          style={{ flexShrink: 0 }}
        />
        <div style={{ minWidth: 0 }}>
          <div className="fs13" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {order.customer_name || order.email || '（無名）'}
          </div>
          <div className="muted num" style={{ fontSize: 11 }}>
            {stamp}
            {lockedByOther && <span style={{ marginLeft: 6 }}>已歸 {otherTripName}</span>}
          </div>
        </div>
      </label>
      <span className="fw600 fs13 num" style={{ flexShrink: 0 }}>
        ${Number(order.total_amount || 0).toLocaleString()}
      </span>
    </div>
  )
}

function CustomerRow({ c, i }) {
  return (
    <div className="lrow row-sb">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span className="lrow-rank fs13" style={{ minWidth: 16, margin: 0 }}>{i + 1}</span>
        <span className="fs13" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {c.name}
        </span>
        {c.isNew && <span className="badge badge-blue" style={{ flexShrink: 0 }}>新客</span>}
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <span className="fw600 fs13 num">${c.total.toLocaleString()}</span>
        <span className="muted num" style={{ fontSize: 11, marginLeft: 6 }}>{c.orderCount} 單</span>
      </div>
    </div>
  )
}

// ─── Trip Edit Sheet ────────────────────────────────────────────
function TripSheet({ trip, onClose, onSaved, onDelete }) {
  const { storeId } = useAuth()
  const isEdit = !!trip
  const [destination, setDestination] = useState(trip?.destination || '')
  const [departDate, setDepartDate] = useState(trip?.depart_date || '')
  const [returnDate, setReturnDate] = useState(trip?.return_date || '')
  const [note, setNote] = useState(trip?.note || '')
  const [saving, setSaving] = useState(false)

  const initFixed = {}
  FIXED_CATEGORIES.forEach(c => { initFixed[c.key] = '' })
  if (trip?.trip_expenses) {
    trip.trip_expenses.forEach(e => {
      if (e.category !== 'other') {
        initFixed[e.category] = String(e.amount)
      }
    })
  }
  const [fixedAmounts, setFixedAmounts] = useState(initFixed)

  const initOther = trip?.trip_expenses
    ? trip.trip_expenses
        .filter(e => e.category === 'other')
        .map(e => ({ label: e.label, amount: String(e.amount), note: e.note || '' }))
    : []
  const [otherExpenses, setOtherExpenses] = useState(initOther)

  function addOther() {
    setOtherExpenses([...otherExpenses, { label: '', amount: '', note: '' }])
  }

  function updateOther(idx, field, value) {
    const arr = [...otherExpenses]
    arr[idx] = { ...arr[idx], [field]: value }
    setOtherExpenses(arr)
  }

  function removeOther(idx) {
    setOtherExpenses(otherExpenses.filter((_, i) => i !== idx))
  }

  function calcTotal() {
    let total = 0
    Object.values(fixedAmounts).forEach(v => { total += Number(v) || 0 })
    otherExpenses.forEach(e => { total += Number(e.amount) || 0 })
    return total
  }

  async function handleSave() {
    if (!destination.trim() || !departDate || !returnDate) return
    setSaving(true)

    const expenses = []
    FIXED_CATEGORIES.forEach(c => {
      const amt = Number(fixedAmounts[c.key]) || 0
      if (amt > 0) {
        expenses.push({ category: c.key, label: c.label, amount: amt, note: '' })
      }
    })
    otherExpenses.forEach(e => {
      const amt = Number(e.amount) || 0
      if (e.label.trim() && amt > 0) {
        expenses.push({ category: 'other', label: e.label.trim(), amount: amt, note: e.note })
      }
    })

    if (isEdit) {
      await supabase.from('trips').update({
        destination: destination.trim(),
        depart_date: departDate,
        return_date: returnDate,
        note: note.trim() || null,
      }).eq('id', trip.id)

      await supabase.from('trip_expenses').delete().eq('trip_id', trip.id)
      if (expenses.length > 0) {
        await supabase.from('trip_expenses').insert(
          expenses.map(e => ({ ...e, trip_id: trip.id }))
        )
      }
    } else {
      const { data: newTrip, error } = await supabase.from('trips').insert({
        store_id: storeId,
        destination: destination.trim(),
        depart_date: departDate,
        return_date: returnDate,
        note: note.trim() || null,
      }).select().single()

      if (error) {
        alert('建立失敗：' + error.message)
        setSaving(false)
        return
      }

      if (newTrip && expenses.length > 0) {
        const { error: expError } = await supabase.from('trip_expenses').insert(
          expenses.map(e => ({ ...e, trip_id: newTrip.id }))
        )
        if (expError) {
          alert('費用儲存失敗：' + expError.message)
        }
      }
    }

    setSaving(false)
    onSaved()
  }

  const inputStyle = {
    width: '100%',
    padding: '11px 12px',
    borderRadius: 10,
    border: '0.5px solid var(--border)',
    fontSize: 15,
    background: 'var(--bg)',
    color: 'var(--text)',
    boxSizing: 'border-box',
  }

  const labelStyle = {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-2)',
    marginBottom: 5,
  }

  return (
    <div className="sheet-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <div className="sheet-handle" />
        <div className="row-sb" style={{ marginBottom: 20 }}>
          <div className="sheet-title" style={{ margin: 0 }}>{isEdit ? '編輯行程' : '新增行程'}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-3)' }}>×</button>
        </div>

        <div style={{ marginBottom: 16 }}>
          <div style={labelStyle}>目的地</div>
          <input style={inputStyle} placeholder="例：日本東京" value={destination} onChange={e => setDestination(e.target.value)} />
        </div>

        <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
          <div style={{ flex: 1 }}>
            <div style={labelStyle}>出發日</div>
            <input style={inputStyle} type="date" value={departDate} onChange={e => setDepartDate(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={labelStyle}>回程日</div>
            <input style={inputStyle} type="date" value={returnDate} onChange={e => setReturnDate(e.target.value)} />
          </div>
        </div>

        <div style={{ marginBottom: 20 }}>
          <div style={labelStyle}>備註</div>
          <input style={inputStyle} placeholder="選填" value={note} onChange={e => setNote(e.target.value)} />
        </div>

        <div style={{ borderTop: '1px solid var(--border)', marginBottom: 16 }} />

        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>固定費用</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
          {FIXED_CATEGORIES.map(c => (
            <div key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 48, fontSize: 14, fontWeight: 500, flexShrink: 0 }}>{c.label}</div>
              <input
                style={{ ...inputStyle, width: undefined, flex: 1 }}
                type="number"
                inputMode="numeric"
                placeholder="0"
                value={fixedAmounts[c.key]}
                onChange={e => setFixedAmounts({ ...fixedAmounts, [c.key]: e.target.value })}
              />
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>其他支出</div>
          <button
            onClick={addOther}
            style={{
              background: 'none',
              border: '1px dashed var(--border)',
              borderRadius: 6,
              padding: '4px 12px',
              fontSize: 13,
              cursor: 'pointer',
              color: 'var(--text)',
            }}
          >
            + 新增
          </button>
        </div>

        {otherExpenses.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 16 }}>尚無其他支出</div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
          {otherExpenses.map((item, idx) => (
            <div key={idx} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <input
                style={{ ...inputStyle, width: undefined, flex: 1 }}
                placeholder="品項名稱"
                value={item.label}
                onChange={e => updateOther(idx, 'label', e.target.value)}
              />
              <input
                style={{ ...inputStyle, width: 100, flexShrink: 0 }}
                type="number"
                inputMode="numeric"
                placeholder="金額"
                value={item.amount}
                onChange={e => updateOther(idx, 'amount', e.target.value)}
              />
              <button
                onClick={() => removeOther(idx)}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: 18,
                  cursor: 'pointer',
                  color: 'var(--text-3)',
                  padding: '8px 4px',
                  flexShrink: 0,
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <div style={{
          background: 'var(--bg)',
          borderRadius: 10,
          padding: '12px 16px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 20,
        }}>
          <div style={{ fontSize: 14, fontWeight: 500 }}>費用合計</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>
            ${calcTotal().toLocaleString()}
          </div>
        </div>

        <button
          className="btn"
          onClick={handleSave}
          disabled={saving || !destination.trim() || !departDate || !returnDate}
          style={(!destination.trim() || !departDate || !returnDate) ? { opacity: 0.4 } : undefined}
        >
          {saving ? '儲存中…' : isEdit ? '更新行程' : '建立行程'}
        </button>

        {isEdit && (
          <button
            onClick={() => onDelete(trip.id)}
            style={{
              width: '100%',
              padding: 12,
              borderRadius: 10,
              border: 'none',
              background: 'none',
              color: 'var(--red)',
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            刪除行程
          </button>
        )}
      </div>
    </div>
  )
}
