import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'

const FIXED_CATEGORIES = [
  { key: 'flight',    label: '機票' },
  { key: 'hotel',     label: '住宿' },
  { key: 'transport', label: '交通' },
  { key: 'luggage',   label: '行李' },
]

export default function TripsPage() {
  const { profile, storeId } = useAuth()
  const [trips, setTrips] = useState([])
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
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-3)' }}>載入中…</div>
      ) : trips.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-3)' }}>尚無行程，點右上角 + 新增</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {trips.map(trip => (
            <div
              key={trip.id}
              onClick={() => setReportTrip(trip)}
              style={{
                background: 'var(--card)',
                borderRadius: 12,
                padding: 16,
                cursor: 'pointer',
                border: '1px solid var(--border)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 4 }}>{trip.destination}</div>
                  <div style={{ fontSize: 13, color: 'var(--text-3)' }}>
                    {formatDate(trip.depart_date)} — {formatDate(trip.return_date)}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--text)' }}>
                    ${totalExpense(trip).toLocaleString()}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-3)' }}>總費用</div>
                </div>
              </div>
              {trip.note && (
                <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 8 }}>{trip.note}</div>
              )}
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

    const [{ data: orders }, { data: products }, { data: spProducts }, { data: rates }, { data: allOrders }, { data: images }] = await Promise.all([
      supabase.from('consumer_orders').select('*')
        .eq('store_id', storeId)
        .gte('created_at', trip.depart_date)
        .lte('created_at', trip.return_date + 'T23:59:59')
        .neq('status', '已取消')
        .order('created_at', { ascending: false }),
      supabase.from('products').select('id, name, sku, source, cost, currency').eq('store_id', storeId),
      supabase.from('storefront_products').select('product_id, shop_price').eq('store_id', storeId),
      supabase.from('exchange_rates').select('*').eq('store_id', storeId),
      supabase.from('consumer_orders').select('email, created_at')
        .eq('store_id', storeId)
        .lt('created_at', trip.depart_date)
        .neq('status', '已取消'),
      supabase.from('product_images').select('product_id, url, sort_order').order('sort_order', { ascending: true }),
    ])

    const imageMap = {}
    ;(images || []).forEach(img => {
      if (!imageMap[img.product_id]) imageMap[img.product_id] = []
      imageMap[img.product_id].push(img.url)
    })

    const tripOrders = orders || []
    const historicalEmails = new Set((allOrders || []).map(o => o.email?.toLowerCase()).filter(Boolean))

    const productMap = {}
    ;(products || []).forEach(p => { productMap[p.id] = p })

    const priceMap = {}
    ;(spProducts || []).forEach(sp => { priceMap[sp.product_id] = Number(sp.shop_price) })

    const rateMap = {}
    ;(rates || []).forEach(r => { rateMap[r.currency] = Number(r.rate) })

    const totalRevenue = tripOrders.reduce((s, o) => s + Number(o.total_amount || 0), 0)
    const shippingRevenue = tripOrders.reduce((s, o) => s + Number(o.shipping_fee || 0), 0)
    const tripExpenseTotal = (trip.trip_expenses || []).reduce((s, e) => s + Number(e.amount || 0), 0)

    // Product aggregation
    const productAgg = {}
    tripOrders.forEach(order => {
      const items = Array.isArray(order.items_json) ? order.items_json : []
      items.forEach(item => {
        if (item.status === 'cancelled') return
        const pid = item.id
        if (!pid) return
        const prod = productMap[pid]
        if (!productAgg[pid]) {
          productAgg[pid] = {
            name: item.name,
            sku: prod?.sku || '',
            source: prod?.source || '',
            currency: prod?.currency || 'TWD',
            unitCost: prod?.cost != null ? Number(prod.cost) : null,
            shopPrice: priceMap[pid] || null,
            images: imageMap[pid] || [],
            qty: 0,
            revenue: 0,
            cost: 0,
            hasCost: prod?.cost != null && Number(prod.cost) > 0,
          }
        }
        const qty = Number(item.qty) || 1
        const price = Number(item.price) || (priceMap[pid] || 0)
        productAgg[pid].qty += qty
        productAgg[pid].revenue += price * qty

        if (prod?.cost) {
          let costTWD = Number(prod.cost)
          const cur = prod.currency || 'TWD'
          if (cur !== 'TWD' && rateMap[cur]) {
            costTWD = costTWD * rateMap[cur]
          }
          productAgg[pid].cost += costTWD * qty
        }
      })
    })

    const productList = Object.entries(productAgg)
      .map(([pid, p]) => ({
        id: pid,
        ...p,
        profit: p.revenue - p.cost,
        margin: p.revenue > 0 ? ((p.revenue - p.cost) / p.revenue * 100) : 0,
      }))
      .sort((a, b) => b.profit - a.profit)

    const totalProductCost = productList.reduce((s, p) => s + p.cost, 0)
    const grossProfit = totalRevenue - totalProductCost
    const netProfit = totalRevenue - totalProductCost - tripExpenseTotal
    const netMargin = totalRevenue > 0 ? (netProfit / totalRevenue * 100) : 0
    const noCostCount = productList.filter(p => !p.hasCost).length
    const productTypeCount = productList.length

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

    const avgOrderValue = tripOrders.length > 0 ? totalRevenue / tripOrders.length : 0

    setData({
      orders: tripOrders,
      totalRevenue,
      totalProductCost,
      grossProfit,
      tripExpenseTotal,
      shippingRevenue,
      netProfit,
      netMargin,
      productList,
      productTypeCount,
      noCostCount,
      customers,
      newCount,
      returnCount,
      avgOrderValue,
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

  const mCard = {
    background: 'var(--card)',
    borderRadius: 12,
    padding: '14px 16px',
    border: '1px solid var(--border)',
    textAlign: 'center',
    flex: 1,
    minWidth: 0,
  }

  const sectionTitle = {
    fontSize: 16,
    fontWeight: 700,
    marginBottom: 12,
    marginTop: 24,
  }

  const cardStyle = {
    background: 'var(--card)',
    borderRadius: 12,
    padding: 14,
    border: '1px solid var(--border)',
    textAlign: 'center',
    flex: 1,
    minWidth: 0,
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={onBack}
            style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: 'var(--text)', padding: 0 }}
          >←</button>
          <div>
            <div className="ph-title">{trip.destination}</div>
            <div className="ph-sub">{formatDate(trip.depart_date)} — {formatDate(trip.return_date)}</div>
          </div>
        </div>
        <button
          onClick={onEdit}
          style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 14px', fontSize: 13, cursor: 'pointer', color: 'var(--text)' }}
        >編輯</button>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-3)' }}>載入報告中…</div>
      ) : !data ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-3)' }}>載入失敗</div>
      ) : (
        <>
          {/* ── Missing cost warning ── */}
          {data.noCostCount > 0 && (
            <div style={{
              background: '#fef3c7',
              border: '1px solid #f59e0b',
              borderRadius: 10,
              padding: '10px 14px',
              marginBottom: 16,
              fontSize: 13,
              color: '#92400e',
            }}>
              {data.noCostCount} 件商品未設定成本，利潤計算可能不準確（見下方商品列表可直接設定）
            </div>
          )}

          {/* ── Slide Carousel ── */}
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
            {/* Slide 1: 核心財務 */}
            <div className="trip-slide" style={{ minWidth: '100%', flexShrink: 0, scrollSnapAlign: 'start', boxSizing: 'border-box', paddingRight: 24 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-3)', marginBottom: 10 }}>核心財務</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div style={mCard}>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 4 }}>總營收</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>${data.totalRevenue.toLocaleString()}</div>
                </div>
                <div style={mCard}>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 4 }}>商品成本</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>${Math.round(data.totalProductCost).toLocaleString()}</div>
                </div>
                <div style={mCard}>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 4 }}>毛利</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: data.grossProfit >= 0 ? '#16a34a' : '#e53e3e' }}>
                    ${Math.round(data.grossProfit).toLocaleString()}
                  </div>
                </div>
                <div style={mCard}>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 4 }}>淨利</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: data.netProfit >= 0 ? '#16a34a' : '#e53e3e' }}>
                    ${Math.round(data.netProfit).toLocaleString()}
                  </div>
                </div>
              </div>
            </div>

            {/* Slide 2: 營運指標 */}
            <div className="trip-slide" style={{ minWidth: '100%', flexShrink: 0, scrollSnapAlign: 'start', boxSizing: 'border-box', paddingRight: 24 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-3)', marginBottom: 10 }}>營運指標</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div style={mCard}>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 4 }}>淨利率</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: data.netMargin >= 0 ? '#16a34a' : '#e53e3e' }}>
                    {data.netMargin.toFixed(1)}%
                  </div>
                </div>
                <div style={mCard}>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 4 }}>訂單數</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{data.orders.length}</div>
                </div>
                <div style={mCard}>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 4 }}>行程費用</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>${data.tripExpenseTotal.toLocaleString()}</div>
                </div>
                <div style={mCard}>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 4 }}>運費收入</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>${data.shippingRevenue.toLocaleString()}</div>
                </div>
              </div>
            </div>

            {/* Slide 3: 客群概覽 */}
            <div className="trip-slide" style={{ minWidth: '100%', flexShrink: 0, scrollSnapAlign: 'start', boxSizing: 'border-box' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-3)', marginBottom: 10 }}>客群概覽</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div style={mCard}>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 4 }}>商品種類</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{data.productTypeCount}</div>
                </div>
                <div style={mCard}>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 4 }}>平均客單價</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>${Math.round(data.avgOrderValue).toLocaleString()}</div>
                </div>
                <div style={mCard}>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 4 }}>新客</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{data.newCount}</div>
                </div>
                <div style={mCard}>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 4 }}>回購客</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{data.returnCount}</div>
                </div>
              </div>
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

          {/* ── Section 2: Product Performance (top 5) ── */}
          <div style={{ ...sectionTitle, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>商品表現</span>
            {data.productList.length > 5 && (
              <button onClick={() => setDetailSheet('products')} style={{
                background: 'none', border: 'none', fontSize: 13, color: 'var(--text-3)', cursor: 'pointer',
              }}>查看全部 ({data.productList.length}) →</button>
            )}
          </div>
          {data.productList.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-3)' }}>此區間無商品銷售紀錄</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {data.productList.slice(0, 5).map((p, i) => (
                <ProductRow key={p.id} p={p} i={i} costEdits={costEdits} setCostEdits={setCostEdits} saveCost={saveCost} savingCost={savingCost} onSelect={setSelectedProduct} />
              ))}
              {data.productList.length > 5 && (
                <button onClick={() => setDetailSheet('products')} style={{
                  background: 'none', border: '1px dashed var(--border)', borderRadius: 8, padding: 10,
                  fontSize: 13, color: 'var(--text-3)', cursor: 'pointer', textAlign: 'center',
                }}>查看全部 {data.productList.length} 件商品</button>
              )}
            </div>
          )}

          {/* ── Section 3: Customer Insights (top 5) ── */}
          {data.customers.length > 0 && (
            <>
              <div style={{ ...sectionTitle, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>TOP 客戶</span>
                {data.customers.length > 5 && (
                  <button onClick={() => setDetailSheet('customers')} style={{
                    background: 'none', border: 'none', fontSize: 13, color: 'var(--text-3)', cursor: 'pointer',
                  }}>查看全部 ({data.customers.length}) →</button>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
                {data.customers.slice(0, 5).map((c, i) => (
                  <CustomerRow key={i} c={c} i={i} />
                ))}
                {data.customers.length > 5 && (
                  <button onClick={() => setDetailSheet('customers')} style={{
                    background: 'none', border: '1px dashed var(--border)', borderRadius: 8, padding: 10,
                    fontSize: 13, color: 'var(--text-3)', cursor: 'pointer', textAlign: 'center',
                  }}>查看全部 {data.customers.length} 位客戶</button>
                )}
              </div>
            </>
          )}

          {/* ── Section 4: Expense Breakdown ── */}
          <div style={sectionTitle}>行程費用明細</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 40 }}>
            {(trip.trip_expenses || []).map((e, i) => (
              <div key={i} style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                background: 'var(--card)',
                borderRadius: 8,
                padding: '10px 14px',
                border: '1px solid var(--border)',
              }}>
                <span style={{ fontSize: 14 }}>{e.label}</span>
                <span style={{ fontWeight: 600, fontSize: 14 }}>${Number(e.amount).toLocaleString()}</span>
              </div>
            ))}
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '10px 14px',
              fontWeight: 700,
            }}>
              <span>合計</span>
              <span>${data.tripExpenseTotal.toLocaleString()}</span>
            </div>
          </div>
        </>
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
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {data.customers.map((c, i) => (
                  <CustomerRow key={i} c={c} i={i} />
                ))}
              </div>
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {selectedProduct.sku && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
                  <span style={{ color: 'var(--text-3)' }}>SKU</span>
                  <span style={{ fontWeight: 500 }}>{selectedProduct.sku}</span>
                </div>
              )}
              {selectedProduct.source && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
                  <span style={{ color: 'var(--text-3)' }}>來源</span>
                  <span style={{ fontWeight: 500 }}>{selectedProduct.source}</span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
                <span style={{ color: 'var(--text-3)' }}>成本</span>
                <span style={{ fontWeight: 500 }}>
                  {selectedProduct.hasCost
                    ? `${selectedProduct.unitCost} ${selectedProduct.currency}`
                    : '未設定'}
                </span>
              </div>
              {selectedProduct.shopPrice && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
                  <span style={{ color: 'var(--text-3)' }}>售價</span>
                  <span style={{ fontWeight: 500 }}>${selectedProduct.shopPrice.toLocaleString()}</span>
                </div>
              )}

              <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />

              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
                <span style={{ color: 'var(--text-3)' }}>此趟銷量</span>
                <span style={{ fontWeight: 600 }}>{selectedProduct.qty}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
                <span style={{ color: 'var(--text-3)' }}>此趟營收</span>
                <span style={{ fontWeight: 600 }}>${selectedProduct.revenue.toLocaleString()}</span>
              </div>
              {selectedProduct.hasCost && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
                    <span style={{ color: 'var(--text-3)' }}>此趟毛利</span>
                    <span style={{ fontWeight: 600, color: selectedProduct.profit >= 0 ? '#16a34a' : '#e53e3e' }}>
                      ${Math.round(selectedProduct.profit).toLocaleString()}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
                    <span style={{ color: 'var(--text-3)' }}>毛利率</span>
                    <span style={{ fontWeight: 600, color: selectedProduct.margin >= 0 ? '#16a34a' : '#e53e3e' }}>
                      {selectedProduct.margin.toFixed(1)}%
                    </span>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Shared Row Components ──────────────────────────────────────
function ProductRow({ p, i, costEdits, setCostEdits, saveCost, savingCost, onSelect }) {
  return (
    <div
      onClick={() => onSelect?.(p)}
      style={{
        background: 'var(--card)',
        borderRadius: 10,
        padding: '12px 14px',
        border: '1px solid var(--border)',
        cursor: onSelect ? 'pointer' : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        {p.images?.[0] && (
          <img src={p.images[0]} alt="" style={{ width: 36, height: 36, borderRadius: 6, objectFit: 'cover', flexShrink: 0 }} />
        )}
        <div style={{ fontWeight: 600, fontSize: 14 }}>
          <span style={{ color: 'var(--text-3)', marginRight: 6 }}>#{i + 1}</span>
          {p.name}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 16, fontSize: 13, color: 'var(--text-2)', flexWrap: 'wrap' }}>
        <span>銷量 {p.qty}</span>
        <span>營收 ${p.revenue.toLocaleString()}</span>
        {p.hasCost && <span>毛利 ${Math.round(p.profit).toLocaleString()}</span>}
        {p.hasCost && <span>{p.margin.toFixed(1)}%</span>}
      </div>
      {!p.hasCost && (
        <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            value={costEdits[p.id]?.currency || p.currency || 'TWD'}
            onChange={e => setCostEdits(prev => ({
              ...prev,
              [p.id]: { ...prev[p.id], currency: e.target.value, cost: prev[p.id]?.cost || '' }
            }))}
            style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 13, background: 'var(--bg)' }}
          >
            <option value="TWD">TWD</option>
            <option value="JPY">JPY</option>
            <option value="KRW">KRW</option>
            <option value="USD">USD</option>
            <option value="VND">VND</option>
          </select>
          <input
            type="number"
            inputMode="decimal"
            placeholder="輸入成本"
            value={costEdits[p.id]?.cost || ''}
            onChange={e => setCostEdits(prev => ({
              ...prev,
              [p.id]: { ...prev[p.id], cost: e.target.value, currency: prev[p.id]?.currency || p.currency || 'TWD' }
            }))}
            style={{ flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid #f59e0b', fontSize: 13, background: '#fffbeb' }}
          />
          <button
            onClick={() => saveCost(p.id)}
            disabled={!costEdits[p.id]?.cost || savingCost === p.id}
            style={{
              padding: '6px 12px', borderRadius: 6, border: 'none',
              background: costEdits[p.id]?.cost ? 'var(--text)' : 'var(--border)',
              color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', flexShrink: 0,
            }}
          >
            {savingCost === p.id ? '…' : '儲存'}
          </button>
        </div>
      )}
    </div>
  )
}

function CustomerRow({ c, i }) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      background: 'var(--card)',
      borderRadius: 8,
      padding: '10px 14px',
      border: '1px solid var(--border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, color: 'var(--text-3)' }}>#{i + 1}</span>
        <span style={{ fontWeight: 500, fontSize: 14 }}>{c.name}</span>
        {c.isNew && (
          <span style={{ fontSize: 11, background: '#dbeafe', color: '#2563eb', padding: '1px 6px', borderRadius: 4 }}>新客</span>
        )}
      </div>
      <div style={{ fontWeight: 600, fontSize: 14 }}>
        ${c.total.toLocaleString()}
        <span style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 4 }}>{c.orderCount}單</span>
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
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    fontSize: 15,
    background: 'var(--bg)',
    boxSizing: 'border-box',
  }

  const labelStyle = {
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--text-2)',
    marginBottom: 4,
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
              color: 'var(--red, #e53e3e)',
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
