import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import CustomSelect from '../components/CustomSelect'
import ProcurementBatchTab, { CreateBatchSheet } from '../components/ProcurementBatchTab'
import ListToolbar from '../components/ListToolbar'
import { Pill } from '../components/MenuPopover'

export default function OrdersPage() {
  const { can, profile, storeId } = useAuth()
  const [tab, setTab] = useState('orders')
  const [orderSubFilter, setOrderSubFilter] = useState('all') // 'all' | 'internal' | 'consumer'
  const [orders, setOrders] = useState([])
  const [consumerOrders, setConsumerOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [sheet, setSheet] = useState(null)
  const [procurementData, setProcurementData] = useState(null) // { grouped, ungrouped }

  useEffect(() => {
    if (!storeId) return
    fetchAll()
  }, [storeId])

  async function fetchAll() {
    setLoading(true)
    const [{ data: ord }, { data: cord }] = await Promise.all([
      supabase.from('orders').select('*').eq('store_id', storeId).order('created_at', { ascending: false }),
      supabase.from('consumer_orders').select('*').eq('store_id', storeId).order('created_at', { ascending: false }),
    ])
    setOrders(ord || [])
    setConsumerOrders(cord || [])
    setLoading(false)
  }

  const [createBatchData, setCreateBatchData] = useState(null) // { source, items }
  const [previewItem, setPreviewItem] = useState(null)
  const [previewImgIdx, setPreviewImgIdx] = useState(0)
  const [sourceFilter, setSourceFilter] = useState('all') // 'all' | source name
  const [statusFilter, setStatusFilter] = useState('all') // 'all' | status（自建＋商城統一）
  const [showExportSheet, setShowExportSheet] = useState(false)
  const [showExportMenu, setShowExportMenu] = useState(false)
  const [showRevenueSheet, setShowRevenueSheet] = useState(false)
  const [consumerSearch, setConsumerSearch] = useState('')
  const [consumerDateFilter, setConsumerDateFilter] = useState('all')
  const [consumerPage, setConsumerPage] = useState(1)
  const CONSUMER_PAGE_SIZE = 15
  const isAdmin = ['admin', 'super_admin'].includes(profile?.role)

  async function fetchProcurement() {
    setLoading(true)
    const [{ data: pending }, { data: products }, { data: spProducts }, { data: rates }, { data: images }, { data: allVariants }, { data: existingBatchItems }] = await Promise.all([
      supabase.from('consumer_orders').select('*').eq('store_id', storeId).not('status', 'in', '("已購買","已出貨","完成","已取消")'),
      supabase.from('products').select('id, name, sku, source, cost, currency').eq('store_id', storeId),
      supabase.from('storefront_products').select('product_id, shop_price').eq('store_id', storeId),
      supabase.from('exchange_rates').select('*'),
      supabase.from('product_images').select('product_id, url, sort_order').order('sort_order', { ascending: true }),
      supabase.from('product_variants').select('id, product_id, options'),
      supabase.from('procurement_items').select('product_id, variant_id, quantity, actual_qty, status, batch:batch_id(status)'),
    ])

    const productMap = {}
    ;(products || []).forEach(p => { productMap[p.id] = p })

    const priceMap = {}
    ;(spProducts || []).forEach(sp => { priceMap[sp.product_id] = sp.shop_price })

    const rateMap = {}
    ;(rates || []).forEach(r => { rateMap[r.currency] = Number(r.rate) })

    // 每個商品的所有圖片（已按 sort_order 排序）
    const imageMap = {}
    ;(images || []).forEach(img => {
      if (!imageMap[img.product_id]) imageMap[img.product_id] = []
      imageMap[img.product_id].push(img.url)
    })

    // variant map: product_id → { label → variant }
    const variantMap = {}
    ;(allVariants || []).forEach(v => {
      if (!variantMap[v.product_id]) variantMap[v.product_id] = {}
      const label = v.options ? Object.values(v.options).join(' / ') : ''
      variantMap[v.product_id][label] = v
    })

    // 找出缺少的匯率
    const usedCurrencies = new Set()

    const agg = {}
    ;(pending || []).forEach(order => {
      const items = Array.isArray(order.items_json) ? order.items_json : []
      items.forEach(item => {
        if (item.status === 'cancelled') return
        const pid = item.id
        const prod = productMap[pid]
        if (!agg[pid]) {
          agg[pid] = {
            productId: pid,
            name: item.name,
            sku: prod?.sku || item.sku || '',
            source: prod?.source || '',
            cost: prod?.cost != null ? Number(prod.cost) : null,
            currency: prod?.currency || 'TWD',
            shopPrice: priceMap[pid] != null ? Number(priceMap[pid]) : null,
            images: imageMap[pid] || [],
            thumbnail: (imageMap[pid] || [])[0] || null,
            totalQty: 0,
            variants: {},
            variantDetails: variantMap[pid] || {},
          }
        }
        const qty = Number(item.qty) || 0
        agg[pid].totalQty += qty
        const vLabel = item.variantLabel || '無規格'
        agg[pid].variants[vLabel] = (agg[pid].variants[vLabel] || 0) + qty
      })
    })

    // 扣除已排入批次的數量（非 settled 的批次中已買到的數量）
    const batchedQty = {} // productId → qty already handled
    ;(existingBatchItems || []).forEach(bi => {
      if (!bi.batch || bi.batch.status === 'settled') return // settled 批次不扣（已完結）
      const pid = bi.product_id
      const bought = bi.status === 'bought' || bi.status === 'partial'
        ? (bi.actual_qty ?? bi.quantity)
        : bi.status === 'pending' ? bi.quantity : 0 // pending 也算已排入
      if (!batchedQty[pid]) batchedQty[pid] = 0
      batchedQty[pid] += bought
    })

    Object.values(agg).forEach(item => {
      const deducted = batchedQty[item.productId] || 0
      if (deducted > 0) {
        item.batchedQty = deducted
        item.totalQty = Math.max(0, item.totalQty - deducted)
      }
    })

    // 移除數量為 0 的品項
    Object.keys(agg).forEach(pid => {
      if (agg[pid].totalQty <= 0) delete agg[pid]
    })

    // 計算每項成本（TWD）和營收
    let totalCost = 0, totalRevenue = 0
    const missingRates = new Set()
    const warnings = [] // 未定價或無成本的商品

    Object.values(agg).forEach(item => {
      const cur = item.currency || 'TWD'
      if (cur !== 'TWD') usedCurrencies.add(cur)

      // 成本計算
      if (item.cost != null && item.cost > 0) {
        let costTWD = item.cost
        if (cur !== 'TWD') {
          const rate = rateMap[cur]
          if (rate) {
            costTWD = item.cost * rate
          } else {
            missingRates.add(cur)
            costTWD = 0
          }
        }
        item.costTWD = costTWD
        item.totalCostTWD = costTWD * item.totalQty
        totalCost += item.totalCostTWD
      } else {
        item.costTWD = null
        item.totalCostTWD = null
        warnings.push({ name: item.name, sku: item.sku, type: 'no_cost' })
      }

      // 營收計算
      if (item.shopPrice != null && item.shopPrice > 0) {
        item.totalRevenue = item.shopPrice * item.totalQty
        totalRevenue += item.totalRevenue
      } else {
        item.totalRevenue = null
        warnings.push({ name: item.name, sku: item.sku, type: 'no_price' })
      }
    })

    const grouped = {}
    const ungrouped = []
    Object.values(agg).forEach(item => {
      if (item.source) {
        if (!grouped[item.source]) grouped[item.source] = []
        grouped[item.source].push(item)
      } else {
        ungrouped.push(item)
      }
    })

    const profit = totalRevenue - totalCost
    const profitRate = totalRevenue > 0 ? (profit / totalRevenue) * 100 : 0

    setProcurementData({
      grouped, ungrouped,
      totalCost, totalRevenue, profit, profitRate,
      missingRates: [...missingRates],
      warnings,
    })
    setLoading(false)
  }

  useEffect(() => {
    if (!storeId) return
    if (tab === 'procurement') {
      setSourceFilter('all')
      fetchProcurement()
    }
  }, [tab, storeId])

  const activeOrders = orders.filter(o => o.status !== '已取消')
  const cancelledInternalOrders = orders.filter(o => o.status === '已取消')
  const pendingConsumer = consumerOrders.filter(o => o.status === '待確認').length

  return (
    <div className="page">
      <div className="ph">
        <div>
          <div className="ph-title">訂單管理</div>
          <div className="ph-sub">
            {tab === 'orders' ? `共 ${activeOrders.length + consumerOrders.filter(o => o.status !== '已取消').length} 筆` : tab === 'procurement' ? '待採購品項' : '採購紀錄'}
          </div>
        </div>
        {tab === 'orders' && can('add') && <button className="icon-btn" onClick={() => setSheet('add')}>+</button>}
      </div>

      {/* Tab switcher */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {[
          { key: 'orders', label: '全部訂單', badge: pendingConsumer },
          { key: 'procurement', label: '採購彙整' },
          { key: 'batch', label: '採購紀錄' },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              flex: 1, padding: '9px 0', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600,
              background: tab === t.key ? 'var(--text)' : 'var(--card)',
              color: tab === t.key ? '#fff' : 'var(--text-2)',
              position: 'relative',
            }}
          >
            {t.label}
            {t.badge > 0 && (
              <span style={{
                position: 'absolute', top: 6, right: 12,
                background: 'var(--red)', color: '#fff',
                borderRadius: '50%', width: 18, height: 18, fontSize: 11,
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700,
              }}>{t.badge}</span>
            )}
          </button>
        ))}
      </div>

      {loading && <div className="empty">載入中…</div>}

      {/* Merged orders tab */}
      {!loading && tab === 'orders' && (() => {
        // 來源 pills
        const sourceFilters = [
          { key: 'all', label: '全部' },
          { key: 'consumer', label: '商城訂單' },
          { key: 'internal', label: '自建訂單' },
        ]
        // 統一狀態（自建＋商城共用，含已取消）
        const statusFilters = [
          { key: 'all', label: '全部' },
          { key: '待確認', label: '待確認' },
          { key: '處理中', label: '處理中' },
          { key: '已購買', label: '已購買' },
          { key: '已出貨', label: '已出貨' },
          { key: '完成', label: '完成' },
          { key: '已取消', label: '已取消' },
        ]
        const dateOptions = [
          { value: 'all', label: '不限日期' },
          { value: 'today', label: '今天' },
          { value: 'week', label: '本週' },
          { value: 'month', label: '本月' },
        ]
        const showInternal = orderSubFilter === 'all' || orderSubFilter === 'internal'
        const showConsumer = orderSubFilter === 'all' || orderSubFilter === 'consumer'
        const viewingCancelled = statusFilter === '已取消'

        // 日期篩選 helper（自建／商城共用）
        const matchDate = (order) => {
          if (consumerDateFilter === 'all') return true
          const d = new Date(order.created_at)
          const now = new Date()
          if (consumerDateFilter === 'today') return d.toDateString() === now.toDateString()
          if (consumerDateFilter === 'week') {
            const day = now.getDay() || 7
            const weekStart = new Date(now); weekStart.setDate(now.getDate() - day + 1); weekStart.setHours(0,0,0,0)
            return d >= weekStart
          }
          if (consumerDateFilter === 'month') {
            return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
          }
          return true
        }
        // 商城搜尋 helper
        const searchTerm = consumerSearch.trim().toLowerCase()
        const matchSearch = (order) => {
          if (!searchTerm) return true
          const id6 = order.id?.toString().slice(-6) || ''
          return (
            id6.includes(searchTerm) ||
            (order.customer_name || '').toLowerCase().includes(searchTerm) ||
            (order.phone || '').includes(searchTerm)
          )
        }

        // 自建訂單：依狀態挑清單（只有 全部／已取消 有意義）
        let internalList = []
        if (statusFilter === 'all') internalList = activeOrders.filter(matchDate)
        else if (statusFilter === '已取消') internalList = cancelledInternalOrders.filter(matchDate)
        const internalUnpaid = internalList.filter(o => o.payment_status !== '已付清')
        const internalPaid = internalList.filter(o => o.payment_status === '已付清')

        // 商城訂單：依狀態挑清單
        const consumerByStatus = statusFilter === 'all'
          ? consumerOrders.filter(o => o.status !== '已取消')
          : consumerOrders.filter(o => o.status === statusFilter)
        const filteredConsumer = consumerByStatus.filter(o => matchDate(o) && matchSearch(o))
        const totalFiltered = filteredConsumer.length
        const totalPages = Math.max(1, Math.ceil(totalFiltered / CONSUMER_PAGE_SIZE))
        const safePage = Math.min(consumerPage, totalPages)
        const pagedConsumer = filteredConsumer.slice((safePage - 1) * CONSUMER_PAGE_SIZE, safePage * CONSUMER_PAGE_SIZE)

        // 狀態 pill 數字（依目前來源加總）
        const statusCount = (key) => {
          let n = 0
          if (showConsumer) {
            n += consumerOrders.filter(o =>
              (key === 'all' ? o.status !== '已取消' : o.status === key) && matchDate(o) && matchSearch(o)
            ).length
          }
          if (showInternal) {
            if (key === 'all') n += activeOrders.filter(matchDate).length
            else if (key === '已取消') n += cancelledInternalOrders.filter(matchDate).length
          }
          return n
        }

        const hasActiveFilters = statusFilter !== 'all' || consumerDateFilter !== 'all'
        const activeStatusLabel = statusFilters.find(f => f.key === statusFilter)?.label || '全部'

        return (
          <>
            {/* 來源切換 */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              {sourceFilters.map(f => (
                <button
                  key={f.key}
                  onClick={() => { setOrderSubFilter(f.key); setConsumerPage(1) }}
                  style={{
                    padding: '5px 14px', borderRadius: 20, border: '1px solid var(--border)',
                    background: orderSubFilter === f.key ? 'var(--text)' : 'var(--card)',
                    color: orderSubFilter === f.key ? '#fff' : 'var(--text-2)',
                    fontSize: 13, fontWeight: orderSubFilter === f.key ? 700 : 400, cursor: 'pointer',
                  }}
                >{f.label}</button>
              ))}
            </div>

            {/* 統一工具列：搜尋 + 篩選 + 匯出（訂單不顯示排序）*/}
            <ListToolbar
              search={consumerSearch}
              onSearch={v => { setConsumerSearch(v); setConsumerPage(1) }}
              placeholder="搜尋編號、姓名、電話"
              filter={{
                active: hasActiveFilters,
                label: hasActiveFilters ? activeStatusLabel : '篩選',
                onClear: () => { setStatusFilter('all'); setConsumerDateFilter('all'); setConsumerPage(1) },
                children: (
                  <>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-3)', marginBottom: 8 }}>訂單狀態</div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {statusFilters.map(f => (
                          <Pill key={f.key} active={statusFilter === f.key} onClick={() => { setStatusFilter(f.key); setConsumerPage(1) }}>
                            {f.label}（{statusCount(f.key)}）
                          </Pill>
                        ))}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-3)', marginBottom: 8 }}>日期</div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {dateOptions.map(d => (
                          <Pill key={d.value} active={consumerDateFilter === d.value} onClick={() => { setConsumerDateFilter(d.value); setConsumerPage(1) }}>
                            {d.label}
                          </Pill>
                        ))}
                      </div>
                    </div>
                  </>
                ),
              }}
              actions={isAdmin && (
                <div style={{ position: 'relative' }}>
                  <button className="lt-ctrl" onClick={() => setShowExportMenu(v => !v)}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    <span className="lt-ctrl__label">匯出</span>
                  </button>
                  {showExportMenu && (
                    <>
                      <div onClick={() => setShowExportMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 19 }} />
                      <div style={{
                        position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 20, width: 140,
                        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
                        boxShadow: '0 4px 16px rgba(0,0,0,.10)', overflow: 'hidden',
                      }}>
                        {[
                          { icon: '📦', label: '出貨單', open: () => setShowExportSheet(true) },
                          { icon: '📊', label: '營收報表', open: () => setShowRevenueSheet(true) },
                        ].map((m, i) => (
                          <button
                            key={m.label}
                            onClick={() => { setShowExportMenu(false); m.open() }}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 8,
                              width: '100%', padding: '11px 14px', textAlign: 'left',
                              background: 'var(--surface)', border: 'none', cursor: 'pointer', outline: 'none',
                              borderTop: i > 0 ? '1px solid var(--border)' : 'none',
                              fontSize: 13, fontWeight: 500, color: 'var(--text)',
                            }}
                          >
                            <span>{m.icon}</span>{m.label}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            />

            {/* Internal orders section */}
            {showInternal && internalList.length > 0 && (
              <>
                {orderSubFilter === 'all' && <div className="sec">自建訂單</div>}
                {!viewingCancelled && (
                  <div className="stats" style={{ marginBottom: 10 }}>
                    <div className="stat">
                      <div className="stat-val text-amber">{internalUnpaid.length}</div>
                      <div className="stat-lbl"><span className="dot" style={{background:'var(--amber)'}} />待付款</div>
                    </div>
                    <div className="stat">
                      <div className="stat-val text-green">{internalPaid.length}</div>
                      <div className="stat-lbl"><span className="dot" style={{background:'var(--green)'}} />已付清</div>
                    </div>
                  </div>
                )}
                <div className="card-grid">
                  {internalList.map(o => (
                    viewingCancelled ? (
                      <div key={`i-${o.id}`} style={{ opacity: 0.6 }}>
                        <OrderCard order={o} onTap={() => setSheet(o)} />
                      </div>
                    ) : (
                      <OrderCard key={`i-${o.id}`} order={o} onTap={() => setSheet(o)} />
                    )
                  ))}
                </div>
              </>
            )}

            {/* 自建訂單空狀態（僅在單看自建時提示） */}
            {showInternal && internalList.length === 0 && orderSubFilter === 'internal' && (
              <div className="empty">
                {viewingCancelled ? '沒有已取消的自建訂單'
                  : statusFilter === 'all' ? '還沒有自建訂單'
                  : '沒有符合的自建訂單'}
              </div>
            )}

            {/* Consumer orders section */}
            {showConsumer && (
              <>
            {orderSubFilter === 'all' && <div className="sec">商城訂單</div>}

            {/* 訂單列表 */}
            {pagedConsumer.length === 0 && <div className="empty">沒有符合的訂單</div>}
            <div className="card-grid">
              {pagedConsumer.map(o => (
                viewingCancelled ? (
                  <div key={o.id} style={{ opacity: 0.6 }}>
                    <ConsumerOrderCard order={o} onTap={() => setSheet({ _type: 'consumer', ...o })} />
                  </div>
                ) : (
                  <ConsumerOrderCard key={o.id} order={o} onTap={() => setSheet({ _type: 'consumer', ...o })} />
                )
              ))}
            </div>

            {/* 分頁 */}
            {totalPages > 1 && (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 20, flexWrap: 'wrap' }}>
                <button
                  onClick={() => setConsumerPage(p => Math.max(1, p - 1))}
                  disabled={safePage === 1}
                  style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', cursor: safePage === 1 ? 'default' : 'pointer', opacity: safePage === 1 ? 0.4 : 1 }}
                >
                  ‹
                </button>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
                  <button
                    key={p}
                    onClick={() => setConsumerPage(p)}
                    style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)', background: p === safePage ? 'var(--text)' : 'var(--bg)', color: p === safePage ? '#fff' : 'var(--text)', cursor: 'pointer', fontWeight: p === safePage ? 700 : 400, minWidth: 36 }}
                  >
                    {p}
                  </button>
                ))}
                <button
                  onClick={() => setConsumerPage(p => Math.min(totalPages, p + 1))}
                  disabled={safePage === totalPages}
                  style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', cursor: safePage === totalPages ? 'default' : 'pointer', opacity: safePage === totalPages ? 0.4 : 1 }}
                >
                  ›
                </button>
              </div>
            )}

          </>
            )}
          </>
        )
      })()}

      {/* Procurement summary tab */}
      {!loading && tab === 'procurement' && procurementData && (() => {
        const allSources = Object.keys(procurementData.grouped)
        const hasUngrouped = procurementData.ungrouped.length > 0
        const isEmpty = allSources.length === 0 && !hasUngrouped

        // 根據篩選計算統計數字
        const filteredItems = sourceFilter === 'all'
          ? [...Object.values(procurementData.grouped).flat(), ...procurementData.ungrouped]
          : sourceFilter === '_ungrouped'
            ? procurementData.ungrouped
            : (procurementData.grouped[sourceFilter] || [])

        return (
          <>
            {isEmpty ? (
              <div className="empty">目前沒有待採購的品項</div>
            ) : (
              <>
                {/* 來源篩選 */}
                <div style={{ marginBottom: 14 }}>
                  <CustomSelect
                    label="全部來源"
                    value={sourceFilter === 'all' ? null : sourceFilter}
                    options={[
                      ...allSources.map(source => ({ value: source, label: source })),
                      ...(hasUngrouped ? [{ value: '_ungrouped', label: '未設定來源' }] : []),
                    ]}
                    onChange={v => setSourceFilter(v || 'all')}
                  />
                </div>

                {/* 未定價 / 無成本提醒 */}
                {procurementData.warnings.length > 0 && (
                  <div style={{
                    background: '#fff5f5', borderRadius: 12, padding: '12px 16px', marginBottom: 16,
                    fontSize: 13, color: '#a03030',
                  }}>
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>以下商品資料不完整，已從利潤計算中排除：</div>
                    {procurementData.warnings.map((w, i) => (
                      <div key={i}>· {w.name}{w.sku ? ` (${w.sku})` : ''} — {w.type === 'no_cost' ? '未設定成本' : '未設定售價'}</div>
                    ))}
                  </div>
                )}

                {/* 商品列表 */}
                {(sourceFilter === 'all' ? Object.entries(procurementData.grouped) : sourceFilter === '_ungrouped' ? [] : procurementData.grouped[sourceFilter] ? [[sourceFilter, procurementData.grouped[sourceFilter]]] : []).map(([source, items]) => (
                  <div key={source} style={{ marginBottom: 20 }}>
                    <div className="sec" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span>🏬</span> {source}
                      <span className="muted fs12">({items.reduce((s, i) => s + i.totalQty, 0)} 件)</span>
                      <button
                        onClick={() => setCreateBatchData({ source, items })}
                        style={{
                          marginLeft: 'auto', padding: '4px 10px', borderRadius: 8,
                          border: '1px solid var(--border)', background: 'var(--card)',
                          fontSize: 12, fontWeight: 600, cursor: 'pointer', color: 'var(--text)',
                          whiteSpace: 'nowrap',
                        }}
                      >建立批次</button>
                    </div>
                    {items.map(item => (
                      <ProcurementItemCard key={item.sku || item.productId} item={item} onPreview={item => { setPreviewImgIdx(0); setPreviewItem(item) }} />
                    ))}
                  </div>
                ))}

                {(sourceFilter === 'all' || sourceFilter === '_ungrouped') && procurementData.ungrouped.length > 0 && (
                  <div style={{ marginBottom: 20 }}>
                    <div className="sec" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span>📦</span> 未設定來源
                      <span className="muted fs12">({procurementData.ungrouped.reduce((s, i) => s + i.totalQty, 0)} 件)</span>
                    </div>
                    {procurementData.ungrouped.map(item => (
                      <ProcurementItemCard key={item.sku || item.productId} item={item} onPreview={item => { setPreviewImgIdx(0); setPreviewItem(item) }} />
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        )
      })()}

      {/* Procurement batch tab */}
      {!loading && tab === 'batch' && (
        <ProcurementBatchTab />
      )}

      {/* 商品預覽 Modal */}
      {previewItem && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 24,
        }} onClick={() => setPreviewItem(null)}>
          <div style={{
            background: 'var(--surface)', borderRadius: 16, maxWidth: 380, width: '100%',
            maxHeight: '80vh', overflow: 'auto', padding: 20,
          }} onClick={e => e.stopPropagation()}>
            {previewItem.images?.length > 0 && (
              <div style={{ position: 'relative', marginBottom: 16 }}>
                <div style={{
                  background: 'var(--bg)', borderRadius: 12, overflow: 'hidden',
                }}>
                  <img src={previewItem.images[previewImgIdx]} alt={`${previewItem.name} ${previewImgIdx + 1}`} style={{
                    width: '100%', display: 'block', objectFit: 'cover',
                  }} />
                </div>
                {previewItem.images.length > 1 && (
                  <>
                    <button onClick={() => setPreviewImgIdx(i => (i - 1 + previewItem.images.length) % previewItem.images.length)} style={{
                      position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)',
                      width: 32, height: 32, borderRadius: '50%', border: 'none',
                      background: 'rgba(0,0,0,0.45)', color: '#fff', fontSize: 16,
                      cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>‹</button>
                    <button onClick={() => setPreviewImgIdx(i => (i + 1) % previewItem.images.length)} style={{
                      position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                      width: 32, height: 32, borderRadius: '50%', border: 'none',
                      background: 'rgba(0,0,0,0.45)', color: '#fff', fontSize: 16,
                      cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>›</button>
                    <div style={{
                      display: 'flex', justifyContent: 'center', gap: 6, marginTop: 10,
                    }}>
                      {previewItem.images.map((_, i) => (
                        <span key={i} onClick={() => setPreviewImgIdx(i)} style={{
                          width: 7, height: 7, borderRadius: '50%', cursor: 'pointer',
                          background: i === previewImgIdx ? 'var(--text)' : 'var(--border)',
                          transition: 'background 0.2s',
                        }} />
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
            <div className="fw600 fs15" style={{ marginBottom: 4 }}>{previewItem.name}</div>
            {previewItem.sku && <div className="muted fs12" style={{ marginBottom: 12 }}>{previewItem.sku}</div>}
            <div className="sec" style={{ marginTop: 0 }}>需採購規格</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {Object.entries(previewItem.variants).map(([label, qty]) => (
                <span key={label} style={{
                  fontSize: 13, padding: '5px 12px', borderRadius: 16,
                  background: 'var(--surface)', border: '0.5px solid var(--border)',
                }}>
                  {label} <strong>× {qty}</strong>
                </span>
              ))}
            </div>
            <div style={{ marginTop: 16, display: 'flex', gap: 12, fontSize: 13 }}>
              {previewItem.costTWD != null && (
                <div><span className="muted">成本 </span><span className="fw600">NT${Math.round(previewItem.costTWD).toLocaleString()}</span></div>
              )}
              {previewItem.shopPrice != null && (
                <div><span className="muted">售價 </span><span className="fw600">NT${previewItem.shopPrice.toLocaleString()}</span></div>
              )}
            </div>
            <button onClick={() => setPreviewItem(null)} style={{
              marginTop: 20, width: '100%', padding: '12px 0', borderRadius: 12,
              border: 'none', background: 'var(--text)', color: '#fff',
              fontSize: 15, fontWeight: 600, cursor: 'pointer',
            }}>關閉</button>
          </div>
        </div>
      )}

      {createBatchData && (
        <CreateBatchSheet
          source={createBatchData.source}
          items={createBatchData.items}
          onClose={() => setCreateBatchData(null)}
          onSaved={() => { setCreateBatchData(null); fetchProcurement() }}
        />
      )}

      {sheet === 'add' && <AddOrderSheet onClose={() => setSheet(null)} onSaved={fetchAll} />}
      {sheet && sheet !== 'add' && !sheet._type && (
        <OrderDetailSheet order={sheet} onClose={() => setSheet(null)} onSaved={fetchAll} canEdit={can('pay')} />
      )}
      {sheet && sheet._type === 'consumer' && (
        <ConsumerOrderDetailSheet order={sheet} onClose={() => setSheet(null)} onSaved={fetchAll} canEdit={can('pay')} />
      )}
      {showRevenueSheet && (
        <ExportRevenueSheet onClose={() => setShowRevenueSheet(false)} />
      )}
      {showExportSheet && (
        <ExportShippingSheet orders={consumerOrders} onClose={() => setShowExportSheet(false)} />
      )}
    </div>
  )
}

function statusBadge(s) {
  if (s === '已付清') return <span className="badge badge-ok">已付清</span>
  if (s === '已付訂金') return <span className="badge badge-warn">已付訂金</span>
  return <span className="badge badge-low">未付</span>
}

function orderStatusBadge(s) {
  if (s === '完成') return <span className="badge badge-ok">完成</span>
  if (s === '已取消') return <span className="badge badge-low" style={{ color: 'var(--red)' }}>已取消</span>
  return <span className="badge badge-warn">處理中</span>
}

function OrderCard({ order: o, onTap }) {
  const balance = (Number(o.total_amount) || 0) - (Number(o.deposit) || 0)
  return (
    <div className="card" onClick={onTap} style={{cursor:'pointer'}}>
      <div className="card-row">
        <div style={{flex:1,minWidth:0}}>
          <div className="row-sb">
            <span className="fw600 fs15">{o.customer}</span>
            <div style={{ display: 'flex', gap: 6 }}>
              {o.status && o.status !== '處理中' && orderStatusBadge(o.status)}
              {statusBadge(o.payment_status)}
            </div>
          </div>
          <div className="muted fs12 mt8">#{o.id?.toString().slice(-6)} · {o.items}</div>
        </div>
      </div>
      {o.total_amount && (
        <div className="card-row row-sb" style={{background:'var(--bg)'}}>
          <div><span className="muted fs12">應付 </span><span className="fw600">NT${Number(o.total_amount).toLocaleString()}</span></div>
          {o.payment_status !== '已付清' && balance > 0 && (
            <div className="text-red fw600 fs13">尾款 NT${balance.toLocaleString()}</div>
          )}
        </div>
      )}
    </div>
  )
}

function consumerStatusBadge(s) {
  if (s === '已出貨') return <span className="badge badge-ok">已出貨</span>
  if (s === '已購買') return <span className="badge badge-warn" style={{ background: 'var(--blue, #3b82f6)', color: '#fff' }}>已購買</span>
  if (s === '處理中') return <span className="badge badge-warn">處理中</span>
  if (s === '完成')   return <span className="badge badge-ok">完成</span>
  if (s === '已取消') return <span className="badge badge-low" style={{ color: 'var(--red)' }}>已取消</span>
  return <span className="badge badge-low">待確認</span>
}

function ConsumerOrderCard({ order: o, onTap }) {
  return (
    <div className="card" onClick={onTap} style={{ cursor: 'pointer' }}>
      <div className="card-row">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row-sb">
            <span className="fw600 fs15">{o.customer_name}</span>
            <div style={{ display: 'flex', gap: 6 }}>
              {consumerStatusBadge(o.status)}
              {o.payment_status === '已付清'
                ? <span className="badge badge-ok">已付清</span>
                : <span className="badge badge-low">未付</span>}
            </div>
          </div>
          <div className="muted fs12 mt8">#{o.id?.toString().slice(-6)} · {o.items}</div>
          <div className="muted fs12">{o.phone} · {new Date(o.created_at).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
        </div>
      </div>
      {o.total_amount && (
        <div className="card-row row-sb" style={{ background: 'var(--bg)' }}>
          <div>
            <span className="muted fs12">總額 </span>
            <span className="fw600">NT${(Number(o.total_amount) - Number(o.discount_amount || 0)).toLocaleString()}</span>
            {Number(o.discount_amount) > 0 && (
              <span className="fs12" style={{ color: 'var(--green)', marginLeft: 6 }}>已折 NT${Number(o.discount_amount).toLocaleString()}</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ProcurementItemCard({ item, onPreview }) {
  const hasVariants = Object.keys(item.variants).length > 1 || (Object.keys(item.variants).length === 1 && !item.variants['無規格'])
  const noCost = item.costTWD == null
  const noPrice = item.totalRevenue == null

  return (
    <div className="card" style={{ marginBottom: 6 }}>
      <div className="card-row" style={{ gap: 12, alignItems: 'flex-start' }}>
        {/* 縮圖 */}
        <div
          onClick={() => onPreview(item)}
          style={{
            width: 48, height: 48, borderRadius: 8, flexShrink: 0, cursor: 'pointer',
            background: item.thumbnail ? `url(${item.thumbnail}) center/cover` : 'var(--surface)',
            border: '0.5px solid var(--border)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18, color: 'var(--text-2)',
          }}
        >
          {!item.thumbnail && '📷'}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row-sb" style={{ width: '100%' }}>
            <span className="fw600 fs14">{item.name}</span>
            <span className="fw600 fs15" style={{ color: 'var(--text)' }}>× {item.totalQty}</span>
          </div>
          <div className="muted fs12">{item.sku}</div>
          {(noCost || noPrice) && (
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              {noCost && <span style={{ fontSize: 11, padding: '1px 8px', borderRadius: 8, background: '#fff5f5', color: '#a03030' }}>未設定成本</span>}
              {noPrice && <span style={{ fontSize: 11, padding: '1px 8px', borderRadius: 8, background: '#fff5f5', color: '#a03030' }}>未設定售價</span>}
            </div>
          )}
          {hasVariants && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
              {Object.entries(item.variants).map(([label, qty]) => (
                <span key={label} style={{
                  fontSize: 12, padding: '3px 10px', borderRadius: 16,
                  background: 'var(--surface)', border: '0.5px solid var(--border)',
                }}>
                  {label} <strong>× {qty}</strong>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const FREE_SHIPPING_THRESHOLD = 3800
const DEFAULT_SHIPPING_FEE = 60
const notifyBtn = { padding: '8px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }

function ConsumerOrderDetailSheet({ order: o, onClose, onSaved, canEdit }) {
  const [status, setStatus] = useState(o.status || '待確認')
  const [payStatus, setPayStatus] = useState(o.payment_status || '未付')
  const [saving, setSaving] = useState(false)

  // 從 items_json 初始化，已有 status: 'cancelled' 的保留取消狀態
  const [itemStatuses, setItemStatuses] = useState(
    (Array.isArray(o.items_json) ? o.items_json : []).map(item => ({
      ...item,
      _cancelled: item.status === 'cancelled',
      _originalQty: item.originalQty || item.qty,
    }))
  )
  const [shippingFee, setShippingFee] = useState(o.shipping_fee || DEFAULT_SHIPPING_FEE)
  const [trackingNumber, setTrackingNumber] = useState(o.tracking_number || '')

  // 優惠券退還
  const [refundingCoupon, setRefundingCoupon] = useState(false)
  const [couponMinAmount, setCouponMinAmount] = useState(0)

  useEffect(() => {
    if (o.coupon_id) {
      supabase.from('coupons').select('min_amount').eq('id', o.coupon_id).single()
        .then(({ data }) => { if (data) setCouponMinAmount(Number(data.min_amount) || 0) })
    }
  }, [o.coupon_id])

  async function handleRefundCoupon() {
    if (!window.confirm('確定退還此訂單的優惠券？折抵金額將加回訂單總額。')) return
    setRefundingCoupon(true)
    const { data, error } = await supabase.rpc('refund_coupon', { p_order_id: o.id })
    setRefundingCoupon(false)
    if (error || !data?.ok) {
      alert('退還失敗：' + (data?.error || error?.message))
      return
    }
    alert(`已退還優惠券，折抵金額 NT$${Number(data.refunded_amount).toLocaleString()} 已加回訂單`)
    onSaved()
    onClose()
  }

  // 加購商品：商品庫選擇器
  const { storeId } = useAuth()
  const [addProducts, setAddProducts] = useState([])
  const [addVariants, setAddVariants] = useState({})
  const [addSpMap, setAddSpMap] = useState({})
  const [addValueMap, setAddValueMap] = useState({}) // option_value_id → value string
  const [showAddPicker, setShowAddPicker] = useState(false)
  const [addSearch, setAddSearch] = useState('')
  const [addPickerStep, setAddPickerStep] = useState('product') // 'product' | 'variant'
  const [addSelectedProd, setAddSelectedProd] = useState(null)
  useEffect(() => {
    if (!storeId) return
    Promise.all([
      supabase.from('products').select('id, name, sku, quantity').eq('store_id', storeId),
      supabase.from('product_variants').select('*'),
      supabase.from('storefront_products').select('product_id, shop_price').eq('store_id', storeId),
      supabase.from('variant_option_values').select('id, value'),
    ]).then(([{ data: prods }, { data: vars }, { data: sp }, { data: vals }]) => {
      setAddProducts(prods || [])
      const vm = {}
      ;(vals || []).forEach(v => { vm[v.id] = v.value })
      setAddValueMap(vm)
      const vMap = {}
      ;(vars || []).forEach(v => { if (!vMap[v.product_id]) vMap[v.product_id] = []; vMap[v.product_id].push(v) })
      setAddVariants(vMap)
      const sm = {}
      ;(sp || []).forEach(s => { sm[s.product_id] = s })
      setAddSpMap(sm)
    })
  }, [storeId])

  function closePicker() {
    setShowAddPicker(false)
    setAddSearch('')
    setAddPickerStep('product')
    setAddSelectedProd(null)
  }

  function pickProduct(prod, variant) {
    const basePrice = addSpMap[prod.id] ? Number(addSpMap[prod.id].shop_price) : 0
    const price = variant?.variant_price != null
      ? Number(variant.variant_price)
      : basePrice + (variant ? Number(variant.price_adjustment) || 0 : 0)
    const vLabel = variant
      ? Object.values(variant.options || {}).map(valId => addValueMap[valId]).filter(Boolean).join(' / ')
      : ''
    // 庫存上限：規格用 variant.stock，無規格用 product.quantity（從 addProducts 找）
    const stockLimit = variant
      ? (variant.stock ?? 999)
      : (addProducts.find(p => p.id === prod.id)?.quantity ?? 999)

    setItemStatuses(prev => {
      // 同商品 + 同規格已存在 → 合併（數量 +1，不超過庫存）
      const existing = prev.findIndex(it =>
        it.id === prod.id &&
        (it.variantId ?? null) === (variant?.id ?? null) &&
        !it._cancelled
      )
      if (existing !== -1) {
        return prev.map((it, idx) => idx === existing
          ? { ...it, qty: Math.min(it.qty + 1, it._stock ?? stockLimit) }
          : it
        )
      }
      return [...prev, {
        id: prod.id,
        name: prod.name,
        sku: prod.sku,
        variantId: variant?.id || null,
        variantLabel: vLabel || null,
        price,
        qty: 1,
        _cancelled: false,
        _added: true,
        _originalQty: 1,
        _stock: stockLimit,   // 供 + 按鈕用
      }]
    })
    closePicker()
  }

  function selectProdForVariant(prod) {
    const pvs = addVariants[prod.id]
    if (!pvs || pvs.length === 0) {
      pickProduct(prod, null)
    } else {
      setAddSelectedProd(prod)
      setAddPickerStep('variant')
    }
  }

  // 加購商品：手動輸入（自訂品項用）
  const [addItemName, setAddItemName] = useState('')
  const [addItemPrice, setAddItemPrice] = useState('')
  const [addItemQty, setAddItemQty] = useState(1)
  const [showManualAdd, setShowManualAdd] = useState(false)

  // 計算邏輯
  const activeItems = itemStatuses.filter(i => !i._cancelled)
  const cancelledItems = itemStatuses.filter(i => i._cancelled)
  const activeSubtotal = activeItems.reduce((sum, i) => sum + (Number(i.price) || 0) * (Number(i.qty) || 0), 0)
  const hasAnyCancel = cancelledItems.length > 0
  const hasQtyChange = activeItems.some(i => i.qty < i._originalQty)
  const hasAddedItems = itemStatuses.some(i => i._added)
  const hasAnyChange = hasAnyCancel || hasQtyChange || hasAddedItems
  const meetsThreshold = activeSubtotal >= FREE_SHIPPING_THRESHOLD
  const effectiveShippingFee = !hasAnyChange ? shippingFee : (meetsThreshold ? 0 : shippingFee)
  const newTotal = activeSubtotal + effectiveShippingFee

  const hasItems = itemStatuses.length > 0

  async function triggerStatusEmail({ activeItems, cancelledItems, shippingFee, newTotal, fulfillment_type, trackingNumber }) {
    try {
      const shopUrl = import.meta.env.VITE_SHOP_URL || 'http://localhost:3000'
      console.log(`[triggerStatusEmail] type=${fulfillment_type} email=${o.email} url=${shopUrl}/api/send-status-email`)
      const res = await fetch(`${shopUrl}/api/send-status-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order: {
            id: o.id,
            email: o.email,
            name: o.customer_name,
            phone: o.phone,
            address: o.address,
            note: o.note,
          },
          activeItems,
          cancelledItems,
          shippingFee,
          newTotal,
          fulfillment_type,
          trackingNumber,
          lang: 'zh',
          storeId,
        }),
      })
      console.log(`[triggerStatusEmail] response status=${res.status}`, await res.json().catch(() => ''))
    } catch (e) {
      console.error('[triggerStatusEmail] failed:', e)
    }
  }

  // Build email payload helper
  function buildEmailPayload(type) {
    const active = itemStatuses.filter(i => !i._cancelled)
    const cancelled = itemStatuses.filter(i => i._cancelled)
    const qtyReduced = active.some(i => i.qty < i._originalQty)

    let fulfillment_type = type
    if (type === 'shipped') {
      if (cancelled.length === 0 && !qtyReduced) fulfillment_type = 'full'
      else if (active.length > 0) fulfillment_type = 'partial'
      else fulfillment_type = 'cancelled'
    }

    const cleanItem = ({ _cancelled, _added, _originalQty, _stock, ...item }) => item
    // 全數取消時，所有品項（含未逐件標記的）都應出現在取消清單裡
    const cancelledForEmail = fulfillment_type === 'cancelled'
      ? itemStatuses.map(cleanItem)
      : cancelled.map(cleanItem)

    return {
      activeItems: fulfillment_type === 'cancelled'
        ? []
        : active.map(({ _cancelled, _added, _originalQty, _stock, ...item }) => ({
            ...item,
            ...(item.qty < _originalQty ? { note: `原訂 ${_originalQty}，到貨 ${item.qty}` } : {}),
          })),
      cancelledItems: cancelledForEmail,
      shippingFee: effectiveShippingFee,
      newTotal: activeItems.length > 0 && fulfillment_type !== 'cancelled' ? newTotal : 0,
      fulfillment_type,
      trackingNumber: trackingNumber || null,
    }
  }

  // Manual email triggers
  async function sendPaymentReceivedEmail() {
    if (!window.confirm('確定寄出「已收款」通知 Email 給消費者？')) return
    await triggerStatusEmail(buildEmailPayload('payment_received'))
    alert('已收款通知已寄出')
  }

  async function sendOrderModifiedEmail() {
    if (!window.confirm('確定寄出「訂單修改」通知 Email 給消費者？')) return
    await triggerStatusEmail(buildEmailPayload('order_modified'))
    alert('訂單修改通知已寄出')
  }

  async function save() {
    const active = itemStatuses.filter(i => !i._cancelled)
    const cancelled = itemStatuses.filter(i => i._cancelled)
    const qtyReduced = active.some(i => i.qty < i._originalQty)

    // ── 庫存驗證（僅加購品項）──
    const addedItems = active.filter(i => i._added && i.id)
    if (addedItems.length > 0) {
      setSaving(true)

      // 分為有規格、無規格兩批查詢
      const withVariant = addedItems.filter(i => i.variantId)
      const noVariant   = addedItems.filter(i => !i.variantId)

      const checks = await Promise.all([
        withVariant.length > 0
          ? supabase.from('product_variants').select('id, stock').in('id', withVariant.map(i => i.variantId))
          : Promise.resolve({ data: [] }),
        noVariant.length > 0
          ? supabase.from('products').select('id, name, quantity').in('id', noVariant.map(i => i.id))
          : Promise.resolve({ data: [] }),
      ])

      const variantStockMap = Object.fromEntries((checks[0].data || []).map(v => [v.id, v.stock]))
      const productStockMap = Object.fromEntries((checks[1].data || []).map(p => [p.id, { name: p.name, stock: p.quantity }]))

      const failed = []
      for (const item of withVariant) {
        const stock = variantStockMap[item.variantId] ?? 0
        if (item.qty > stock) failed.push(`${item.name}（${item.variantLabel || '無規格'}）：需要 ${item.qty} 件，庫存剩 ${stock} 件`)
      }
      for (const item of noVariant) {
        const stock = productStockMap[item.id]?.stock ?? 0
        if (item.qty > stock) failed.push(`${item.name}：需要 ${item.qty} 件，庫存剩 ${stock} 件`)
      }

      if (failed.length > 0) {
        alert('加購商品庫存不足，無法儲存：\n\n' + failed.join('\n'))
        setSaving(false)
        return
      }
    }

    setSaving(true)

    // 判斷 fulfillment_type
    let fulfillment_type = o.fulfillment_type || null
    if (status === '已出貨') {
      if (cancelled.length === 0 && !qtyReduced) fulfillment_type = 'full'
      else if (active.length > 0) fulfillment_type = 'partial'
      else fulfillment_type = 'cancelled'
    } else if (status === '已取消') {
      fulfillment_type = 'cancelled'
    }

    const updatedTotal = active.length > 0 ? newTotal : 0

    const updatedItemsJson = itemStatuses.map(({ _cancelled, _added, _originalQty, _stock, ...item }) => ({
      ...item,
      originalQty: _originalQty,
      status: _cancelled ? 'cancelled' : 'active',
    }))

    await supabase.from('consumer_orders').update({
      status,
      payment_status: payStatus,
      items_json: updatedItemsJson,
      shipping_fee: effectiveShippingFee,
      total_amount: updatedTotal,
      fulfillment_type,
      tracking_number: trackingNumber || null,
    }).eq('id', o.id)

    // 半自動出貨通知：已收款 + 狀態改為已出貨 → 詢問是否寄出貨通知
    if (status === '已出貨' && payStatus === '已付清') {
      if (window.confirm('訂單已標記為「已出貨」且「已收款」，是否寄出出貨通知 Email 給消費者？')) {
        await triggerStatusEmail(buildEmailPayload('shipped'))
      }
    }

    // 全數取消 → 自動退還優惠券 + 詢問寄信
    if (status === '已取消') {
      if (o.coupon_id) {
        await supabase.rpc('refund_coupon', { p_order_id: o.id })
      }
      if (window.confirm('訂單已標記為「已取消」，是否寄出取消通知 Email 給消��者？')) {
        await triggerStatusEmail(buildEmailPayload('cancelled'))
      }
    }

    setSaving(false)
    onSaved()
    onClose()
  }

  return (
    <Sheet title={`${o.customer_name} 的訂單`} onClose={onClose}>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-row row-sb">
          <span className="muted fs13">訂單編號</span>
          <span className="fw600 fs13">#{o.id?.toString().slice(-6)}</span>
        </div>
        <div className="card-row row-sb">
          <span className="muted fs13">下單時間</span>
          <span className="fs13">{new Date(o.created_at).toLocaleString('zh-TW')}</span>
        </div>
        <div className="card-row row-sb">
          <span className="muted fs13">{o.coupon_id && Number(o.discount_amount) > 0 ? '折扣前金額' : '總金額'}</span>
          <span className="fw600">NT${Number(hasAnyChange ? newTotal : (o.total_amount || 0)).toLocaleString()}</span>
        </div>
        {o.coupon_id && Number(o.discount_amount) > 0 && (
          <>
            <div className="card-row row-sb">
              <span className="muted fs13">優惠券折抵</span>
              <span className="fs13" style={{ color: 'var(--green)' }}>-NT${Number(o.discount_amount || 0).toLocaleString()}</span>
            </div>
            <div className="card-row row-sb" style={{ borderTop: '0.5px solid var(--border)', marginTop: 4, paddingTop: 8 }}>
              <span className="fw600 fs13">實付金額</span>
              <span className="fw600">NT${(Number(hasAnyChange ? newTotal : (o.total_amount || 0)) - Number(o.discount_amount || 0)).toLocaleString()}</span>
            </div>
          </>
        )}
      </div>

      {/* 優惠券退還提示 */}
      {o.coupon_id && canEdit && hasAnyChange && activeSubtotal < (couponMinAmount || 0) && (
        <div style={{
          background: 'var(--amber-bg)', borderRadius: 12, padding: '12px 16px', marginBottom: 12,
          fontSize: 13, color: 'var(--amber)', lineHeight: 1.6,
        }}>
          ⚠️ 修改後小計 NT${activeSubtotal.toLocaleString()} 未達此優惠券門檻，建議退還優惠券
        </div>
      )}

      {o.coupon_id && canEdit && (
        <button
          onClick={handleRefundCoupon}
          disabled={refundingCoupon}
          style={{
            width: '100%', padding: 10, marginBottom: 12,
            background: 'none', border: '1px solid var(--amber)',
            borderRadius: 10, color: 'var(--amber)', fontSize: 13,
            fontWeight: 600, cursor: 'pointer',
          }}
        >{refundingCoupon ? '退還中…' : `退還優惠券（折抵 NT$${Number(o.discount_amount || 0).toLocaleString()}）`}</button>
      )}

      <div className="sec" style={{ marginTop: 0 }}>聯絡資訊</div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-row row-sb">
          <span className="muted fs13">姓名</span><span className="fs13">{o.customer_name}</span>
        </div>
        <div className="card-row row-sb">
          <span className="muted fs13">電話</span><span className="fs13">{o.phone}</span>
        </div>
        <div className="card-row row-sb">
          <span className="muted fs13">Email</span><span className="fs13">{o.email}</span>
        </div>
        {o.line_id && (
          <div className="card-row row-sb">
            <span className="muted fs13">LINE</span><span className="fs13">{o.line_id}</span>
          </div>
        )}
        {(o.store_name || o.store_number) ? (
          <div className="card-row row-sb">
            <span className="muted fs13">取貨門市</span>
            <span className="fs13">{o.store_name}{o.store_number ? ` (${o.store_number})` : ''}</span>
          </div>
        ) : o.address ? (
          <div className="card-row row-sb">
            <span className="muted fs13">地址</span><span className="fs13" style={{ textAlign: 'right', maxWidth: '65%' }}>{o.address}</span>
          </div>
        ) : null}
        {o.remittance_last5 && (
          <div className="card-row row-sb">
            <span className="muted fs13">匯款末五碼</span><span className="fw600 fs13">{o.remittance_last5}</span>
          </div>
        )}
        {o.note && (
          <div className="card-row"><span className="muted fs13">備註：{o.note}</span></div>
        )}
      </div>

      <div className="sec" style={{ marginTop: 0 }}>訂購商品</div>
      <div className="card" style={{ marginBottom: 16 }}>
        {hasItems ? itemStatuses.map((item, i) => (
          <div key={i} className="card-row" style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
            opacity: item._cancelled ? 0.4 : 1,
            background: item._cancelled ? '#fff5f5' : undefined,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="fs13 fw600" style={{
                textDecoration: item._cancelled ? 'line-through' : 'none',
              }}>
                {item.name}
                {item._added && <span style={{ fontSize: 10, color: 'var(--blue)', marginLeft: 4 }}>(加購)</span>}
              </div>
              {(item.variantLabel || item.color || item.size) && (
                <div className="muted fs12">{item.variantLabel || [item.color, item.size].filter(Boolean).join(' / ')}</div>
              )}
              {item.customNote && <div className="muted fs12">備註：{item.customNote}</div>}
              {item._cancelled && (
                <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 2 }}>✕ 缺貨取消</div>
              )}
            </div>
            <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0, marginLeft: 8 }}>
              {/* 數量：可編輯時顯示調整器，否則僅顯示 */}
              {canEdit && !item._cancelled ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <button style={{
                    width: 22, height: 22, borderRadius: 6, border: '1px solid var(--border)',
                    background: 'var(--bg)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0,
                  }} onClick={() => setItemStatuses(prev => prev.map((it, idx) =>
                    idx === i ? { ...it, qty: Math.max(1, it.qty - 1) } : it
                  ))}>-</button>
                  <span className="fs13 fw600" style={{ minWidth: 20, textAlign: 'center' }}>{item.qty}</span>
                  <button style={{
                    width: 22, height: 22, borderRadius: 6, border: '1px solid var(--border)',
                    background: 'var(--bg)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0,
                  }} onClick={() => setItemStatuses(prev => prev.map((it, idx) => {
                    if (idx !== i) return it
                    // 加購品項上限 = 庫存（_stock）；原始品項上限 = 原訂數量
                    const max = it._added ? (it._stock ?? 999) : it._originalQty
                    return { ...it, qty: Math.min(max, it.qty + 1) }
                  }))}>+</button>
                </div>
              ) : (
                <div className="fs13">× {item.qty}</div>
              )}
              <div className="muted fs12">NT${((Number(item.price) || 0) * (Number(item.qty) || 0)).toLocaleString()}</div>
              {/* 加購品項數量接近庫存時提示 */}
              {item._added && item._stock != null && item.qty >= item._stock && (
                <div style={{ fontSize: 10, color: 'var(--amber)' }}>已達庫存上限（{item._stock} 件）</div>
              )}
              {/* 原始品項數量被調低時提示 */}
              {!item._added && !item._cancelled && item.qty < item._originalQty && (
                <div style={{ fontSize: 10, color: 'var(--amber)' }}>原訂 {item._originalQty}，到貨 {item.qty}</div>
              )}
              {canEdit && (
                <button
                  style={{
                    fontSize: 11, padding: '2px 8px', borderRadius: 6, border: 'none', cursor: 'pointer',
                    background: item._cancelled ? 'var(--green)' : 'var(--red)',
                    color: '#fff',
                  }}
                  onClick={() => setItemStatuses(prev => prev.map((it, idx) =>
                    idx === i ? { ...it, _cancelled: !it._cancelled, qty: it._cancelled ? it._originalQty : it.qty } : it
                  ))}
                >
                  {item._cancelled ? '恢復' : '缺貨取消'}
                </button>
              )}
            </div>
          </div>
        )) : (
          <div className="card-row"><span className="fs13">{o.items}</span></div>
        )}
      </div>

      {/* 加購商品區塊 */}
      {canEdit && activeItems.length > 0 && (
        <>
          <div className="sec" style={{ marginTop: 0 }}>加購商品（選填）</div>

          {/* 商品庫選擇器：兩步驟 */}
          {!showAddPicker ? (
            <button style={{
              width: '100%', padding: '10px 0', borderRadius: 10,
              border: '1px dashed var(--border)', background: 'none', cursor: 'pointer',
              fontSize: 13, color: 'var(--text-2)', marginBottom: 8,
            }} onClick={() => { setShowAddPicker(true); setAddPickerStep('product') }}>
              + 從商品庫選擇
            </button>
          ) : (
            <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 10, marginBottom: 8, background: 'var(--surface)' }}>

              {/* Step 1：選商品 */}
              {addPickerStep === 'product' && (<>
                <input
                  className="form-input"
                  placeholder="搜尋商品名稱或 SKU…"
                  value={addSearch}
                  onChange={e => setAddSearch(e.target.value)}
                  autoFocus
                  style={{ marginBottom: 8 }}
                />
                <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                  {(() => {
                    const filtered = addProducts.filter(p =>
                      !addSearch || p.name.toLowerCase().includes(addSearch.toLowerCase()) || (p.sku || '').toLowerCase().includes(addSearch.toLowerCase())
                    )
                    if (filtered.length === 0) return <div className="muted fs12" style={{ padding: 10 }}>找不到商品</div>
                    return filtered.slice(0, 30).map(p => {
                      const pvs = addVariants[p.id]
                      const basePrice = addSpMap[p.id] ? Number(addSpMap[p.id].shop_price) : 0
                      const hasVariants = pvs && pvs.length > 0
                      return (
                        <div key={p.id} onClick={() => selectProdForVariant(p)}
                          style={{ padding: '9px 10px', cursor: 'pointer', borderRadius: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--bg)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        >
                          <div>
                            <div className="fs13 fw600">{p.name}</div>
                            <div className="muted fs12">
                              {hasVariants ? `${pvs.length} 種規格` : (basePrice > 0 ? `NT$${basePrice.toLocaleString()}` : '未定價')}
                              {p.sku ? ` · ${p.sku}` : ''}
                            </div>
                          </div>
                          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{hasVariants ? '▶' : ''}</span>
                        </div>
                      )
                    })
                  })()}
                </div>
              </>)}

              {/* Step 2：選規格 */}
              {addPickerStep === 'variant' && addSelectedProd && (<>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <button onClick={() => { setAddPickerStep('product'); setAddSelectedProd(null) }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: 'var(--text-3)', padding: 0, lineHeight: 1 }}>←</button>
                  <div>
                    <div className="fs13 fw600">{addSelectedProd.name}</div>
                    <div className="muted fs12">選擇規格</div>
                  </div>
                </div>
                <div style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {(addVariants[addSelectedProd.id] || []).map(v => {
                    const vLabel = Object.values(v.options || {}).map(valId => addValueMap[valId]).filter(Boolean).join(' / ')
                    const basePrice = addSpMap[addSelectedProd.id] ? Number(addSpMap[addSelectedProd.id].shop_price) : 0
                    const vPrice = v.variant_price != null ? Number(v.variant_price) : basePrice + (Number(v.price_adjustment) || 0)
                    const inStock = (v.stock ?? 0) > 0
                    return (
                      <div key={v.id} onClick={() => inStock ? pickProduct(addSelectedProd, v) : undefined}
                        style={{
                          padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)',
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          cursor: inStock ? 'pointer' : 'default',
                          opacity: inStock ? 1 : 0.4,
                          background: 'var(--bg)',
                        }}
                        onMouseEnter={e => { if (inStock) e.currentTarget.style.borderColor = 'var(--text)' }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
                      >
                        <div>
                          <div className="fs13 fw600">{vLabel || '（無規格標籤）'}</div>
                          <div className="muted fs12">庫存 {v.stock ?? 0} 件{!inStock ? ' · 缺貨' : ''}</div>
                        </div>
                        <span className="fs13 fw600">NT${vPrice.toLocaleString()}</span>
                      </div>
                    )
                  })}
                </div>
              </>)}

              <button style={{
                marginTop: 8, width: '100%', padding: '6px 0', borderRadius: 8,
                border: 'none', background: 'var(--bg)', cursor: 'pointer', fontSize: 13, color: 'var(--text-2)',
              }} onClick={closePicker}>取消</button>
            </div>
          )}

          {/* 手動輸入自訂品項（運費補差額、特殊費用等） */}
          <button style={{
            width: '100%', padding: '7px 0', borderRadius: 10, marginBottom: 8,
            border: '1px dashed var(--border)', background: 'none', cursor: 'pointer',
            fontSize: 12, color: 'var(--text-3)',
          }} onClick={() => setShowManualAdd(v => !v)}>
            {showManualAdd ? '▲ 收起手動輸入' : '▼ 手動輸入自訂品項（運費補差額等）'}
          </button>
          {showManualAdd && (
            <div className="card" style={{ marginBottom: 16, padding: 12 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8 }}>
                <input className="form-input" placeholder="品項名稱" value={addItemName}
                  onChange={e => setAddItemName(e.target.value)} style={{ fontSize: 13 }} />
                <input className="form-input" type="number" placeholder="單價" value={addItemPrice}
                  onChange={e => setAddItemPrice(e.target.value)} style={{ fontSize: 13 }} />
                <input className="form-input" type="number" min={1} placeholder="數量" value={addItemQty}
                  onChange={e => setAddItemQty(Number(e.target.value))} style={{ fontSize: 13 }} />
              </div>
              <button style={{
                marginTop: 8, width: '100%', padding: '6px 0', borderRadius: 8,
                border: '1px dashed var(--border)', background: 'none', cursor: 'pointer',
                fontSize: 13, color: 'var(--text-2)',
              }} onClick={() => {
                if (!addItemName || !addItemPrice) return
                setItemStatuses(prev => [...prev, {
                  name: addItemName,
                  price: Number(addItemPrice),
                  qty: addItemQty || 1,
                  _cancelled: false,
                  _added: true,
                  _originalQty: addItemQty || 1,
                }])
                setAddItemName('')
                setAddItemPrice('')
                setAddItemQty(1)
              }}>
                + 加入訂單
              </button>
            </div>
          )}
        </>
      )}

      {/* 免運門檻提示 */}
      {canEdit && hasAnyChange && activeItems.length > 0 && (
        <div style={{
          background: meetsThreshold ? '#f0fff4' : '#fff8e8',
          borderRadius: 12, padding: '14px 16px', marginBottom: 16,
          fontSize: 13, lineHeight: 1.6,
          color: meetsThreshold ? '#1a7a3a' : '#8a5c00',
        }}>
          {meetsThreshold
            ? `✅ 有貨商品小計 NT$${activeSubtotal.toLocaleString()}，符合免運門檻（NT$${FREE_SHIPPING_THRESHOLD.toLocaleString()}），運費 NT$0`
            : `⚠️ 有貨商品小計 NT$${activeSubtotal.toLocaleString()}，未達免運門檻（NT$${FREE_SHIPPING_THRESHOLD.toLocaleString()}）。請透過 Line / Email 聯繫消費者確認後，再更新運費或加購商品。`
          }
          {!meetsThreshold && (
            <div style={{ marginTop: 10 }}>
              <label className="form-label fs12">運費（NT$）</label>
              <input className="form-input" type="number" min={0} value={shippingFee}
                onChange={e => setShippingFee(Number(e.target.value))} style={{ fontSize: 13 }} />
            </div>
          )}
        </div>
      )}

      {/* 更新後金額摘要 */}
      {hasAnyChange && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-row row-sb">
            <span className="muted fs13">有貨商品小計</span>
            <span className="fs13">NT${activeSubtotal.toLocaleString()}</span>
          </div>
          {effectiveShippingFee > 0 && (
            <div className="card-row row-sb">
              <span className="muted fs13">運費</span>
              <span className="fs13">NT${effectiveShippingFee.toLocaleString()}</span>
            </div>
          )}
          {cancelledItems.length > 0 && (
            <div className="card-row row-sb">
              <span className="muted fs13" style={{ color: 'var(--red)' }}>取消商品（{cancelledItems.length} 件）</span>
              <span className="fs13" style={{ color: 'var(--red)', textDecoration: 'line-through' }}>
                -NT${cancelledItems.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.qty) || 0), 0).toLocaleString()}
              </span>
            </div>
          )}
          {o.coupon_id && Number(o.discount_amount) > 0 && (
            <div className="card-row row-sb">
              <span className="muted fs13" style={{ color: 'var(--green)' }}>優惠券折抵</span>
              <span className="fs13" style={{ color: 'var(--green)' }}>-NT${Number(o.discount_amount).toLocaleString()}</span>
            </div>
          )}
          <div className="card-row row-sb" style={{ borderTop: '1.5px solid var(--text)', paddingTop: 10 }}>
            <span className="fw600 fs13">更新後總金額</span>
            <span className="fw600">NT${newTotal.toLocaleString()}</span>
          </div>
        </div>
      )}

      {canEdit && (
        <>
          <div className="sec" style={{ marginTop: 0 }}>更新狀態</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
            <div>
              <label className="form-label fs12">訂單狀態</label>
              <CustomSelect
                label={status}
                value={status}
                options={['待確認', '處理中', '已購買', '已出貨', '完成', '已取消'].map(s => ({ value: s, label: s }))}
                onChange={v => v && setStatus(v)}
                allowClear={false}
              />
            </div>
            <div>
              <label className="form-label fs12">付款狀態</label>
              <CustomSelect
                label={payStatus}
                value={payStatus}
                options={['未付', '已付清'].map(s => ({ value: s, label: s }))}
                onChange={v => v && setPayStatus(v)}
                allowClear={false}
              />
            </div>
          </div>
          {(status === '已出貨' || status === '完成') && (
            <div style={{ marginBottom: 14 }}>
              <label className="form-label fs12">物流單號（選填）</label>
              <input className="form-input" placeholder="輸入物流追蹤單號" value={trackingNumber}
                onChange={e => setTrackingNumber(e.target.value)} style={{ fontSize: 13 }} />
            </div>
          )}
          <button className="btn" onClick={save} disabled={saving}>{saving ? '更新中…' : '儲存'}</button>

          {/* 手動寄信區塊 */}
          <div className="sec" style={{ marginTop: 20 }}>手動寄送通知</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              onClick={sendPaymentReceivedEmail}
              style={{ ...notifyBtn, background: '#e8f7ee', color: '#1a7a3a', border: '0.5px solid #c5e8d2' }}
            >
              ✉️ 寄出已收款通知
            </button>
            <button
              onClick={sendOrderModifiedEmail}
              style={{ ...notifyBtn, background: '#fff8e8', color: '#8a5c00', border: '0.5px solid #f0ddb0' }}
            >
              ✉️ 寄出訂單修改通知
            </button>
          </div>
          <div className="muted fs12" style={{ marginTop: 6 }}>
            出貨通知會在儲存時自動詢問（需已收款 + 狀態為已出貨）
          </div>
        </>
      )}
    </Sheet>
  )
}

function AddOrderSheet({ onClose, onSaved }) {
  const { storeId } = useAuth()
  const [form, setForm] = useState({ customer: '', phone: '', email: '', address: '', line_id: '', deposit: '0', note: '' })
  const [saving, setSaving] = useState(false)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  // 商品選擇
  const [products, setProducts] = useState([])
  const [variants, setVariants] = useState({}) // productId → [variants]
  const [spMap, setSpMap] = useState({}) // productId → storefront_product
  const [valueMap, setValueMap] = useState({}) // option_value_id → value string
  const [search, setSearch] = useState('')
  const [selectedItems, setSelectedItems] = useState([]) // [{ id, name, price, qty, variantId, variantLabel }]
  const [showPicker, setShowPicker] = useState(false)

  useEffect(() => {
    if (!storeId) return
    async function load() {
      const [{ data: prods }, { data: vars }, { data: sp }, { data: vals }] = await Promise.all([
        supabase.from('products').select('id, name, sku, source').eq('store_id', storeId),
        supabase.from('product_variants').select('*'),
        supabase.from('storefront_products').select('product_id, shop_price').eq('store_id', storeId),
        supabase.from('variant_option_values').select('id, value'),
      ])
      setProducts(prods || [])
      const vMap = {}
      ;(vars || []).forEach(v => {
        if (!vMap[v.product_id]) vMap[v.product_id] = []
        vMap[v.product_id].push(v)
      })
      setVariants(vMap)
      const sm = {}
      ;(sp || []).forEach(s => { sm[s.product_id] = s })
      setSpMap(sm)
      const vm = {}
      ;(vals || []).forEach(v => { vm[v.id] = v.value })
      setValueMap(vm)
    }
    load()
  }, [storeId])

  function buildVariantLabel(variant) {
    return Object.values(variant.options || {}).map(valId => valueMap[valId]).filter(Boolean).join(' / ')
  }

  function addProduct(prod, variant) {
    const basePrice = spMap[prod.id] ? Number(spMap[prod.id].shop_price) : 0
    const price = variant?.variant_price != null
      ? Number(variant.variant_price)
      : basePrice + (variant ? Number(variant.price_adjustment) || 0 : 0)
    const vLabel = variant ? buildVariantLabel(variant) : ''
    const key = `${prod.id}-${variant?.id || ''}`
    setSelectedItems(prev => {
      const existing = prev.find(i => i._key === key)
      if (existing) return prev.map(i => i._key === key ? { ...i, qty: i.qty + 1 } : i)
      return [...prev, { _key: key, id: prod.id, name: prod.name, price, qty: 1, variantId: variant?.id, variantLabel: vLabel || null }]
    })
    setShowPicker(false)
    setSearch('')
  }

  const total = selectedItems.reduce((s, i) => s + i.price * i.qty, 0)

  async function save() {
    if (!form.customer || selectedItems.length === 0) return
    setSaving(true)
    const deposit = Number(form.deposit) || 0
    const payStatus = total > 0 && deposit >= total ? '已付清' : deposit > 0 ? '已付訂金' : '未付'
    const itemsStr = selectedItems.map(i =>
      `${i.name}${i.variantLabel ? ' ' + i.variantLabel : ''} × ${i.qty}`
    ).join(', ')
    const itemsJson = selectedItems.map(({ _key, ...rest }) => rest)

    await supabase.from('orders').insert({
      store_id: storeId,
      customer: form.customer,
      items: itemsStr,
      deposit,
      total_amount: total || null,
      payment_status: payStatus,
      note: form.note,
    })

    // 同時建立 consumer_orders 以便採購彙整計算
    await supabase.from('consumer_orders').insert({
      store_id: storeId,
      customer_name: form.customer,
      phone: form.phone || null,
      email: form.email || null,
      address: form.address || null,
      line_id: form.line_id || null,
      items: itemsStr,
      items_json: itemsJson,
      total_amount: total || null,
      payment_status: payStatus === '已付清' ? '已付清' : '未付',
      status: '待確認',
      note: form.note,
    })

    setSaving(false)
    onSaved()
    onClose()
  }

  const filtered = products.filter(p =>
    !search || p.name.toLowerCase().includes(search.toLowerCase()) || p.sku.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <Sheet title="新增訂單" onClose={onClose}>
      {/* 客戶資訊 */}
      <div className="sec" style={{ marginTop: 0 }}>客戶資訊</div>
      <div className="form-group">
        <label className="form-label">客戶名稱 *</label>
        <input className="form-input" placeholder="例：王小明" value={form.customer} onChange={e => set('customer', e.target.value)} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div className="form-group">
          <label className="form-label">電話</label>
          <input className="form-input" type="tel" placeholder="選填" value={form.phone} onChange={e => set('phone', e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">LINE ID</label>
          <input className="form-input" placeholder="選填" value={form.line_id} onChange={e => set('line_id', e.target.value)} />
        </div>
      </div>
      <div className="form-group">
        <label className="form-label">Email</label>
        <input className="form-input" type="email" placeholder="選填" value={form.email} onChange={e => set('email', e.target.value)} />
      </div>
      <div className="form-group">
        <label className="form-label">地址</label>
        <input className="form-input" placeholder="選填" value={form.address} onChange={e => set('address', e.target.value)} />
      </div>

      {/* 商品選擇 */}
      <div className="sec">訂購商品 *</div>
      {selectedItems.map((item, i) => (
        <div key={item._key} className="card" style={{ marginBottom: 6 }}>
          <div className="card-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="fs13 fw600">{item.name}</div>
              {item.variantLabel && <div className="muted fs12">{item.variantLabel}</div>}
              <div className="muted fs12">NT${item.price.toLocaleString()}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button style={{
                width: 24, height: 24, borderRadius: 6, border: '1px solid var(--border)',
                background: 'var(--bg)', cursor: 'pointer', fontSize: 14, padding: 0,
              }} onClick={() => setSelectedItems(prev =>
                prev.map((it, idx) => idx === i ? { ...it, qty: Math.max(1, it.qty - 1) } : it)
              )}>-</button>
              <span className="fs13 fw600" style={{ minWidth: 20, textAlign: 'center' }}>{item.qty}</span>
              <button style={{
                width: 24, height: 24, borderRadius: 6, border: '1px solid var(--border)',
                background: 'var(--bg)', cursor: 'pointer', fontSize: 14, padding: 0,
              }} onClick={() => setSelectedItems(prev =>
                prev.map((it, idx) => idx === i ? { ...it, qty: it.qty + 1 } : it)
              )}>+</button>
              <button style={{
                fontSize: 11, padding: '2px 8px', borderRadius: 6, border: 'none',
                background: 'var(--red)', color: '#fff', cursor: 'pointer', marginLeft: 4,
              }} onClick={() => setSelectedItems(prev => prev.filter((_, idx) => idx !== i))}>移除</button>
            </div>
          </div>
        </div>
      ))}

      {/* 加商品按鈕 / 搜尋選擇器 */}
      {!showPicker ? (
        <button style={{
          width: '100%', padding: '10px 0', borderRadius: 10,
          border: '1px dashed var(--border)', background: 'none', cursor: 'pointer',
          fontSize: 14, color: 'var(--text-2)', marginBottom: 16,
        }} onClick={() => setShowPicker(true)}>
          + 新增商品
        </button>
      ) : (
        <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 10, marginBottom: 16, background: 'var(--card)' }}>
          <input
            className="form-input"
            placeholder="搜尋商品名稱或 SKU…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            autoFocus
            style={{ marginBottom: 8 }}
          />
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            {filtered.slice(0, 20).map(p => {
              const pvs = variants[p.id]
              const basePrice = spMap[p.id] ? Number(spMap[p.id].shop_price) : 0
              if (pvs && pvs.length > 0) {
                return pvs.map(v => {
                  const vLabel = buildVariantLabel(v)
                  const vPrice = v.variant_price != null ? Number(v.variant_price) : basePrice + (Number(v.price_adjustment) || 0)
                  return (
                    <div key={`${p.id}-${v.id}`} onClick={() => addProduct(p, v)}
                      style={{ padding: '8px 10px', cursor: 'pointer', borderRadius: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--surface)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <div>
                        <div className="fs13 fw600">{p.name}</div>
                        <div className="muted fs12">{vLabel || '—'}{p.sku ? ` · ${p.sku}` : ''}</div>
                      </div>
                      <span className="fs13">NT${vPrice.toLocaleString()}</span>
                    </div>
                  )
                })
              }
              return (
                <div key={p.id} onClick={() => addProduct(p, null)}
                  style={{ padding: '8px 10px', cursor: 'pointer', borderRadius: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--surface)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <div>
                    <div className="fs13 fw600">{p.name}</div>
                    <div className="muted fs12">{p.sku}</div>
                  </div>
                  <span className="fs13">{basePrice > 0 ? `NT$${basePrice.toLocaleString()}` : '未定價'}</span>
                </div>
              )
            })}
            {filtered.length === 0 && <div className="muted fs12" style={{ padding: 10 }}>找不到商品</div>}
          </div>
          <button style={{
            marginTop: 6, width: '100%', padding: '6px 0', borderRadius: 8,
            border: 'none', background: 'var(--surface)', cursor: 'pointer', fontSize: 13, color: 'var(--text-2)',
          }} onClick={() => { setShowPicker(false); setSearch('') }}>取消</button>
        </div>
      )}

      {/* 金額 */}
      {selectedItems.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-row row-sb">
            <span className="muted fs13">商品小計</span>
            <span className="fw600">NT${total.toLocaleString()}</span>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div className="form-group">
          <label className="form-label">訂金（NT$）</label>
          <input className="form-input" type="number" placeholder="0" value={form.deposit} onChange={e => set('deposit', e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">備註</label>
          <input className="form-input" placeholder="選填" value={form.note} onChange={e => set('note', e.target.value)} />
        </div>
      </div>

      <button className="btn" onClick={save} disabled={saving} style={{ marginTop: 8 }}>
        {saving ? '儲存中…' : `建立訂單${total > 0 ? ` · NT$${total.toLocaleString()}` : ''}`}
      </button>
    </Sheet>
  )
}

function OrderDetailSheet({ order, onClose, onSaved, canEdit }) {
  const [payment, setPayment] = useState('')
  const [note, setNote] = useState('')
  const [orderStatus, setOrderStatus] = useState(order.status || '處理中')
  const [saving, setSaving] = useState(false)

  // 加購商品
  const [addedItems, setAddedItems] = useState([])
  const [addItemName, setAddItemName] = useState('')
  const [addItemPrice, setAddItemPrice] = useState('')
  const [addItemQty, setAddItemQty] = useState(1)

  const isCancelled = orderStatus === '已取消'
  const addedSubtotal = addedItems.reduce((sum, i) => sum + i.price * i.qty, 0)
  const updatedTotal = (Number(order.total_amount) || 0) + addedSubtotal

  async function addPayment() {
    if (!payment) return
    setSaving(true)
    const paid = (Number(order.deposit) || 0) + Number(payment)
    const total = Number(order.total_amount) || 0
    const payStatus = total > 0 && paid >= total ? '已付清' : '已付訂金'
    await supabase.from('orders').update({
      deposit: paid,
      payment_status: payStatus,
      note: note || order.note,
    }).eq('id', order.id)
    setSaving(false)
    onSaved()
    onClose()
  }

  async function saveStatus() {
    if (orderStatus === '已取消' && !window.confirm('確定要取消此訂單？取消後可在「已取消」區塊查看。')) return
    setSaving(true)
    const updates = { status: orderStatus }
    // 如果有加購商品，一併更新 items 和 total_amount
    if (addedItems.length > 0) {
      const addedText = addedItems.map(i => `${i.name} x${i.qty}`).join('、')
      updates.items = order.items ? `${order.items}、${addedText}` : addedText
      updates.total_amount = updatedTotal
    }
    await supabase.from('orders').update(updates).eq('id', order.id)
    setSaving(false)
    onSaved()
    onClose()
  }

  async function saveAddedItems() {
    if (addedItems.length === 0) return
    setSaving(true)
    const addedText = addedItems.map(i => `${i.name} x${i.qty}`).join('、')
    await supabase.from('orders').update({
      items: order.items ? `${order.items}、${addedText}` : addedText,
      total_amount: updatedTotal,
    }).eq('id', order.id)
    setSaving(false)
    onSaved()
    onClose()
  }

  const balance = (Number(order.total_amount) || 0) - (Number(order.deposit) || 0)
  const statusChanged = orderStatus !== (order.status || '處理中')

  return (
    <Sheet title={order.customer} onClose={onClose}>
      <div className="card" style={{marginBottom:16}}>
        <div className="card-row row-sb">
          <span className="muted fs13">訂單編號</span>
          <span className="fw600 fs13">#{order.id?.toString().slice(-6)}</span>
        </div>
        <div className="card-row row-sb">
          <span className="muted fs13">商品</span>
          <span className="fs13">{order.items}</span>
        </div>
        <div className="card-row row-sb">
          <span className="muted fs13">應付總額</span>
          <span className="fw600">{addedItems.length > 0
            ? `NT$${updatedTotal.toLocaleString()}`
            : (order.total_amount ? `NT$${Number(order.total_amount).toLocaleString()}` : '未設定')
          }</span>
        </div>
        <div className="card-row row-sb">
          <span className="muted fs13">已付金額</span>
          <span className="fw600 text-green">NT${(Number(order.deposit)||0).toLocaleString()}</span>
        </div>
        {balance > 0 && (
          <div className="card-row row-sb">
            <span className="muted fs13">尾款</span>
            <span className="fw600 text-red">NT${balance.toLocaleString()}</span>
          </div>
        )}
        <div className="card-row row-sb">
          <span className="muted fs13">付款狀態</span>
          {statusBadge(order.payment_status)}
        </div>
        <div className="card-row row-sb">
          <span className="muted fs13">訂單狀態</span>
          {orderStatusBadge(order.status || '處理中')}
        </div>
        {order.note && (
          <div className="card-row"><span className="muted fs13">備註：{order.note}</span></div>
        )}
      </div>

      {/* 加購商品區塊 */}
      {canEdit && !isCancelled && (
        <>
          <div className="sec" style={{ marginTop: 0 }}>加購商品</div>
          <div className="card" style={{ marginBottom: 16, padding: 12 }}>
            {addedItems.length > 0 && addedItems.map((item, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '0.5px solid var(--border)' }}>
                <div>
                  <span className="fs13 fw600">{item.name}</span>
                  <span className="muted fs12" style={{ marginLeft: 6 }}>× {item.qty}</span>
                  <span style={{ fontSize: 10, color: 'var(--blue)', marginLeft: 4 }}>(加購)</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="muted fs12">NT${(item.price * item.qty).toLocaleString()}</span>
                  <button onClick={() => setAddedItems(prev => prev.filter((_, idx) => idx !== i))} style={{
                    fontSize: 11, padding: '2px 8px', borderRadius: 6, border: 'none', cursor: 'pointer',
                    background: 'var(--red)', color: '#fff',
                  }}>移除</button>
                </div>
              </div>
            ))}
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8, marginTop: addedItems.length > 0 ? 8 : 0 }}>
              <input className="form-input" placeholder="商品名稱" value={addItemName}
                onChange={e => setAddItemName(e.target.value)} style={{ fontSize: 13 }} />
              <input className="form-input" type="number" placeholder="單價" value={addItemPrice}
                onChange={e => setAddItemPrice(e.target.value)} style={{ fontSize: 13 }} />
              <input className="form-input" type="number" min={1} placeholder="數量" value={addItemQty}
                onChange={e => setAddItemQty(Number(e.target.value))} style={{ fontSize: 13 }} />
            </div>
            <button style={{
              marginTop: 8, width: '100%', padding: '6px 0', borderRadius: 8,
              border: '1px dashed var(--border)', background: 'none', cursor: 'pointer',
              fontSize: 13, color: 'var(--text-2)',
            }} onClick={() => {
              if (!addItemName || !addItemPrice) return
              setAddedItems(prev => [...prev, { name: addItemName, price: Number(addItemPrice), qty: addItemQty || 1 }])
              setAddItemName('')
              setAddItemPrice('')
              setAddItemQty(1)
            }}>
              + 加入訂單
            </button>
          </div>
          {addedItems.length > 0 && (
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-row row-sb">
                <span className="muted fs13">原訂單金額</span>
                <span className="fs13">NT${Number(order.total_amount || 0).toLocaleString()}</span>
              </div>
              <div className="card-row row-sb">
                <span className="muted fs13">加購小計</span>
                <span className="fs13" style={{ color: 'var(--blue)' }}>+NT${addedSubtotal.toLocaleString()}</span>
              </div>
              <div className="card-row row-sb" style={{ borderTop: '1.5px solid var(--text)', paddingTop: 10 }}>
                <span className="fw600 fs13">更新後總金額</span>
                <span className="fw600">NT${updatedTotal.toLocaleString()}</span>
              </div>
            </div>
          )}
          {addedItems.length > 0 && (
            <button className="btn" onClick={saveAddedItems} disabled={saving} style={{ marginBottom: 16 }}>
              {saving ? '更新中…' : '儲存加購商品'}
            </button>
          )}
        </>
      )}

      {canEdit && (
        <>
          <div className="form-group">
            <label className="form-label">訂單狀態</label>
            <div style={{ display: 'flex', gap: 6 }}>
              {['處理中', '完成', '已取消'].map(s => (
                <button
                  key={s}
                  onClick={() => setOrderStatus(s)}
                  style={{
                    flex: 1, padding: '8px 0', borderRadius: 10, border: '1px solid var(--border)',
                    background: orderStatus === s ? (s === '已取消' ? 'var(--red)' : 'var(--text)') : 'var(--card)',
                    color: orderStatus === s ? '#fff' : 'var(--text-2)',
                    fontSize: 13, fontWeight: orderStatus === s ? 700 : 400, cursor: 'pointer',
                  }}
                >{s}</button>
              ))}
            </div>
          </div>
          {statusChanged && (
            <button className="btn" onClick={saveStatus} disabled={saving} style={{
              marginBottom: 16,
              background: orderStatus === '已取消' ? 'var(--red)' : undefined,
            }}>
              {saving ? '更新中…' : orderStatus === '已取消' ? '確認取消訂單' : '更新狀態'}
            </button>
          )}
        </>
      )}

      {canEdit && !isCancelled && order.payment_status !== '已付清' && (
        <>
          <div className="form-group">
            <label className="form-label">新增付款金額（NT$）</label>
            <input className="form-input" type="number" placeholder="輸入本次付款金額" value={payment} onChange={e => setPayment(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">付款備註</label>
            <input className="form-input" placeholder="尾款 / 全額 / 匯款…" value={note} onChange={e => setNote(e.target.value)} />
          </div>
          <button className="btn" onClick={addPayment} disabled={saving}>{saving ? '更新中…' : '登記付款'}</button>
        </>
      )}
    </Sheet>
  )
}

function ExportShippingSheet({ orders, onClose }) {
  const { store } = useAuth()
  const navigate = useNavigate()
  const [statuses, setStatuses] = useState(['處理中'])
  const [payStatuses, setPayStatuses] = useState(['已付清'])
  const [idFrom, setIdFrom] = useState('')
  const [idTo, setIdTo] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  const allStatuses = ['待確認', '處理中', '已購買', '已出貨', '完成', '已取消']
  const allPayStatuses = ['未付', '已付清']

  const toggleArr = (arr, setArr, val) =>
    setArr(prev => prev.includes(val) ? prev.filter(v => v !== val) : [...prev, val])

  const filtered = orders.filter(o => {
    if (statuses.length > 0 && !statuses.includes(o.status)) return false
    if (payStatuses.length > 0 && !payStatuses.includes(o.payment_status)) return false
    if (idFrom && o.id < Number(idFrom)) return false
    if (idTo && o.id > Number(idTo)) return false
    if (dateFrom && o.created_at < dateFrom) return false
    if (dateTo && o.created_at > dateTo + 'T23:59:59') return false
    return true
  })

  function exportCSV() {
    if (filtered.length === 0) return alert('沒有符合條件的訂單')
    const s = store?.settings ?? {}
    if (!s.sender_name || !s.sender_phone) {
      // just-in-time：缺寄件人資訊時，提醒並可直接帶去設定頁填寫
      if (confirm('出貨單需要寄件人姓名與電話，目前尚未填寫。要現在前往「設定」填寫嗎？')) {
        onClose?.()
        navigate('/settings')
      }
      return
    }
    const esc = v => {
      const str = String(v ?? '')
      return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str.replace(/"/g, '""')}"` : str
    }
    const rows = [
      ['一般交貨便-取貨不付款(以下欄位皆必填)', '', '', '', '', '', '', '', '', '', '', ''].join(','),
      ['', '寄件人姓名', '寄件人電話', '寄件人mail', '實際包裏價值', '收件門市', '收件門市店號', '收件人姓名', '收件人電話', '收件人mail', '退貨門市', '退貨門市店號'].join(','),
    ]
    filtered.forEach(o => {
      rows.push([
        '', esc(s.sender_name), esc(s.sender_phone), esc(s.sender_email || ''), esc(s.package_value ?? 999),
        esc(o.store_name || ''), esc(o.store_number || ''),
        esc(o.customer_name || ''), esc(o.phone || ''), esc(o.email || ''),
        esc(s.return_store_name || ''), esc(s.return_store_number || '')
      ].join(','))
    })
    const blob = new Blob(['\uFEFF' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `交貨便出貨單_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const chipStyle = (active) => ({
    padding: '5px 12px', borderRadius: 20, border: '1px solid var(--border)',
    background: active ? 'var(--text)' : 'var(--card)',
    color: active ? '#fff' : 'var(--text-2)',
    fontSize: 13, fontWeight: active ? 700 : 400, cursor: 'pointer',
  })
  const labelStyle = { fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }
  const inputStyle = {
    flex: 1, padding: '8px 12px', borderRadius: 10, border: '1px solid var(--border)',
    background: 'var(--card)', color: 'var(--text)', fontSize: 14,
  }

  return (
    <Sheet title="匯出出貨單" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* 訂單狀態 */}
        <div>
          <div style={labelStyle}>訂單狀態</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {allStatuses.map(s => (
              <button key={s} style={chipStyle(statuses.includes(s))}
                onClick={() => toggleArr(statuses, setStatuses, s)}>{s}</button>
            ))}
          </div>
        </div>

        {/* 付款狀態 */}
        <div>
          <div style={labelStyle}>付款狀態</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {allPayStatuses.map(s => (
              <button key={s} style={chipStyle(payStatuses.includes(s))}
                onClick={() => toggleArr(payStatuses, setPayStatuses, s)}>{s}</button>
            ))}
          </div>
        </div>

        {/* 訂單編號區間 */}
        <div>
          <div style={labelStyle}>訂單編號區間</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="number" placeholder="從" value={idFrom} onChange={e => setIdFrom(e.target.value)} style={inputStyle} />
            <span style={{ color: 'var(--text-3)' }}>~</span>
            <input type="number" placeholder="到" value={idTo} onChange={e => setIdTo(e.target.value)} style={inputStyle} />
          </div>
        </div>

        {/* 下單時間區間 */}
        <div>
          <div style={labelStyle}>下單時間區間</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={inputStyle} />
            <span style={{ color: 'var(--text-3)' }}>~</span>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={inputStyle} />
          </div>
        </div>

        {/* 匯出按鈕 */}
        <button
          onClick={exportCSV}
          style={{
            width: '100%', padding: '14px 0', borderRadius: 12, border: 'none',
            background: filtered.length > 0 ? 'var(--text)' : 'var(--border)',
            color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer',
            marginTop: 4,
          }}
        >
          匯出 CSV（{filtered.length} 筆）
        </button>
      </div>
    </Sheet>
  )
}

function ExportRevenueSheet({ onClose }) {
  const { storeId } = useAuth()
  const allStatuses = ['待確認', '處理中', '已購買', '已出貨', '完成', '已取消']
  const allPayStatuses = ['未付', '已付清']
  const [statuses, setStatuses] = useState(allStatuses.filter(s => s !== '已取消'))
  const [payStatuses, setPayStatuses] = useState([])
  const [idFrom, setIdFrom] = useState('')
  const [idTo, setIdTo] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [level, setLevel] = useState('both')
  const [preview, setPreview] = useState(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)

  const toggleArr = (arr, setArr, val) =>
    setArr(prev => prev.includes(val) ? prev.filter(v => v !== val) : [...prev, val])

  const rpcParams = {
    p_store_id: storeId,
    p_date_from: dateFrom || null,
    p_date_to: dateTo || null,
    p_id_from: idFrom ? Number(idFrom) : null,
    p_id_to: idTo ? Number(idTo) : null,
    p_statuses: statuses.length > 0 ? statuses : null,
    p_pay_statuses: payStatuses.length > 0 ? payStatuses : null,
  }

  // 篩選變更時（debounce）重新計算彙總預覽
  useEffect(() => {
    if (!storeId) return
    let alive = true
    setLoading(true)
    const t = setTimeout(async () => {
      const { data, error } = await supabase.rpc('revenue_report_orders', rpcParams)
      if (!alive) return
      setLoading(false)
      if (error || !data) { setPreview(null); return }
      const sum = key => data.reduce((s, r) => s + Number(r[key] || 0), 0)
      setPreview({ count: data.length, revenue: sum('total_amount'), cost: sum('total_cost'), profit: sum('profit') })
    }, 400)
    return () => { alive = false; clearTimeout(t) }
  }, [statuses, payStatuses, idFrom, idTo, dateFrom, dateTo, storeId])

  const esc = v => {
    const s = String(v ?? '')
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s
  }
  const fmtTime = s => new Date(s).toLocaleString('zh-TW', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  })

  function downloadCSV(rows, filename) {
    const blob = new Blob(['\uFEFF' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  function buildOrdersCSV(data) {
    const rows = [
      ['訂單編號', '訂單時間', '下單人', 'Email', '電話', '末五碼', '訂單狀態', '付款狀態',
       '件數', '商品小計', '折扣金額', '運費', '訂單總金額', '訂單總成本(TWD)', '訂單利潤', '毛利率(%)', '物流追蹤碼'].join(','),
    ]
    data.forEach(r => {
      rows.push([
        r.order_id, fmtTime(r.created_at), esc(r.customer_name), esc(r.email), esc(r.phone),
        esc(r.remittance_last5), r.status, r.payment_status,
        r.item_count, r.subtotal, r.discount_amount, r.shipping_fee ?? '',
        r.total_amount, r.total_cost, r.profit, r.margin ?? '', esc(r.tracking_number),
      ].join(','))
    })
    const sum = key => data.reduce((s, r) => s + Number(r[key] || 0), 0)
    const totalRevenue = sum('total_amount')
    const totalProfit = sum('profit')
    rows.push([
      '合計', '', '', '', '', '', '', '',
      sum('item_count'), sum('subtotal'), sum('discount_amount'), sum('shipping_fee'),
      totalRevenue, sum('total_cost'), totalProfit,
      totalRevenue > 0 ? (totalProfit / totalRevenue * 100).toFixed(1) : '', '',
    ].join(','))
    return rows
  }

  function buildItemsCSV(data) {
    const rows = [
      ['訂單編號', '訂單時間', '訂單狀態', '商品名稱', 'SKU', '規格', '品項狀態',
       '數量', '售價', '小計', '幣別', '原幣成本', '成本(TWD)', '成本小計', '品項利潤', '備註'].join(','),
    ]
    data.forEach(r => {
      rows.push([
        r.order_id, fmtTime(r.created_at), r.order_status, esc(r.item_name), esc(r.sku),
        esc(r.variant_label), r.item_status === 'cancelled' ? '已取消' : '',
        r.qty, r.unit_price ?? '', r.subtotal ?? '', r.currency ?? '',
        r.unit_cost_orig ?? '', r.unit_cost_twd ?? '', r.cost_subtotal ?? '', r.item_profit ?? '',
        esc(r.custom_note),
      ].join(','))
    })
    return rows
  }

  async function exportCSV() {
    setExporting(true)
    try {
      const today = new Date().toISOString().slice(0, 10)
      if (level === 'orders' || level === 'both') {
        const { data, error } = await supabase.rpc('revenue_report_orders', rpcParams)
        if (error) throw error
        if (!data?.length) return alert('沒有符合條件的訂單')
        downloadCSV(buildOrdersCSV(data), `營收報表_訂單_${today}.csv`)
      }
      if (level === 'items' || level === 'both') {
        const { data, error } = await supabase.rpc('revenue_report_items', rpcParams)
        if (error) throw error
        if (!data?.length) return level === 'items' ? alert('沒有符合條件的訂單') : undefined
        downloadCSV(buildItemsCSV(data), `營收報表_品項_${today}.csv`)
      }
    } catch (e) {
      alert('匯出失敗：' + (e.message || e))
    } finally {
      setExporting(false)
    }
  }

  const chipStyle = (active) => ({
    padding: '5px 12px', borderRadius: 20, border: '1px solid var(--border)',
    background: active ? 'var(--text)' : 'var(--card)',
    color: active ? '#fff' : 'var(--text-2)',
    fontSize: 13, fontWeight: active ? 700 : 400, cursor: 'pointer',
  })
  const labelStyle = { fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }
  const inputStyle = {
    flex: 1, padding: '8px 12px', borderRadius: 10, border: '1px solid var(--border)',
    background: 'var(--card)', color: 'var(--text)', fontSize: 14,
  }
  const fmtMoney = n => 'NT$' + Math.round(n).toLocaleString()
  const canExport = !exporting && (preview?.count ?? 0) > 0

  return (
    <Sheet title="匯出營收報表" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* 報表層級 */}
        <div>
          <div style={labelStyle}>報表內容</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[['orders', '訂單總表'], ['items', '品項明細'], ['both', '兩者都要']].map(([key, label]) => (
              <button key={key} style={chipStyle(level === key)} onClick={() => setLevel(key)}>{label}</button>
            ))}
          </div>
        </div>

        {/* 訂單狀態 */}
        <div>
          <div style={labelStyle}>訂單狀態</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {allStatuses.map(s => (
              <button key={s} style={chipStyle(statuses.includes(s))}
                onClick={() => toggleArr(statuses, setStatuses, s)}>{s}</button>
            ))}
          </div>
        </div>

        {/* 付款狀態 */}
        <div>
          <div style={labelStyle}>付款狀態</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {allPayStatuses.map(s => (
              <button key={s} style={chipStyle(payStatuses.includes(s))}
                onClick={() => toggleArr(payStatuses, setPayStatuses, s)}>{s}</button>
            ))}
          </div>
        </div>

        {/* 訂單編號區間 */}
        <div>
          <div style={labelStyle}>訂單編號區間</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="number" placeholder="從" value={idFrom} onChange={e => setIdFrom(e.target.value)} style={inputStyle} />
            <span style={{ color: 'var(--text-3)' }}>~</span>
            <input type="number" placeholder="到" value={idTo} onChange={e => setIdTo(e.target.value)} style={inputStyle} />
          </div>
        </div>

        {/* 下單時間區間 */}
        <div>
          <div style={labelStyle}>下單時間區間</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={inputStyle} />
            <span style={{ color: 'var(--text-3)' }}>~</span>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={inputStyle} />
          </div>
        </div>

        {/* 彙總預覽 */}
        <div style={{
          border: '1px solid var(--border)', borderRadius: 12, padding: '12px 14px',
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10,
        }}>
          {loading ? (
            <div style={{ gridColumn: '1 / -1', textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>計算中…</div>
          ) : preview ? (
            [['訂單數', `${preview.count} 筆`], ['總營收', fmtMoney(preview.revenue)],
             ['總成本', fmtMoney(preview.cost)], ['總利潤', fmtMoney(preview.profit)]].map(([k, v]) => (
              <div key={k}>
                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{k}</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{v}</div>
              </div>
            ))
          ) : (
            <div style={{ gridColumn: '1 / -1', textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>
              無法取得彙總（請確認已套用報表 migration）
            </div>
          )}
        </div>

        {/* 匯出按鈕 */}
        <button
          onClick={exportCSV}
          disabled={!canExport}
          style={{
            width: '100%', padding: '14px 0', borderRadius: 12, border: 'none',
            background: canExport ? 'var(--text)' : 'var(--border)',
            color: '#fff', fontSize: 15, fontWeight: 700, cursor: canExport ? 'pointer' : 'default',
            marginTop: 4,
          }}
        >
          {exporting ? '匯出中…' : `匯出 CSV（${preview?.count ?? 0} 筆訂單）`}
        </button>
      </div>
    </Sheet>
  )
}

function Sheet({ title, onClose, children }) {
  return (
    <div className="sheet-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <div className="sheet-handle" />
        <div className="row-sb" style={{marginBottom:20}}>
          <div className="sheet-title" style={{margin:0}}>{title}</div>
          <button onClick={onClose} style={{background:'none',border:'none',fontSize:22,cursor:'pointer',color:'var(--text-3)'}}>×</button>
        </div>
        {children}
      </div>
    </div>
  )
}
