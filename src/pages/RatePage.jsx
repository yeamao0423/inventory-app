import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'

export default function RatePage() {
  const { can } = useAuth()
  const [rates, setRates] = useState([])
  const [products, setProducts] = useState([])
  const [calcSku, setCalcSku] = useState('')
  const [markup, setMarkup] = useState(30)
  const [newCur, setNewCur] = useState('USD')
  const [newRate, setNewRate] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    supabase.from('exchange_rates').select('*').then(({ data }) => setRates(data || []))
    supabase.from('products').select('id,name,sku,cost,currency').order('name').then(({ data }) => setProducts(data || []))
  }, [])

  async function saveRate() {
    if (!newRate) return
    setSaving(true)
    await supabase.from('exchange_rates').upsert({ currency: newCur, rate: Number(newRate) }, { onConflict: 'currency' })
    const { data } = await supabase.from('exchange_rates').select('*')
    setRates(data || [])
    setNewRate('')
    setSaving(false)
  }

  const rateMap = Object.fromEntries(rates.map(r => [r.currency, r.rate]))
  const selectedProduct = products.find(p => p.sku === calcSku)
  let costTwd = null, suggest = null
  if (selectedProduct) {
    const rate = selectedProduct.currency === 'TWD' ? 1 : rateMap[selectedProduct.currency]
    if (rate) {
      costTwd = selectedProduct.cost * rate
      suggest = costTwd * (1 + markup / 100)
    }
  }

  const FLAGS = { USD:'🇺🇸', JPY:'🇯🇵', EUR:'🇪🇺', GBP:'🇬🇧', CNY:'🇨🇳', KRW:'🇰🇷' }

  return (
    <div className="page">
      <div className="ph">
        <div>
          <div className="ph-title">匯率 & 售價</div>
          <div className="ph-sub">自動換算 TWD</div>
        </div>
      </div>

      <div className="sec">目前匯率（1 外幣 = ? TWD）</div>
      {rates.length === 0 && <div className="empty muted fs13">尚未設定匯率</div>}
      <div className="card" style={{marginBottom:12}}>
        {rates.map((r, i) => (
          <div key={i} className="card-row row-sb">
            <div className="row gap8">
              <span style={{fontSize:22}}>{FLAGS[r.currency] || '💱'}</span>
              <div>
                <div className="fw600 fs15">{r.currency}</div>
                <div className="muted fs12">更新：{r.updated_at?.slice(0,10)}</div>
              </div>
            </div>
            <div className="fw600">1 {r.currency} = {r.rate} TWD</div>
          </div>
        ))}
      </div>

      {can('edit') && (
        <>
          <div className="sec">設定匯率</div>
          <div className="card" style={{padding:'14px',marginBottom:16}}>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
              <div>
                <label className="form-label fs12">幣別</label>
                <select className="form-select" value={newCur} onChange={e => setNewCur(e.target.value)}>
                  {['USD','JPY','EUR','GBP','CNY','KRW'].map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="form-label fs12">匯率（對 TWD）</label>
                <input className="form-input" type="number" placeholder="例：32.5" value={newRate} onChange={e => setNewRate(e.target.value)} />
              </div>
            </div>
            <button className="btn" onClick={saveRate} disabled={saving}>{saving ? '儲存中…' : '儲存匯率'}</button>
          </div>
        </>
      )}

      <div className="sec">售價試算</div>
      <div className="card" style={{padding:'14px'}}>
        <div className="form-group">
          <label className="form-label">選擇商品</label>
          <select className="form-select" value={calcSku} onChange={e => setCalcSku(e.target.value)}>
            <option value="">— 選擇商品 —</option>
            {products.map(p => (
              <option key={p.sku} value={p.sku}>{p.name}（{p.sku}）</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label className="form-label">加成比例：{markup}%</label>
          <input
            type="range" min="5" max="100" step="5" value={markup}
            onChange={e => setMarkup(Number(e.target.value))}
            style={{width:'100%',marginTop:4}}
          />
        </div>

        {selectedProduct && costTwd !== null && (
          <div style={{background:'var(--bg)',borderRadius:12,padding:'14px',marginTop:8}}>
            <div style={{display:'flex',justifyContent:'space-between',fontSize:13,color:'var(--text-2)',marginBottom:6}}>
              <span>進貨成本</span><span>{selectedProduct.cost} {selectedProduct.currency}</span>
            </div>
            <div style={{display:'flex',justifyContent:'space-between',fontSize:13,color:'var(--text-2)',marginBottom:6}}>
              <span>換算 TWD</span><span>NT${costTwd.toFixed(0)}</span>
            </div>
            <div style={{display:'flex',justifyContent:'space-between',fontSize:13,color:'var(--text-2)',marginBottom:8}}>
              <span>加成 {markup}%</span><span style={{color:'var(--green)',fontWeight:600}}>+NT${(costTwd * markup/100).toFixed(0)}</span>
            </div>
            <div style={{height:'0.5px',background:'var(--border-light)',marginBottom:8}} />
            <div style={{display:'flex',justifyContent:'space-between',fontSize:17,fontWeight:700}}>
              <span>建議售價</span><span>NT${Math.round(suggest).toLocaleString()}</span>
            </div>
          </div>
        )}

        {selectedProduct && costTwd === null && (
          <div className="error-msg" style={{marginTop:8}}>
            找不到 {selectedProduct.currency} 匯率，請先設定。
          </div>
        )}
      </div>
    </div>
  )
}
