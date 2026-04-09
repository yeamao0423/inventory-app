import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'

const CURRENCIES = [
  { code: 'USD', flag: '🇺🇸', name: '美元' },
  { code: 'JPY', flag: '🇯🇵', name: '日圓', per100: true },
  { code: 'EUR', flag: '🇪🇺', name: '歐元' },
  { code: 'GBP', flag: '🇬🇧', name: '英鎊' },
  { code: 'CNY', flag: '🇨🇳', name: '人民幣' },
  { code: 'KRW', flag: '🇰🇷', name: '韓元', per1000: true },
  { code: 'VND', flag: '🇻🇳', name: '越南盾', per1000: true },
]

// Format rate display — VND/KRW show per 1000, JPY per 100
function fmtRate(code, rate) {
  const cur = CURRENCIES.find(c => c.code === code)
  if (cur?.per1000) return `1,000 ${code} = ${(rate * 1000).toFixed(2)} TWD`
  if (cur?.per100)  return `100 ${code} = ${(rate * 100).toFixed(2)} TWD`
  return `1 ${code} = ${Number(rate).toFixed(4)} TWD`
}

function costToTwd(cost, currency, rate) {
  return cost * rate
}

export default function RatePage() {
  const { can } = useAuth()
  const [rates, setRates]     = useState([])
  const [products, setProducts] = useState([])
  const [calcSku, setCalcSku] = useState('')
  const [markup, setMarkup]   = useState(30)
  const [newCur, setNewCur]   = useState('USD')
  const [newRate, setNewRate] = useState('')
  const [saving, setSaving]   = useState(false)

  useEffect(() => {
    supabase.from('exchange_rates').select('*').order('currency')
      .then(({ data }) => setRates(data || []))
    supabase.from('products').select('id,name,sku,cost,currency').order('name')
      .then(({ data }) => setProducts(data || []))
  }, [])

  async function saveRate() {
    if (!newRate) return
    setSaving(true)
    await supabase.from('exchange_rates')
      .upsert({ currency: newCur, rate: Number(newRate) }, { onConflict: 'currency' })
    const { data } = await supabase.from('exchange_rates').select('*').order('currency')
    setRates(data || [])
    setNewRate('')
    setSaving(false)
  }

  const rateMap = Object.fromEntries(rates.map(r => [r.currency, Number(r.rate)]))
  const selectedProduct = products.find(p => p.sku === calcSku)
  let costTwd = null, suggest = null, noRate = false
  if (selectedProduct) {
    const rate = selectedProduct.currency === 'TWD' ? 1 : rateMap[selectedProduct.currency]
    if (rate) {
      costTwd = costToTwd(selectedProduct.cost, selectedProduct.currency, rate)
      suggest = costTwd * (1 + markup / 100)
    } else {
      noRate = true
    }
  }

  return (
    <div className="page">
      <div className="ph">
        <div>
          <div className="ph-title">匯率 & 售價</div>
          <div className="ph-sub">自動換算 TWD 建議售價</div>
        </div>
      </div>

      {/* Current rates */}
      <div className="sec">目前匯率</div>
      {rates.length === 0 && <div className="empty muted fs13">尚未設定匯率</div>}
      <div className="card" style={{ marginBottom: 12 }}>
        {rates.map((r, i) => {
          const meta = CURRENCIES.find(c => c.code === r.currency)
          return (
            <div key={i} className="card-row row-sb">
              <div className="row gap8">
                <span style={{ fontSize: 22 }}>{meta?.flag || '💱'}</span>
                <div>
                  <div className="fw600 fs15">{r.currency}</div>
                  <div className="muted fs12">{meta?.name || ''}</div>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="fw600 fs13">{fmtRate(r.currency, r.rate)}</div>
                <div className="muted fs12">{r.updated_at?.slice(0, 10)}</div>
              </div>
            </div>
          )
        })}
      </div>

      {/* VND helper note */}
      <div style={{ background: '#E6F5F5', borderRadius: 10, padding: '10px 14px', fontSize: 12, color: '#085041', marginBottom: 16 }}>
        🇻🇳 越南盾（VND）已支援！輸入匯率時請填寫「1 VND = ? TWD」的值，例如：0.00122（即 1 TWD ≈ 820 VND）
      </div>

      {/* Set rate */}
      {can('edit') && (
        <>
          <div className="sec">設定 / 更新匯率</div>
          <div className="card" style={{ padding: 14, marginBottom: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
              <div>
                <label className="form-label fs12">幣別</label>
                <select className="form-select" value={newCur} onChange={e => setNewCur(e.target.value)}>
                  {CURRENCIES.map(c => (
                    <option key={c.code} value={c.code}>{c.flag} {c.code} {c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="form-label fs12">
                  {newCur === 'VND' ? '1 VND = ? TWD（例如 0.00122）'
                   : newCur === 'JPY' ? '1 JPY = ? TWD（例如 0.218）'
                   : newCur === 'KRW' ? '1 KRW = ? TWD（例如 0.024）'
                   : `1 ${newCur} = ? TWD`}
                </label>
                <input
                  className="form-input"
                  type="number"
                  step="0.00001"
                  placeholder={newCur === 'VND' ? '例：0.00122' : newCur === 'JPY' ? '例：0.218' : '例：32.5'}
                  value={newRate}
                  onChange={e => setNewRate(e.target.value)}
                />
              </div>
            </div>
            <button className="btn" onClick={saveRate} disabled={saving}>
              {saving ? '儲存中…' : '儲存匯率'}
            </button>
          </div>
        </>
      )}

      {/* Price calculator */}
      <div className="sec">售價試算</div>
      <div className="card" style={{ padding: 14 }}>
        <div className="form-group">
          <label className="form-label">選擇商品</label>
          <select className="form-select" value={calcSku} onChange={e => setCalcSku(e.target.value)}>
            <option value="">— 選擇商品 —</option>
            {products.map(p => (
              <option key={p.sku} value={p.sku}>
                {p.name}（{p.sku}）· {p.currency}
              </option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label className="form-label">加成比例：{markup}%</label>
          <input
            type="range" min="5" max="200" step="5" value={markup}
            onChange={e => setMarkup(Number(e.target.value))}
            style={{ width: '100%', marginTop: 4 }}
          />
        </div>

        {selectedProduct && !noRate && costTwd !== null && (
          <div style={{ background: 'var(--bg)', borderRadius: 12, padding: 14, marginTop: 8 }}>
            <Row label="進貨成本" value={`${fmtCost(selectedProduct.cost, selectedProduct.currency)}`} />
            {selectedProduct.currency !== 'TWD' && (
              <Row label="換算 TWD" value={`NT$${Math.round(costTwd).toLocaleString()}`} />
            )}
            <Row label={`加成 ${markup}%`} value={`+NT$${Math.round(costTwd * markup / 100).toLocaleString()}`} green />
            <div style={{ height: '0.5px', background: 'var(--border-light)', margin: '8px 0' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 18, fontWeight: 700 }}>
              <span>建議售價</span>
              <span>NT${Math.round(suggest).toLocaleString()}</span>
            </div>
          </div>
        )}

        {noRate && selectedProduct && (
          <div style={{ background: 'var(--red-bg)', borderRadius: 10, padding: '10px 14px', fontSize: 13, color: 'var(--red)', marginTop: 8 }}>
            找不到 {selectedProduct.currency} 匯率，請先在上方設定。
          </div>
        )}
      </div>
    </div>
  )
}

function fmtCost(cost, currency) {
  if (currency === 'VND') return `${Number(cost).toLocaleString()} VND`
  if (currency === 'JPY' || currency === 'KRW') return `${Number(cost).toLocaleString()} ${currency}`
  return `${cost} ${currency}`
}

function Row({ label, value, green }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--text-2)', marginBottom: 6 }}>
      <span>{label}</span>
      <span style={green ? { color: 'var(--green)', fontWeight: 600 } : {}}>{value}</span>
    </div>
  )
}
