import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'

export default function OrdersPage() {
  const { can } = useAuth()
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

  async function fetchProcurement() {
    setLoading(true)
    // Get pending orders
    const { data: pending } = await supabase
      .from('consumer_orders').select('*')
      .eq('status', '待確認')
    // Get all products with source info
    const { data: products } = await supabase
      .from('products').select('id, name, sku, source')

    const productMap = {}
    ;(products || []).forEach(p => { productMap[p.id] = p })

    // Aggregate items from all pending orders
    const agg = {} // key: productId → { name, source, sku, totalQty, variants: { label: qty } }
    ;(pending || []).forEach(order => {
      const items = Array.isArray(order.items_json) ? order.items_json : []
      items.forEach(item => {
        if (item.status === 'cancelled') return
        const pid = item.id
        const prod = productMap[pid]
        if (!agg[pid]) {
          agg[pid] = {
            name: item.name,
            sku: prod?.sku || item.sku || '',
            source: prod?.source || '',
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

    // Group by source
    const grouped = {} // source → [items]
    const ungrouped = [] // items without source
    Object.values(agg).forEach(item => {
      if (item.source) {
        if (!grouped[item.source]) grouped[item.source] = []
        grouped[item.source].push(item)
      } else {
        ungrouped.push(item)
      }
    })

    setProcurementData({ grouped, ungrouped, orderCount: (pending || []).length })
    setLoading(false)
  }

  useEffect(() => {
    if (tab === 'procurement') fetchProcurement()
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
      {!loading && tab === 'consumer' && (
        <>
          <div className="stats">
            <div className="stat">
              <div className="stat-val text-amber">{consumerOrders.filter(o => o.status === '待確認').length}</div>
              <div className="stat-lbl"><span className="dot" style={{background:'var(--amber)'}} />待確認</div>
            </div>
            <div className="stat">
              <div className="stat-val text-green">{consumerOrders.filter(o => o.payment_status === '已付清').length}</div>
              <div className="stat-lbl"><span className="dot" style={{background:'var(--green)'}} />已付清</div>
            </div>
          </div>
          {consumerOrders.length === 0 && <div className="empty">還沒有商城訂單</div>}
          {consumerOrders.map(o => (
            <ConsumerOrderCard key={o.id} order={o} onTap={() => setSheet({ _type: 'consumer', ...o })} />
          ))}
        </>
      )}

      {/* Procurement summary tab */}
      {!loading && tab === 'procurement' && procurementData && (
        <>
          <div className="stats">
            <div className="stat">
              <div className="stat-val text-amber">{procurementData.orderCount}</div>
              <div className="stat-lbl"><span className="dot" style={{background:'var(--amber)'}} />待確認訂單</div>
            </div>
            <div className="stat">
              <div className="stat-val">{Object.keys(procurementData.grouped).length + (procurementData.ungrouped.length > 0 ? 1 : 0)}</div>
              <div className="stat-lbl">採購來源</div>
            </div>
          </div>

          {procurementData.orderCount === 0 && <div className="empty">目前沒有待確認的訂單</div>}

          {Object.entries(procurementData.grouped).map(([source, items]) => (
            <div key={source} style={{ marginBottom: 20 }}>
              <div className="sec" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>🏬</span> {source}
                <span className="muted fs12">({items.reduce((s, i) => s + i.totalQty, 0)} 件)</span>
              </div>
              {items.map(item => (
                <div className="card" key={item.sku} style={{ marginBottom: 6 }}>
                  <div className="card-row" style={{ flexDirection: 'column', gap: 4 }}>
                    <div className="row-sb" style={{ width: '100%' }}>
                      <span className="fw600 fs14">{item.name}</span>
                      <span className="fw600 fs15" style={{ color: 'var(--text)' }}>× {item.totalQty}</span>
                    </div>
                    <div className="muted fs12">{item.sku}</div>
                    {Object.keys(item.variants).length > 1 || (Object.keys(item.variants).length === 1 && !item.variants['無規格']) ? (
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
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ))}

          {procurementData.ungrouped.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div className="sec" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>📦</span> 未設定來源
                <span className="muted fs12">({procurementData.ungrouped.reduce((s, i) => s + i.totalQty, 0)} 件)</span>
              </div>
              {procurementData.ungrouped.map(item => (
                <div className="card" key={item.sku} style={{ marginBottom: 6 }}>
                  <div className="card-row" style={{ flexDirection: 'column', gap: 4 }}>
                    <div className="row-sb" style={{ width: '100%' }}>
                      <span className="fw600 fs14">{item.name}</span>
                      <span className="fw600 fs15" style={{ color: 'var(--text)' }}>× {item.totalQty}</span>
                    </div>
                    <div className="muted fs12">{item.sku}</div>
                    {Object.keys(item.variants).length > 1 || (Object.keys(item.variants).length === 1 && !item.variants['無規格']) ? (
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
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {sheet === 'add' && <AddOrderSheet onClose={() => setSheet(null)} onSaved={fetchAll} />}
      {sheet && sheet !== 'add' && !sheet._type && (
        <OrderDetailSheet order={sheet} onClose={() => setSheet(null)} onSaved={fetchAll} canEdit={can('pay')} />
      )}
      {sheet && sheet._type === 'consumer' && (
        <ConsumerOrderDetailSheet order={sheet} onClose={() => setSheet(null)} onSaved={fetchAll} canEdit={can('pay')} />
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

const FREE_SHIPPING_THRESHOLD = 3960
const DEFAULT_SHIPPING_FEE = 60

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
  const effectiveShippingFee = !hasAnyChange ? 0 : (meetsThreshold ? 0 : shippingFee)
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

  async function save() {
    const active = itemStatuses.filter(i => !i._cancelled)
    const cancelled = itemStatuses.filter(i => i._cancelled)
    const qtyReduced = active.some(i => i.qty < i._originalQty)
    const itemsChanged = cancelled.length > 0 || qtyReduced

    // 如果有商品異動，但狀態還不是「已出貨」或「已取消」，自動詢問
    let finalStatus = status
    if (itemsChanged && status !== '已出貨' && status !== '已取消') {
      if (active.length === 0) {
        // 全部取消
        if (window.confirm('所有商品都已標記缺貨，是否將訂單標記為「已取消」並通知消費者？')) {
          finalStatus = '已取消'
          setStatus('已取消')
        }
      } else {
        // 部分取消 / 數量調整
        if (window.confirm('商品有異動（缺貨/數量調整），是否同時標記「已出貨」並寄送通知 Email 給消費者？\n\n選擇「確定」→ 標記出貨 + 寄通知\n選擇「取消」→ 僅儲存異動，不寄信')) {
          finalStatus = '已出貨'
          setStatus('已出貨')
        }
      }
    }

    setSaving(true)

    // 判斷 fulfillment_type
    let fulfillment_type = o.fulfillment_type || null
    if (finalStatus === '已出貨') {
      if (cancelled.length === 0 && !qtyReduced) fulfillment_type = 'full'
      else if (active.length > 0) fulfillment_type = 'partial'
      else fulfillment_type = 'cancelled'
    } else if (finalStatus === '已取消') {
      fulfillment_type = 'cancelled'
    }

    const updatedTotal = active.length > 0 ? newTotal : 0

    // items_json：所有商品都保留，以 status 欄位區分
    // originalQty 記住消費者原訂數量，方便日後查看
    const updatedItemsJson = itemStatuses.map(({ _cancelled, _added, _originalQty, ...item }) => ({
      ...item,
      originalQty: _originalQty,
      status: _cancelled ? 'cancelled' : 'active',
    }))

    await supabase.from('consumer_orders').update({
      status: finalStatus,
      payment_status: payStatus,
      items_json: updatedItemsJson,
      shipping_fee: hasAnyChange ? effectiveShippingFee : 0,
      total_amount: updatedTotal,
      fulfillment_type,
      tracking_number: trackingNumber || null,
    }).eq('id', o.id)

    // 出貨或取消時觸發通知 Email
    if (finalStatus === '已出貨' || finalStatus === '已取消') {
      await triggerStatusEmail({
        activeItems: active.map(({ _cancelled, _added, _originalQty, ...item }) => ({
          ...item,
          ...(item.qty < _originalQty ? { note: `原訂 ${_originalQty}，到貨 ${item.qty}` } : {}),
        })),
        cancelledItems: cancelled.map(({ _cancelled, _added, _originalQty, ...item }) => item),
        shippingFee: effectiveShippingFee,
        newTotal: updatedTotal,
        fulfillment_type,
        trackingNumber: trackingNumber || null,
      })
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
              <select className="form-select" value={status} onChange={e => setStatus(e.target.value)}>
                {['待確認', '處理中', '已出貨', '完成', '已取消'].map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="form-label fs12">付款狀態</label>
              <select className="form-select" value={payStatus} onChange={e => setPayStatus(e.target.value)}>
                {['未付', '已付清'].map(s => <option key={s}>{s}</option>)}
              </select>
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
