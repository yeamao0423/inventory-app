import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'

export default function OrdersPage() {
  const { can } = useAuth()
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [sheet, setSheet] = useState(null)

  useEffect(() => { fetchOrders() }, [])

  async function fetchOrders() {
    const { data } = await supabase.from('orders').select('*').order('created_at', {ascending:false})
    setOrders(data || [])
    setLoading(false)
  }

  const unpaid = orders.filter(o => o.payment_status !== '已付清')
  const paid   = orders.filter(o => o.payment_status === '已付清')

  return (
    <div className="page">
      <div className="ph">
        <div>
          <div className="ph-title">訂單管理</div>
          <div className="ph-sub">共 {orders.length} 筆</div>
        </div>
        {can('add') && <button className="icon-btn" onClick={() => setSheet('add')}>+</button>}
      </div>

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

      {loading && <div className="empty">載入中…</div>}

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
      {orders.length === 0 && !loading && <div className="empty">還沒有訂單</div>}

      {sheet === 'add' && <AddOrderSheet onClose={() => setSheet(null)} onSaved={fetchOrders} />}
      {sheet && sheet !== 'add' && (
        <OrderDetailSheet order={sheet} onClose={() => setSheet(null)} onSaved={fetchOrders} canEdit={can('pay')} />
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

function AddOrderSheet({ onClose, onSaved }) {
  const [form, setForm] = useState({ customer:'', items:'', deposit:'0', total_amount:'', note:'' })
  const [saving, setSaving] = useState(false)
  const set = (k, v) => setForm(f => ({...f, [k]: v}))

  async function save() {
    if (!form.customer || !form.items) return
    setSaving(true)
    const deposit = Number(form.deposit) || 0
    const total = Number(form.total_amount) || 0
    const status = total > 0 && deposit >= total ? '已付清' : deposit > 0 ? '已付訂金' : '未付'
    await supabase.from('orders').insert({
      customer: form.customer,
      items: form.items,
      deposit,
      total_amount: total || null,
      payment_status: status,
      note: form.note,
    })
    setSaving(false)
    onSaved()
    onClose()
  }

  return (
    <Sheet title="新增訂單" onClose={onClose}>
      <div className="form-group">
        <label className="form-label">客戶名稱</label>
        <input className="form-input" placeholder="例：王小明" value={form.customer} onChange={e => set('customer', e.target.value)} />
      </div>
      <div className="form-group">
        <label className="form-label">訂購商品</label>
        <input className="form-input" placeholder="例：背包×1, 毛巾×2" value={form.items} onChange={e => set('items', e.target.value)} />
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
        <div className="form-group">
          <label className="form-label">應付總額（NT$）</label>
          <input className="form-input" type="number" placeholder="0" value={form.total_amount} onChange={e => set('total_amount', e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">訂金（NT$）</label>
          <input className="form-input" type="number" placeholder="0" value={form.deposit} onChange={e => set('deposit', e.target.value)} />
        </div>
      </div>
      <div className="form-group">
        <label className="form-label">備註</label>
        <input className="form-input" placeholder="選填" value={form.note} onChange={e => set('note', e.target.value)} />
      </div>
      <button className="btn" onClick={save} disabled={saving}>{saving ? '儲存中…' : '建立訂單'}</button>
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
