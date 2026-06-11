import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'

// 店家設定（僅店主）：把過去寫死在程式裡的營運參數搬進 stores.settings
// 新店主首次進入（settings 為空）時作為開店精靈使用
export default function SettingsPage() {
  const { profile, store, storeId, refreshStore } = useAuth()
  const isOwner = profile?.role === 'super_admin'

  const [form, setForm] = useState({
    shipping_fee: 60,
    free_shipping_threshold: 3800,
    sender_name: '',
    sender_phone: '',
    sender_email: '',
    return_store_name: '',
    return_store_number: '',
    package_value: 999,
  })
  const [storeName, setStoreName] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  const isFirstSetup = store && Object.keys(store.settings ?? {}).length === 0

  useEffect(() => {
    if (!store) return
    setStoreName(store.name ?? '')
    setForm(prev => ({ ...prev, ...(store.settings ?? {}) }))
  }, [store])

  const set = (key) => (e) => {
    const v = e.target.value
    setForm(prev => ({ ...prev, [key]: e.target.type === 'number' ? (v === '' ? '' : Number(v)) : v }))
    setSaved(false)
  }

  async function save(e) {
    e.preventDefault()
    setError(''); setSaving(true)
    const { error: err } = await supabase
      .from('stores')
      .update({ name: storeName.trim(), settings: form })
      .eq('id', storeId)
    if (err) setError('儲存失敗：' + err.message)
    else {
      await refreshStore()
      setSaved(true)
    }
    setSaving(false)
  }

  if (!isOwner) return (
    <div className="page">
      <div className="empty" style={{ paddingTop: 80 }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>🔒</div>
        <div>僅店主可存取店家設定</div>
      </div>
    </div>
  )

  const inputRow = (label, key, type = 'text', placeholder = '') => (
    <div className="form-group" style={{ marginBottom: 10 }}>
      <label className="form-label">{label}</label>
      <input className="form-input" type={type} placeholder={placeholder}
        value={form[key] ?? ''} onChange={set(key)} />
    </div>
  )

  return (
    <div className="page">
      <div className="ph">
        <div>
          <div className="ph-title">店家設定</div>
          <div className="ph-sub">{store?.name}（/{store?.slug}）</div>
        </div>
      </div>

      {isFirstSetup && (
        <div className="card" style={{ padding: 16, marginBottom: 16, background: 'var(--blue-bg)', border: 'none' }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--blue)', marginBottom: 4 }}>🎉 歡迎開店！</div>
          <div style={{ fontSize: 13, color: 'var(--blue)', lineHeight: 1.6 }}>
            完成以下設定後，即可到「成員」邀請團隊、到「庫存」建立商品。
          </div>
        </div>
      )}

      <form onSubmit={save}>
        <div className="sec">商店資訊</div>
        <div className="card" style={{ padding: 16 }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">商店名稱</label>
            <input className="form-input" type="text" value={storeName}
              onChange={e => { setStoreName(e.target.value); setSaved(false) }} required />
          </div>
        </div>

        <div className="sec">運費</div>
        <div className="card" style={{ padding: 16 }}>
          {inputRow('運費（NT$）', 'shipping_fee', 'number', '60')}
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">免運門檻（NT$，商品小計達此金額免運）</label>
            <input className="form-input" type="number" placeholder="3800"
              value={form.free_shipping_threshold ?? ''} onChange={set('free_shipping_threshold')} />
          </div>
        </div>

        <div className="sec">出貨單寄件人（交貨便匯出用）</div>
        <div className="card" style={{ padding: 16 }}>
          {inputRow('寄件人姓名', 'sender_name', 'text', '例：徐承豊')}
          {inputRow('寄件人電話', 'sender_phone', 'text', '例：0955367287')}
          {inputRow('寄件人 Email', 'sender_email', 'text', '例：daigogosg@gmail.com')}
          {inputRow('退貨門市', 'return_store_name', 'text', '例：和復門市')}
          {inputRow('退貨門市店號', 'return_store_number', 'text', '例：263115')}
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">實際包裹價值（NT$）</label>
            <input className="form-input" type="number" placeholder="999"
              value={form.package_value ?? ''} onChange={set('package_value')} />
          </div>
        </div>

        {error && <div className="error-msg" style={{ marginTop: 12 }}>{error}</div>}

        <button className="btn" type="submit" disabled={saving} style={{ marginTop: 16 }}>
          {saving ? '儲存中…' : saved ? '✓ 已儲存' : '儲存設定'}
        </button>
      </form>
    </div>
  )
}
