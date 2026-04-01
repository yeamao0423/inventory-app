import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'

const LOW = 10

export default function InventoryPage() {
  const { profile, signOut, can } = useAuth()
  const [products, setProducts] = useState([])
  const [search, setSearch] = useState('')
  const [sheet, setSheet] = useState(null)   // null | 'add' | product obj
  const [loading, setLoading] = useState(true)

  useEffect(() => { fetchProducts() }, [])

  async function fetchProducts() {
    const { data } = await supabase.from('products').select('*').order('name')
    setProducts(data || [])
    setLoading(false)
  }

  const filtered = products.filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    p.sku.toLowerCase().includes(search.toLowerCase())
  )
  const low = filtered.filter(p => p.quantity <= LOW)
  const normal = filtered.filter(p => p.quantity > LOW)

  return (
    <div className="page">
      <div className="ph">
        <div>
          <div className="ph-title">庫存總覽</div>
          <div className="ph-sub">
            {profile?.name || '成員'} · {profile?.role === 'admin' ? '管理員' : profile?.role === 'editor' ? '編輯' : '檢視者'}
          </div>
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          {can('add') && (
            <button className="icon-btn" onClick={() => setSheet('add')}>+</button>
          )}
          <button
            onClick={signOut}
            style={{background:'none',border:'none',fontSize:13,color:'var(--text-3)',cursor:'pointer',padding:'6px 0'}}
          >登出</button>
        </div>
      </div>

      <div className="stats">
        <div className="stat">
          <div className="stat-val">{products.length}</div>
          <div className="stat-lbl">商品種類</div>
        </div>
        <div className="stat">
          <div className="stat-val text-red">{products.filter(p => p.quantity <= LOW).length}</div>
          <div className="stat-lbl"><span className="dot" style={{background:'var(--red)'}} />低庫存</div>
        </div>
      </div>

      <div className="search">
        <span style={{fontSize:16}}>🔍</span>
        <input
          placeholder="搜尋商品名稱或 SKU…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {loading && <div className="empty">載入中…</div>}

      {low.length > 0 && (
        <>
          <div className="sec">⚠ 低庫存警示</div>
          {low.map(p => <ProductRow key={p.id} product={p} onTap={() => setSheet(p)} low />)}
        </>
      )}

      {normal.length > 0 && (
        <>
          <div className="sec">所有商品</div>
          {normal.map(p => <ProductRow key={p.id} product={p} onTap={() => setSheet(p)} />)}
        </>
      )}

      {filtered.length === 0 && !loading && (
        <div className="empty">找不到符合的商品</div>
      )}

      {sheet === 'add' && (
        <AddProductSheet onClose={() => setSheet(null)} onSaved={fetchProducts} />
      )}
      {sheet && sheet !== 'add' && (
        <ProductDetailSheet
          product={sheet}
          onClose={() => setSheet(null)}
          onSaved={fetchProducts}
          canEdit={can('edit')}
          canDelete={can('delete')}
        />
      )}
    </div>
  )
}

function ProductRow({ product: p, onTap, low }) {
  return (
    <div className="card" onClick={onTap} style={{cursor:'pointer'}}>
      <div className="card-row">
        <div className="item-icon">📦</div>
        <div style={{flex:1,minWidth:0}}>
          <div className="fw600 fs15" style={{whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{p.name}</div>
          <div className="muted fs12 mt8">{p.sku} · {p.cost} {p.currency}</div>
        </div>
        <div style={{textAlign:'right',flexShrink:0}}>
          <div className="fw600 fs15" style={{color: low ? 'var(--red)' : 'var(--text)'}}>{p.quantity}</div>
          <div className="fs12 mt8">
            <span className={`badge ${low ? 'badge-low' : 'badge-ok'}`}>{low ? '低庫存' : '正常'}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function AddProductSheet({ onClose, onSaved }) {
  const [form, setForm] = useState({ name:'', sku:'', quantity:'', unit:'個', cost:'', currency:'TWD' })
  const [saving, setSaving] = useState(false)
  const set = (k, v) => setForm(f => ({...f, [k]: v}))

  async function save() {
    if (!form.name || !form.sku || form.quantity === '') return
    setSaving(true)
    await supabase.from('products').insert({
      name: form.name,
      sku: form.sku.toUpperCase(),
      quantity: Number(form.quantity),
      unit: form.unit,
      cost: Number(form.cost),
      currency: form.currency,
    })
    await supabase.from('history').insert({
      sku: form.sku.toUpperCase(),
      change: Number(form.quantity),
      reason: '初始建立',
    })
    setSaving(false)
    onSaved()
    onClose()
  }

  return (
    <Sheet title="新增商品" onClose={onClose}>
      <div className="form-group">
        <label className="form-label">商品名稱</label>
        <input className="form-input" placeholder="例：防水噴霧 500ml" value={form.name} onChange={e => set('name', e.target.value)} />
      </div>
      <div className="form-group">
        <label className="form-label">SKU 代碼</label>
        <input className="form-input" placeholder="例：SPRAY-001" value={form.sku} onChange={e => set('sku', e.target.value)} style={{textTransform:'uppercase'}} />
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
        <div className="form-group">
          <label className="form-label">初始數量</label>
          <input className="form-input" type="number" placeholder="0" value={form.quantity} onChange={e => set('quantity', e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">單位</label>
          <input className="form-input" placeholder="個" value={form.unit} onChange={e => set('unit', e.target.value)} />
        </div>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
        <div className="form-group">
          <label className="form-label">進貨成本</label>
          <input className="form-input" type="number" placeholder="0" value={form.cost} onChange={e => set('cost', e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">幣別</label>
          <select className="form-select" value={form.currency} onChange={e => set('currency', e.target.value)}>
            <option>TWD</option><option>USD</option><option>JPY</option><option>EUR</option>
          </select>
        </div>
      </div>
      <button className="btn" onClick={save} disabled={saving}>{saving ? '儲存中…' : '新增商品'}</button>
    </Sheet>
  )
}

function ProductDetailSheet({ product, onClose, onSaved, canEdit, canDelete }) {
  const [change, setChange] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [history, setHistory] = useState([])

  useEffect(() => {
    supabase.from('history').select('*').eq('sku', product.sku).order('created_at', {ascending:false}).limit(10)
      .then(({ data }) => setHistory(data || []))
  }, [product.sku])

  async function updateStock() {
    if (!change) return
    setSaving(true)
    const delta = Number(change)
    const newQty = Math.max(0, product.quantity + delta)
    await supabase.from('products').update({ quantity: newQty }).eq('id', product.id)
    await supabase.from('history').insert({ sku: product.sku, change: delta, reason: reason || '手動調整' })
    setSaving(false)
    onSaved()
    onClose()
  }

  async function deleteProduct() {
    if (!window.confirm(`確定刪除「${product.name}」？`)) return
    await supabase.from('products').delete().eq('id', product.id)
    onSaved()
    onClose()
  }

  return (
    <Sheet title={product.name} onClose={onClose}>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8,marginBottom:20}}>
        <div className="stat"><div className="stat-val">{product.quantity}</div><div className="stat-lbl">{product.unit}</div></div>
        <div className="stat"><div className="stat-val fs15">{product.cost}</div><div className="stat-lbl">{product.currency}</div></div>
        <div className="stat"><div className="stat-val fs15">{product.sku}</div><div className="stat-lbl">SKU</div></div>
      </div>

      {canEdit && (
        <>
          <div className="form-group">
            <label className="form-label">數量變動（正數入庫，負數出庫）</label>
            <input className="form-input" type="number" placeholder="+50 或 -10" value={change} onChange={e => setChange(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">原因</label>
            <input className="form-input" placeholder="進貨 / 銷售 / 盤點…" value={reason} onChange={e => setReason(e.target.value)} />
          </div>
          <button className="btn" onClick={updateStock} disabled={saving} style={{marginBottom:16}}>
            {saving ? '更新中…' : '更新庫存'}
          </button>
        </>
      )}

      {history.length > 0 && (
        <>
          <div className="sec">異動紀錄</div>
          <div className="card">
            {history.map((h, i) => (
              <div key={i} className="card-row row-sb">
                <div>
                  <div className="fs13 fw600" style={{color: h.change > 0 ? 'var(--green)' : 'var(--red)'}}>
                    {h.change > 0 ? '+' : ''}{h.change}
                  </div>
                  <div className="fs12 muted">{h.reason}</div>
                </div>
                <div className="fs12 muted">{h.created_at?.slice(0,16)}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {canDelete && (
        <button className="btn btn-danger" onClick={deleteProduct} style={{marginTop:8}}>刪除商品</button>
      )}
    </Sheet>
  )
}

// ── Shared Sheet wrapper ───────────────────────────
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
