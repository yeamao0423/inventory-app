import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import CustomSelect from '../components/CustomSelect'

export default function OrdersPage() {
  const { can, profile } = useAuth()
  const [tab, setTab] = useState('internal')
  const [orders, setOrders] = useState([])
  const [consumerOrders, setConsumerOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [sheet, setSheet] = useState(null)
  const [procurementData, setProcurementData] = useState(null) // { grouped, ungrouped }

  useEffect(() => { fetchAll() }, [])

  async function fetchAll() {
    setLoading(true)
    const [{ data: ord }, { data: cord }] = await Promise.all([
      supabase.from('orders').select('*').order('created_at', { ascending: false }),
      supabase.from('consumer_orders').select('*').order('created_at', { ascending: false }),
    ])
    setOrders(ord || [])
    setConsumerOrders(cord || [])
    setLoading(false)
  }

  const [previewItem, setPreviewItem] = useState(null)
  const [previewImgIdx, setPreviewImgIdx] = useState(0)
  const [sourceFilter, setSourceFilter] = useState('all') // 'all' | source name
  const [consumerStatusFilter, setConsumerStatusFilter] = useState('all') // 'all' | status
  const [consumerFilterOpen, setConsumerFilterOpen] = useState(false)
  const [showExportSheet, setShowExportSheet] = useState(false)
  const isAdmin = ['admin', 'super_admin'].includes(profile?.role)

  async function fetchProcurement() {
    setLoading(true)
    const [{ data: pending }, { data: products }, { data: spProducts }, { data: rates }, { data: images }] = await Promise.all([
      supabase.from('consumer_orders').select('*').not('status', 'in', '("已出貨","完成","已取消")'),
      supabase.from('products').select('id, name, sku, source, cost, currency'),
      supabase.from('storefront_products').select('product_id, shop_price'),
      supabase.from('exchange_rates').select('*'),
      supabase.from('product_images').select('product_id, url, sort_order').order('sort_order', { ascending: true }),
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
          }
        }
        const qty = Number(item.qty) || 0
        agg[pid].totalQty += qty
        const vLabel = item.variantLabel || '無規格'
        agg[pid].variants[vLabel] = (agg[pid].variants[vLabel] || 0) + qty
      })
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
    if (tab === 'procurement') {
      setSourceFilter('all')
      fetchProcurement()
    }
  }, [tab])

  const unpaid = orders.filter(o => o.payment_status !== '已付清')
  const paid   = orders.filter(o => o.payment_status === '已付清')
  const pendingConsumer = consumerOrders.filter(o => o.status === '待確認').length

  return (
    <div className="page">
      <div className="ph">
        <div>
          <div className="ph-title">訂單管理</div>
          <div className="ph-sub">
            {tab === 'internal' ? `自建 ${orders.length} 筆` : `商城 ${consumerOrders.length} 筆`}
          </div>
        </div>
        {tab === 'internal' && can('add') && <button className="icon-btn" onClick={() => setSheet('add')}>+</button>}
      </div>

      {/* Tab switcher */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {[
          { key: 'internal', label: '自建訂單' },
          { key: 'consumer', label: '商城訂單', badge: pendingConsumer },
          { key: 'procurement', label: '採購彙整' },
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

      {/* Internal orders tab */}
      {!loading && tab === 'internal' && (
        <>
          <div className="stats">
            <div className="stat">
              <div className="stat-val text-amber">{unpaid.length}</div>
              <div className="stat-lbl"><span className="dot" style={{background:'var(--amber)'}} />待付款</div>
            </div>
            <div className="stat">
              <div className="stat-val text-green">{paid.length}</div>
              <div className="stat-lbl"><span className="dot" style={{background:'var(--green)'}} />已付清</div>
            </div>
          </div>
          {unpaid.length > 0 && (
            <>
              <div className="sec">待付款</div>
              {unpaid.map(o => <OrderCard key={o.id} order={o} onTap={() => setSheet(o)} />)}
            </>
          )}
          {paid.length > 0 && (
            <>
              <div className="sec">已付清</div>
              {paid.map(o => <OrderCard key={o.id} order={o} onTap={() => setSheet(o)} />)}
            </>
          )}
          {orders.length === 0 && <div className="empty">還沒有訂單</div>}
        </>
      )}

      {/* Consumer orders tab */}
      {!loading && tab === 'consumer' && (() => {
        const statusFilters = [
          { key: 'all', label: '全部' },
          { key: '待確認', label: '待確認' },
          { key: '處理中', label: '處理中' },
          { key: '已出貨', label: '已出貨' },
          { key: '完成', label: '完成' },
          { key: '已取消', label: '已取消' },
        ]
        const filteredConsumer = consumerStatusFilter === 'all'
          ? consumerOrders
          : consumerOrders.filter(o => o.status === consumerStatusFilter)
        const activeLabel = statusFilters.find(f => f.key === consumerStatusFilter)?.label || '全部'
        const activeCount = consumerStatusFilter === 'all' ? consumerOrders.length : consumerOrders.filter(o => o.status === consumerStatusFilter).length

        return (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: consumerFilterOpen ? 0 : 16 }}>
              <button
                onClick={() => setConsumerFilterOpen(v => !v)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, flex: 1,
                  padding: '10px 14px', borderRadius: 12, border: '1px solid var(--border)',
                  background: 'var(--card)', cursor: 'pointer',
                  fontSize: 14, fontWeight: 600, color: 'var(--text)',
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="4" y1="6" x2="20" y2="6" /><line x1="8" y1="12" x2="20" y2="12" /><line x1="12" y1="18" x2="20" y2="18" />
                </svg>
                {activeLabel} ({activeCount})
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ marginLeft: 'auto', transition: 'transform .2s', transform: consumerFilterOpen ? 'rotate(180deg)' : '' }}>
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
              {isAdmin && (
                <button
                  onClick={() => setShowExportSheet(true)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    padding: '10px 14px', borderRadius: 12, border: '1px solid var(--border)',
                    background: 'var(--card)', color: 'var(--text)',
                    cursor: 'pointer', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap',
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  出貨單
                </button>
              )}
            </div>
            {consumerFilterOpen && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '12px 0 16px' }}>
                {statusFilters.map(f => {
                  const count = f.key === 'all' ? consumerOrders.length : consumerOrders.filter(o => o.status === f.key).length
                  const isActive = consumerStatusFilter === f.key
                  return (
                    <button
                      key={f.key}
                      onClick={() => { setConsumerStatusFilter(f.key); setConsumerFilterOpen(false) }}
                      style={{
                        padding: '6px 12px', borderRadius: 20, border: '1px solid var(--border)',
                        background: isActive ? 'var(--text)' : 'var(--card)',
                        color: isActive ? '#fff' : 'var(--text-2)',
                        fontSize: 13, fontWeight: isActive ? 700 : 400, cursor: 'pointer',
                      }}
                    >
                      {f.label} ({count})
                    </button>
                  )
                })}
              </div>
            )}
            {filteredConsumer.length === 0 && <div className="empty">沒有符合的訂單</div>}
            {filteredConsumer.map(o => (
              <ConsumerOrderCard key={o.id} order={o} onTap={() => setSheet({ _type: 'consumer', ...o })} />
            ))}
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

        let fCost = 0, fRevenue = 0
        filteredItems.forEach(item => {
          if (item.totalCostTWD != null) fCost += item.totalCostTWD
          if (item.totalRevenue != null) fRevenue += item.totalRevenue
        })
        const fProfit = fRevenue - fCost
        const fProfitRate = fRevenue > 0 ? (fProfit / fRevenue) * 100 : 0

        // 篩選後的 warnings
        const filteredWarnings = sourceFilter === 'all'
          ? procurementData.warnings
          : procurementData.warnings.filter(w =>
              filteredItems.some(item => item.name === w.name && item.sku === (w.sku || ''))
            )

        return (
          <>
            {isEmpty ? (
              <div className="empty">目前沒有待確認的訂單</div>
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

                {/* 統計卡片 */}
                <div style={{
                  display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16,
                }}>
                  <div className="card" style={{ padding: '14px 16px' }}>
                    <div className="muted fs12">採購成本</div>
                    <div className="fw600 fs15" style={{ marginTop: 4 }}>NT${Math.round(fCost).toLocaleString()}</div>
                  </div>
                  <div className="card" style={{ padding: '14px 16px' }}>
                    <div className="muted fs12">預估營收</div>
                    <div className="fw600 fs15" style={{ marginTop: 4 }}>NT${Math.round(fRevenue).toLocaleString()}</div>
                  </div>
                  <div className="card" style={{ padding: '14px 16px' }}>
                    <div className="muted fs12">預估利潤</div>
                    <div className="fw600 fs15" style={{ marginTop: 4, color: fProfit >= 0 ? 'var(--green)' : 'var(--red)' }}>
                      NT${Math.round(fProfit).toLocaleString()}
                    </div>
                  </div>
                  <div className="card" style={{ padding: '14px 16px' }}>
                    <div className="muted fs12">利潤率</div>
                    <div className="fw600 fs15" style={{ marginTop: 4, color: fProfitRate >= 0 ? 'var(--green)' : 'var(--red)' }}>
                      {fProfitRate.toFixed(1)}%
                    </div>
                  </div>
                </div>

                {/* 匯率缺失提醒 */}
                {procurementData.missingRates.length > 0 && (
                  <div style={{
                    background: '#fff8e8', borderRadius: 12, padding: '12px 16px', marginBottom: 16,
                    fontSize: 13, color: '#8a5c00',
                  }}>
                    ⚠️ 以下幣別尚未設定匯率，相關商品成本以 0 計算：{procurementData.missingRates.join('、')}
                  </div>
                )}

                {/* 未定價 / 無成本提醒 */}
                {filteredWarnings.length > 0 && (
                  <div style={{
                    background: '#fff5f5', borderRadius: 12, padding: '12px 16px', marginBottom: 16,
                    fontSize: 13, color: '#a03030',
                  }}>
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>以下商品資料不完整，已從利潤計算中排除：</div>
                    {filteredWarnings.map((w, i) => (
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

      {sheet === 'add' && <AddOrderSheet onClose={() => setSheet(null)} onSaved={fetchAll} />}
      {sheet && sheet !== 'add' && !sheet._type && (
        <OrderDetailSheet order={sheet} onClose={() => setSheet(null)} onSaved={fetchAll} canEdit={can('pay')} />
      )}
      {sheet && sheet._type === 'consumer' && (
        <ConsumerOrderDetailSheet order={sheet} onClose={() => setSheet(null)} onSaved={fetchAll} canEdit={can('pay')} />
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

function OrderCard({ order: o, onTap }) {
  const balance = (Number(o.total_amount) || 0) - (Number(o.deposit) || 0)
  return (
    <div className="card" onClick={onTap} style={{cursor:'pointer'}}>
      <div className="card-row">
        <div style={{flex:1,minWidth:0}}>
          <div className="row-sb">
            <span className="fw600 fs15">{o.customer}</span>
            {statusBadge(o.payment_status)}
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
          <div><span className="muted fs12">總額 </span><span className="fw600">NT${Number(o.total_amount).toLocaleString()}</span></div>
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

  // 加購商品欄位
  const [addItemName, setAddItemName] = useState('')
  const [addItemPrice, setAddItemPrice] = useState('')
  const [addItemQty, setAddItemQty] = useState(1)

  // 計算邏輯
  const activeItems = itemStatuses.filter(i => !i._cancelled)
  const cancelledItems = itemStatuses.filter(i => i._cancelled)
  const activeSubtotal = activeItems.reduce((sum, i) => sum + (Number(i.price) || 0) * (Number(i.qty) || 0), 0)
  const hasAnyCancel = cancelledItems.length > 0
  const hasQtyChange = activeItems.some(i => i.qty < i._originalQty)
  const hasAnyChange = hasAnyCancel || hasQtyChange
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

    return {
      activeItems: active.map(({ _cancelled, _added, _originalQty, ...item }) => ({
        ...item,
        ...(item.qty < _originalQty ? { note: `原訂 ${_originalQty}，到貨 ${item.qty}` } : {}),
      })),
      cancelledItems: cancelled.map(({ _cancelled, _added, _originalQty, ...item }) => item),
      shippingFee: effectiveShippingFee,
      newTotal: activeItems.length > 0 ? newTotal : 0,
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

    const updatedItemsJson = itemStatuses.map(({ _cancelled, _added, _originalQty, ...item }) => ({
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

    // 全數取消 → 自動詢問
    if (status === '已取消') {
      if (window.confirm('訂單已標記為「已取消」，是否寄出取消通知 Email 給消費者？')) {
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
          <span className="muted fs13">總金額</span>
          <span className="fw600">NT${Number(hasAnyChange ? newTotal : (o.total_amount || 0)).toLocaleString()}</span>
        </div>
      </div>

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
              {(item.color || item.size) && (
                <div className="muted fs12">{[item.color, item.size].filter(Boolean).join(' / ')}</div>
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
                  }} onClick={() => setItemStatuses(prev => prev.map((it, idx) =>
                    idx === i ? { ...it, qty: Math.min(it._originalQty, it.qty + 1) } : it
                  ))}>+</button>
                </div>
              ) : (
                <div className="fs13">× {item.qty}</div>
              )}
              <div className="muted fs12">NT${((Number(item.price) || 0) * (Number(item.qty) || 0)).toLocaleString()}</div>
              {/* 數量被調低時顯示提示 */}
              {!item._cancelled && item.qty < item._originalQty && (
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
      {canEdit && hasAnyChange && activeItems.length > 0 && (
        <>
          <div className="sec" style={{ marginTop: 0 }}>加購商品（選填）</div>
          <div className="card" style={{ marginBottom: 16, padding: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8 }}>
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
              setItemStatuses(prev => [...prev, {
                name: addItemName,
                price: Number(addItemPrice),
                qty: addItemQty || 1,
                _cancelled: false,
                _added: true,
              }])
              setAddItemName('')
              setAddItemPrice('')
              setAddItemQty(1)
            }}>
              + 加入訂單
            </button>
          </div>
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
                options={['待確認', '處理中', '已出貨', '完成', '已取消'].map(s => ({ value: s, label: s }))}
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
  const [form, setForm] = useState({ customer: '', phone: '', email: '', address: '', line_id: '', deposit: '0', note: '' })
  const [saving, setSaving] = useState(false)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  // 商品選擇
  const [products, setProducts] = useState([])
  const [variants, setVariants] = useState({}) // productId → [variants]
  const [spMap, setSpMap] = useState({}) // productId → storefront_product
  const [search, setSearch] = useState('')
  const [selectedItems, setSelectedItems] = useState([]) // [{ id, name, price, qty, variantId, variantLabel }]
  const [showPicker, setShowPicker] = useState(false)

  useEffect(() => {
    async function load() {
      const [{ data: prods }, { data: vars }, { data: sp }] = await Promise.all([
        supabase.from('products').select('id, name, sku, source'),
        supabase.from('product_variants').select('*'),
        supabase.from('storefront_products').select('product_id, shop_price'),
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
    }
    load()
  }, [])

  function addProduct(prod, variant) {
    const price = spMap[prod.id]?.shop_price
      ? Number(spMap[prod.id].shop_price) + (variant ? Number(variant.price_adjustment) || 0 : 0)
      : 0
    const vLabel = variant ? [variant.color, variant.size].filter(Boolean).join(' / ') : ''
    const key = `${prod.id}-${variant?.id || ''}`
    setSelectedItems(prev => {
      const existing = prev.find(i => i._key === key)
      if (existing) return prev.map(i => i._key === key ? { ...i, qty: i.qty + 1 } : i)
      return [...prev, { _key: key, id: prod.id, name: prod.name, price, qty: 1, variantId: variant?.id, variantLabel: vLabel, color: variant?.color, size: variant?.size }]
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
      customer: form.customer,
      items: itemsStr,
      deposit,
      total_amount: total || null,
      payment_status: payStatus,
      note: form.note,
    })

    // 同時建立 consumer_orders 以便採購彙整計算
    await supabase.from('consumer_orders').insert({
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
              const sp = spMap[p.id]
              const price = sp ? Number(sp.shop_price) : 0
              if (pvs && pvs.length > 0) {
                return pvs.map(v => {
                  const vLabel = [v.color, v.size].filter(Boolean).join(' / ')
                  const vPrice = price + (Number(v.price_adjustment) || 0)
                  return (
                    <div key={`${p.id}-${v.id}`} onClick={() => addProduct(p, v)}
                      style={{ padding: '8px 10px', cursor: 'pointer', borderRadius: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--surface)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <div>
                        <div className="fs13 fw600">{p.name}</div>
                        <div className="muted fs12">{vLabel} · {p.sku}</div>
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
                  <span className="fs13">{price > 0 ? `NT$${price.toLocaleString()}` : '未定價'}</span>
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
  const [saving, setSaving] = useState(false)

  async function addPayment() {
    if (!payment) return
    setSaving(true)
    const paid = (Number(order.deposit) || 0) + Number(payment)
    const total = Number(order.total_amount) || 0
    const status = total > 0 && paid >= total ? '已付清' : '已付訂金'
    await supabase.from('orders').update({
      deposit: paid,
      payment_status: status,
      note: note || order.note,
    }).eq('id', order.id)
    setSaving(false)
    onSaved()
    onClose()
  }

  const balance = (Number(order.total_amount) || 0) - (Number(order.deposit) || 0)

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
          <span className="fw600">{order.total_amount ? `NT$${Number(order.total_amount).toLocaleString()}` : '未設定'}</span>
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
          <span className="muted fs13">狀態</span>
          {statusBadge(order.payment_status)}
        </div>
        {order.note && (
          <div className="card-row"><span className="muted fs13">備註：{order.note}</span></div>
        )}
      </div>

      {canEdit && order.payment_status !== '已付清' && (
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
  const [statuses, setStatuses] = useState(['處理中'])
  const [payStatuses, setPayStatuses] = useState(['已付清'])
  const [idFrom, setIdFrom] = useState('')
  const [idTo, setIdTo] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  const allStatuses = ['待確認', '處理中', '已出貨', '完成', '已取消']
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
    const esc = v => {
      const s = String(v ?? '')
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s
    }
    const rows = [
      ['一般交貨便-取貨不付款(以下欄位皆必填)', '', '', '', '', '', '', '', '', '', '', ''].join(','),
      ['', '寄件人姓名', '寄件人電話', '寄件人mail', '實際包裏價值', '收件門市', '收件門市店號', '收件人姓名', '收件人電話', '收件人mail', '退貨門市', '退貨門市店號'].join(','),
    ]
    filtered.forEach(o => {
      rows.push([
        '', '徐承豊', '0955367287', 'daigogosg@gmail.com', '999',
        esc(o.store_name || ''), esc(o.store_number || ''),
        esc(o.customer_name || ''), esc(o.phone || ''), esc(o.email || ''),
        '和復門市', '263115'
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
