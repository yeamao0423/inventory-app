import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

export default function PaymentsPage() {
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState('unpaid')  // 'unpaid' | 'summary'

  useEffect(() => { fetchOrders() }, [])

  async function fetchOrders() {
    const { data } = await supabase.from('orders').select('*').order('created_at', {ascending:false})
    setOrders(data || [])
    setLoading(false)
  }

  const unpaid = orders.filter(o => o.payment_status !== '已付清')
  const allOrders = orders

  const totalReceivable = unpaid.reduce((sum, o) => {
    const bal = (Number(o.total_amount)||0) - (Number(o.deposit)||0)
    return sum + Math.max(0, bal)
  }, 0)

  // 商品彙總
  const itemMap = {}
  allOrders.forEach(o => {
    if (!o.items) return
    o.items.split(',').forEach(part => {
      const m = part.trim().match(/^(.+?)×(\d+)$/)
      if (m) {
        const name = m[1].trim()
        itemMap[name] = (itemMap[name] || 0) + Number(m[2])
      }
    })
  })
  const itemSummary = Object.entries(itemMap).sort((a, b) => b[1] - a[1])

  return (
    <div className="page">
      <div className="ph">
        <div>
          <div className="ph-title">尾款追蹤</div>
          <div className="ph-sub">應收款彙總</div>
        </div>
      </div>

      <div className="stats">
        <div className="stat">
          <div className="stat-val text-red">{unpaid.length}</div>
          <div className="stat-lbl"><span className="dot" style={{background:'var(--red)'}} />待付清</div>
        </div>
        <div className="stat">
          <div className="stat-val fs15 text-amber">NT${totalReceivable.toLocaleString()}</div>
          <div className="stat-lbl">應收尾款</div>
        </div>
      </div>

      {/* 切換 */}
      <div style={{display:'flex',gap:8,marginBottom:16}}>
        {['unpaid','summary'].map(v => (
          <button
            key={v}
            onClick={() => setView(v)}
            style={{
              padding:'7px 16px', borderRadius:20, fontSize:13, fontWeight:600, cursor:'pointer',
              background: view === v ? 'var(--text)' : 'var(--surface)',
              color: view === v ? '#fff' : 'var(--text-3)',
              border: `0.5px solid ${view === v ? 'var(--text)' : 'var(--border)'}`,
              transition:'all .15s',
            }}
          >
            {v === 'unpaid' ? '待付款清單' : '商品彙總'}
          </button>
        ))}
      </div>

      {loading && <div className="empty">載入中…</div>}

      {view === 'unpaid' && (
        <>
          {unpaid.length === 0 && !loading && <div className="empty">🎉 所有訂單已付清！</div>}
          {unpaid.map(o => {
            const balance = (Number(o.total_amount)||0) - (Number(o.deposit)||0)
            return (
              <div className="card" key={o.id}>
                <div className="card-row">
                  <div style={{flex:1}}>
                    <div className="row-sb">
                      <span className="fw600 fs15">{o.customer}</span>
                      <span className="fw600 text-red fs13">NT${Math.max(0,balance).toLocaleString()}</span>
                    </div>
                    <div className="muted fs12 mt8">{o.items}</div>
                  </div>
                </div>
                <div className="card-row row-sb" style={{background:'var(--bg)'}}>
                  <div className="fs12">
                    <span className="muted">應付 </span>
                    <span className="fw600">{o.total_amount ? `NT$${Number(o.total_amount).toLocaleString()}` : '未設定'}</span>
                  </div>
                  <div className="fs12">
                    <span className="muted">已付訂金 </span>
                    <span className="fw600 text-green">NT${(Number(o.deposit)||0).toLocaleString()}</span>
                  </div>
                  <div>
                    {o.payment_status === '已付訂金'
                      ? <span className="badge badge-warn">已付訂金</span>
                      : <span className="badge badge-low">未付</span>
                    }
                  </div>
                </div>
              </div>
            )
          })}
        </>
      )}

      {view === 'summary' && (
        <>
          <div className="sec">所有訂單商品彙總</div>
          {itemSummary.length === 0 && <div className="empty">無資料</div>}
          <div className="card">
            {itemSummary.map(([name, qty], i) => (
              <div key={i} className="card-row row-sb">
                <span className="fs14">{name}</span>
                <span className="fw600 fs15">× {qty}</span>
              </div>
            ))}
          </div>

          <div className="sec">訂單統計</div>
          <div className="stats">
            <div className="stat">
              <div className="stat-val">{allOrders.length}</div>
              <div className="stat-lbl">總訂單數</div>
            </div>
            <div className="stat">
              <div className="stat-val text-green">
                NT${allOrders.reduce((s,o) => s + (Number(o.deposit)||0), 0).toLocaleString()}
              </div>
              <div className="stat-lbl">已收款合計</div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
