import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import { compressImage } from '../lib/imageUtils'
import { SHARE_VARS, DEFAULT_SHARE_TEMPLATE, resolveShopBaseUrl } from '../lib/socialShare'
import { revalidateShop } from '../lib/revalidateShop'

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
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const [cacheState, setCacheState] = useState('idle') // idle | clearing | done

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

  // Logo 上傳：壓縮後存進公開 bucket product-images 的 logos/ 路徑，url 寫入 settings.logo_url
  async function onLogoChange(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploadingLogo(true); setError('')
    try {
      const compressed = await compressImage(file)
      const ext = compressed.name.split('.').pop().toLowerCase()
      const path = `logos/${storeId}-${Date.now()}.${ext}`
      const { error: upErr } = await supabase.storage.from('product-images').upload(path, compressed, { upsert: true })
      if (upErr) throw upErr
      const { data: { publicUrl } } = supabase.storage.from('product-images').getPublicUrl(path)
      setForm(prev => ({ ...prev, logo_url: publicUrl }))
      setSaved(false)
    } catch (err) {
      setError('Logo 上傳失敗：' + err.message)
    }
    setUploadingLogo(false)
  }
  function removeLogo() {
    setForm(prev => ({ ...prev, logo_url: '' }))
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
      // 設定（店名/Logo/運費等）會影響商城顯示 → 通知商城清快取
      revalidateShop({ storeId, slug: store?.slug })
      setSaved(true)
    }
    setSaving(false)
  }

  // 手動清除商城快取（強制全體同步）
  async function clearShopCache() {
    setCacheState('clearing')
    await revalidateShop({ storeId, slug: store?.slug })
    setCacheState('done')
    setTimeout(() => setCacheState('idle'), 2500)
  }

  if (!isOwner) return (
    <div className="page">
      <div className="empty" style={{ paddingTop: 80 }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>🔒</div>
        <div>僅店主可存取店家設定</div>
      </div>
    </div>
  )

  const inputRow = (label, key, type = 'text', placeholder = '', required = false) => (
    <div className="form-group" style={{ marginBottom: 10 }}>
      <label className="form-label">
        {label}
        {required && (
          <span style={{ color: 'var(--red)', fontSize: 11, marginLeft: 6, fontWeight: 600 }}>
            匯出出貨單必填
          </span>
        )}
      </label>
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
            這些設定都可日後再填，現在就能到「庫存」建立商品。<br/>
            標示「匯出出貨單必填」的欄位，等你要匯出交貨便出貨單時填好即可。
          </div>
        </div>
      )}

      <form onSubmit={save}>
        <div className="sec">商店資訊</div>
        <div className="card" style={{ padding: 16 }}>
          <div className="form-group" style={{ marginBottom: 14 }}>
            <label className="form-label">商店名稱</label>
            <input className="form-input" type="text" value={storeName}
              onChange={e => { setStoreName(e.target.value); setSaved(false) }} required />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">商店 Logo（顯示於後台與商城；未設定則顯示購物袋圖示＋店名）</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 56, height: 56, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 }}>
                {form.logo_url
                  ? <img src={form.logo_url} alt="logo" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : <span style={{ fontSize: 22 }}>🛍️</span>}
              </div>
              <label className="btn" style={{ width: 'auto', display: 'inline-block', padding: '8px 14px', fontSize: 13, cursor: 'pointer' }}>
                {uploadingLogo ? '上傳中…' : (form.logo_url ? '更換 Logo' : '上傳 Logo')}
                <input type="file" accept="image/*" style={{ display: 'none' }} onChange={onLogoChange} disabled={uploadingLogo} />
              </label>
              {form.logo_url && (
                <button type="button" onClick={removeLogo}
                  style={{ background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer', fontSize: 13 }}>移除</button>
              )}
            </div>
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 6 }}>品牌顯示方式（後台側邊欄與商城導覽列）</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
                {[
                  { v: 'both', label: 'Logo＋店名' },
                  { v: 'logo', label: '只顯示 Logo' },
                  { v: 'name', label: '只顯示店名' },
                ].map(o => (
                  <label key={o.v} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                    <input type="radio" name="brand_display" value={o.v}
                      checked={(form.brand_display || 'both') === o.v}
                      onChange={() => { setForm(prev => ({ ...prev, brand_display: o.v })); setSaved(false) }} />
                    {o.label}
                  </label>
                ))}
              </div>
            </div>
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

        <div className="sec">匯款資訊（顯示於消費者訂單確認信）</div>
        <div className="card" style={{ padding: 16 }}>
          {inputRow('銀行名稱', 'bank_name', 'text', '例：中華郵政')}
          {inputRow('銀行代碼', 'bank_code', 'text', '例：700')}
          {inputRow('匯款帳號', 'bank_account', 'text', '例：0000000 0000000')}
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">戶名（選填）</label>
            <input className="form-input" type="text" placeholder="例：徐承豊"
              value={form.bank_account_holder ?? ''} onChange={set('bank_account_holder')} />
          </div>
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-3)' }}>
            未填匯款帳號時，訂單信會顯示「匯款帳號請洽客服取得」。
          </div>
        </div>

        <div className="sec">客服聯絡（顯示於通知信 footer 與新訂單通知）</div>
        <div className="card" style={{ padding: 16 }}>
          {inputRow('客服 LINE 連結', 'contact_line_url', 'text', '例：https://line.me/R/ti/p/@xxxxxx')}
          {inputRow('客服 Email', 'contact_email', 'text', '例：service@yourshop.com')}
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">新訂單通知信箱（收到客戶下單通知；留空則用客服 Email）</label>
            <input className="form-input" type="text" placeholder="例：owner@yourshop.com"
              value={form.order_notify_email ?? ''} onChange={set('order_notify_email')} />
          </div>
        </div>

        <div className="sec">社群分享</div>
        <div className="card" style={{ padding: 16 }}>
          <div className="form-group" style={{ marginBottom: 10 }}>
            <label className="form-label">分享文案模板</label>
            <textarea className="form-input" rows={5}
              style={{ resize: 'vertical', lineHeight: 1.6, fontFamily: 'inherit' }}
              placeholder={DEFAULT_SHARE_TEMPLATE}
              value={form.share_template ?? ''}
              onChange={e => { setForm(prev => ({ ...prev, share_template: e.target.value })); setSaved(false) }} />
            <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: 'var(--text-2)' }}>可用變數：</span>
              {SHARE_VARS.map(v => (
                <button type="button" key={v.token} title={v.desc}
                  onClick={() => { setForm(prev => ({ ...prev, share_template: (prev.share_template ?? '') + v.token })); setSaved(false) }}
                  style={{ fontSize: 12, padding: '2px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', cursor: 'pointer', color: 'var(--text)' }}>
                  {v.token}
                </button>
              ))}
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-3)' }}>
              留空則使用預設文案。商品分享連結會自動帶入，網址為：
              <span style={{ color: 'var(--text-2)' }}> {resolveShopBaseUrl(store) || '（尚未設定網域）'}/products/…</span>
            </div>
          </div>
        </div>

        <div className="sec">出貨單寄件人（交貨便匯出用，可日後要匯出時再填）</div>
        <div className="card" style={{ padding: 16 }}>
          {inputRow('寄件人姓名', 'sender_name', 'text', '例：徐承豊', true)}
          {inputRow('寄件人電話', 'sender_phone', 'text', '例：0955367287', true)}
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

      <div className="sec" style={{ marginTop: 24 }}>商城快取</div>
      <div className="card" style={{ padding: 16 }}>
        <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 12 }}>
          商城為了速度會把頁面快取起來。一般情況下你改商品或設定時系統會自動刷新；
          若發現商城沒即時更新，可手動清除快取強制全體同步。
        </div>
        <button type="button" className="btn" onClick={clearShopCache}
          disabled={cacheState === 'clearing'}
          style={{ width: 'auto', display: 'inline-block', padding: '8px 16px', fontSize: 13 }}>
          {cacheState === 'clearing' ? '清除中…' : cacheState === 'done' ? '✓ 已清除，商城已同步' : '重新整理商城快取'}
        </button>
      </div>
    </div>
  )
}
