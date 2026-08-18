import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import { compressImage } from '../lib/imageUtils'
import { SHARE_VARS, DEFAULT_SHARE_TEMPLATE, resolveShopBaseUrl } from '../lib/socialShare'
import { revalidateShop } from '../lib/revalidateShop'
import { utcToLocal, localToISO } from '../lib/datetime'
import BrandColorPicker from '../components/BrandColorPicker'

// 店家設定（僅店主）：把過去寫死在程式裡的營運參數搬進 stores.settings
// 新店主首次進入（settings 為空）時作為開店精靈使用
export default function SettingsPage() {
  const { profile, store, storeId, refreshStore, isPlatformAdmin } = useAuth()
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
  // LINE Channel Secret 為寫入型欄位：值只進不出（存 store_line_secrets，非 settings），
  // 已否設定看 settings.line_channel_secret_set 旗標
  const [lineSecret, setLineSecret] = useState('')
  // 綠界金物流：整組存 store_ecpay_secrets（零 client policy）。env／cod_max／兩個特店編號
  // （merchant_id、logistics_merchant_id）不算機密 —— 本來就會出現在送往綠界的付款表單裡，
  // 消費者瀏覽器看得到 —— 這四個會被 RPC 併回 settings.ecpay_* 供這裡回顯；HashKey/HashIV/
  // 寄件人資訊仍是值只進不出，重整頁面後顯示為空、留空送出＝維持原值（不是清空）。
  // 走獨立的 saveEcpay()，不掛在下面的店家設定主表單裡 —— 避免店主改運費時，若這幾個欄位
  // 剛好是空的一併送出，這裡曾經有個陷阱：RPC 舊版把「特店編號留空」當「清除整組設定」，
  // 現在已改成只有明確按下「清除綠界設定」（p_clear=true）才會刪，其餘所有欄位留空都是維持原值。
  const [ecpayForm, setEcpayForm] = useState({
    env: 'stage', merchant_id: '', hash_key: '', hash_iv: '',
    logistics_merchant_id: '', logistics_hash_key: '', logistics_hash_iv: '',
    sender_name: '', sender_phone: '', cod_max: 20000,
  })
  const [ecpaySaving, setEcpaySaving] = useState(false)
  const [ecpaySaved, setEcpaySaved] = useState(false)
  const [ecpayError, setEcpayError] = useState('')
  const [ecpayClearing, setEcpayClearing] = useState(false)
  const [ecpayEnabled, setEcpayEnabled] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const [cacheState, setCacheState] = useState('idle') // idle | clearing | done
  // 加購截止「指定時間」模式的快選：直接沿用現有團的收單時間，省得手打
  const [recentEnds, setRecentEnds] = useState([])

  const isFirstSetup = store && Object.keys(store.settings ?? {}).length === 0

  useEffect(() => {
    if (!store) return
    setStoreName(store.name ?? '')
    setForm(prev => ({ ...prev, ...(store.settings ?? {}) }))
  }, [store])

  // 只回顯 env／cod_max／兩個特店編號（RPC 有併回 settings 的非機密欄位），HashKey/HashIV/
  // 寄件人資訊保持空白
  useEffect(() => {
    if (!store) return
    setEcpayForm(prev => ({
      ...prev,
      env: store.settings?.ecpay_env || 'stage',
      cod_max: store.settings?.ecpay_cod_max ?? 20000,
      merchant_id: store.settings?.ecpay_merchant_id ?? '',
      logistics_merchant_id: store.settings?.ecpay_logistics_merchant_id ?? '',
    }))
    setEcpayEnabled(!!store.settings?.ecpay_enabled)
  }, [store])

  useEffect(() => {
    if (!storeId) return
    supabase
      .from('storefront_products')
      .select('collection_end')
      .eq('store_id', storeId)
      .not('collection_end', 'is', null)
      .gt('collection_end', new Date().toISOString())
      .order('collection_end', { ascending: false })
      .limit(20)
      .then(({ data }) => {
        setRecentEnds([...new Set((data ?? []).map(r => r.collection_end))].slice(0, 5))
      })
  }, [storeId])

  const set = (key) => (e) => {
    const v = e.target.value
    setForm(prev => ({ ...prev, [key]: e.target.type === 'number' ? (v === '' ? '' : Number(v)) : v }))
    setSaved(false)
  }

  const setEcpay = (key) => (e) => {
    const v = e.target.value
    setEcpayForm(prev => ({ ...prev, [key]: e.target.type === 'number' ? (v === '' ? '' : Number(v)) : v }))
    setEcpaySaved(false)
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
      // Channel Secret 走 RPC 另存（settings 會整包送到商城前端，機密不能放那）；
      // 必須在 stores.update 之後跑，RPC 會把 line_channel_secret_set 旗標併回 settings
      const secretVal = lineSecret.trim()
      if (secretVal) {
        const { error: secErr } = await supabase.rpc('set_line_channel_secret', {
          p_store_id: storeId, p_secret: secretVal,
        })
        if (secErr) { setError('Channel Secret 儲存失敗：' + secErr.message); setSaving(false); return }
        setLineSecret('')
      }
      await refreshStore()
      // 設定（店名/Logo/運費等）會影響商城顯示 → 通知商城清快取
      revalidateShop({ storeId, slug: store?.slug })
      setSaved(true)
    }
    setSaving(false)
  }

  // 綠界金物流：獨立 RPC，成功後把四個 HashKey/HashIV 清空（值只進不出）
  async function saveEcpay(e) {
    e.preventDefault()
    setEcpayError(''); setEcpaySaving(true)
    const { error: err } = await supabase.rpc('set_store_ecpay_credentials', {
      p_store_id: storeId,
      p_env: ecpayForm.env,
      p_merchant_id: ecpayForm.merchant_id,
      p_hash_key: ecpayForm.hash_key,
      p_hash_iv: ecpayForm.hash_iv,
      p_logistics_merchant_id: ecpayForm.logistics_merchant_id,
      p_logistics_hash_key: ecpayForm.logistics_hash_key,
      p_logistics_hash_iv: ecpayForm.logistics_hash_iv,
      p_sender_name: ecpayForm.sender_name,
      p_sender_phone: ecpayForm.sender_phone,
      p_cod_max: Number(ecpayForm.cod_max) || 20000,
      p_clear: false,
    })
    if (err) setEcpayError('儲存失敗：' + err.message)
    else {
      setEcpayForm(prev => ({
        ...prev,
        hash_key: '', hash_iv: '', logistics_hash_key: '', logistics_hash_iv: '',
      }))
      await refreshStore()
      setEcpaySaved(true)
    }
    setEcpaySaving(false)
  }

  // 對外開放開關：與金鑰分開存（非機密，只是 settings 上的布林），
  // 所以走自己的 RPC、按下就生效，不必等「儲存綠界設定」。
  async function toggleEcpayEnabled(next) {
    setEcpayError('')
    setEcpayEnabled(next)                       // 樂觀更新，失敗再轉回來
    const { error: err } = await supabase.rpc('set_store_ecpay_enabled', {
      p_store_id: storeId,
      p_enabled: next,
    })
    if (err) {
      setEcpayEnabled(!next)
      setEcpayError('切換失敗：' + err.message)
      return
    }
    await refreshStore()
  }

  // 清除整組綠界設定（p_clear=true）：獨立動作、需二次確認，因為清掉後結帳頁會立刻
  // 不再顯示綠界付款方式，正在收真錢的店家會直接斷金流
  async function clearEcpay() {
    const ok = window.confirm(
      '確定要清除這家店的綠界金物流設定嗎？\n\n' +
      '清除後該店結帳頁將不再顯示綠界付款方式，且此動作無法復原（要恢復須重新輸入完整金鑰）。'
    )
    if (!ok) return
    setEcpayError(''); setEcpayClearing(true)
    const { error: err } = await supabase.rpc('set_store_ecpay_credentials', {
      p_store_id: storeId,
      p_clear: true,
    })
    if (err) setEcpayError('清除失敗：' + err.message)
    else {
      // 開放開關一併關掉：否則旗標會留著 true，日後重新填金鑰時會直接對外開放，
      // 跳過「先自己走一遍再開」的緩衝
      await supabase.rpc('set_store_ecpay_enabled', { p_store_id: storeId, p_enabled: false })
      setEcpayEnabled(false)
      setEcpayForm({
        env: 'stage', merchant_id: '', hash_key: '', hash_iv: '',
        logistics_merchant_id: '', logistics_hash_key: '', logistics_hash_iv: '',
        sender_name: '', sender_phone: '', cod_max: 20000,
      })
      await refreshStore()
      setEcpaySaved(false)
    }
    setEcpayClearing(false)
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

  const appendMode = form.append_mode || 'off'
  // 指定時間過期後不需要特別處理：算出來的死線已成過去，加購自然關閉
  const appendExpired = appendMode === 'absolute'
    && form.append_until && new Date(form.append_until) < new Date()

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

            {/* 品牌主色：客製化的範圍就是「內容區塊 + 一個主色」，字體與完整主題不開放（見 docs/adr/0006）。
                套用範圍刻意很窄，導覽列與背景一律不動 —— 那會讓各店商城品質參差。 */}
            <div style={{ marginTop: 18 }}>
              <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 6 }}>
                品牌主色（商城的主要按鈕、連結、標籤與價格強調）
              </div>
              <BrandColorPicker
                value={form.brand_color}
                onChange={(hex) => { setForm(prev => ({ ...prev, brand_color: hex })); setSaved(false) }}
              />
            </div>
          </div>
        </div>

        <div className="sec">運費（向客戶收）</div>
        <div className="card" style={{ padding: 16 }}>
          {inputRow('運費（NT$）', 'shipping_fee', 'number', '60')}
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">免運門檻（NT$，商品小計達此金額免運）</label>
            <input className="form-input" type="number" placeholder="3800"
              value={form.free_shipping_threshold ?? ''} onChange={set('free_shipping_threshold')} />
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 6, lineHeight: 1.6 }}>
              填 0 代表全店免運，等於每一單的物流費都由你自己吸收。
            </div>
          </div>
        </div>

        <div className="sec">物流成本（實際付出去）</div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 14, lineHeight: 1.7 }}>
            這是你實際付給物流的錢，跟上面「向客戶收多少」是兩回事。
            有收運費時兩邊相抵、不賺不賠；免運時這筆就是你的淨支出，
            會從行程報告的可分配盈餘裡扣掉。訂單成立時會凍結當下的金額，
            之後調整這裡不會改到已成立的訂單。
          </div>
          {[
            { key: 'default',    label: '未指定物流（匯款自寄）' },
            { key: 'UNIMARTC2C', label: '7-11 超商取貨' },
            { key: 'FAMIC2C',    label: '全家 超商取貨' },
            { key: 'HILIFEC2C',  label: '萊爾富 超商取貨' },
            { key: 'OKMARTC2C',  label: 'OK 超商取貨' },
          ].map(({ key, label }) => (
            <div className="form-group" key={key} style={{ marginBottom: key === 'OKMARTC2C' ? 0 : 14 }}>
              <label className="form-label">{label}（NT$）</label>
              <input
                className="form-input"
                type="number"
                placeholder="60"
                value={form.shipping_costs?.[key] ?? ''}
                onChange={e => {
                  const v = e.target.value
                  setForm(prev => ({
                    ...prev,
                    shipping_costs: { ...(prev.shipping_costs ?? {}), [key]: v === '' ? '' : Number(v) },
                  }))
                  setSaved(false)
                }}
              />
            </div>
          ))}
        </div>

        <div className="sec">加購設定</div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 14, lineHeight: 1.7 }}>
            開放後，消費者可在截止前把新商品追加到已下單的訂單，與原訂單一起出貨、運費只收一次。
            若加購後跨過免運門檻，系統會自動退掉原本收的運費。
          </div>

          {[
            { v: 'off', label: '不開放加購' },
            { v: 'relative', label: '結單後一段時間內可加購' },
            { v: 'absolute', label: '加購截止於指定時間' },
          ].map(o => (
            <label key={o.v} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              fontSize: 14, marginBottom: 8, cursor: 'pointer',
            }}>
              <input type="radio" name="append_mode" value={o.v}
                checked={appendMode === o.v}
                onChange={() => { setForm(prev => ({ ...prev, append_mode: o.v })); setSaved(false) }} />
              {o.label}
            </label>
          ))}

          {appendMode === 'relative' && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '0.5px solid var(--border)' }}>
              <label className="form-label">結單後可加購時數</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input className="form-input" type="number" min="0" placeholder="24"
                  style={{ width: 110 }}
                  value={form.append_hours ?? ''} onChange={set('append_hours')} />
                <span style={{ fontSize: 14, color: 'var(--text-2)' }}>小時</span>
              </div>
              <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-3)', lineHeight: 1.7 }}>
                從訂單內「最晚」的收單截止時間起算 —— 這張單本來就要等最晚那團到齊才能出貨。
                填 0 表示一結單就停止加購。商品若沒設收單截止（純現貨），則從下單時間起算。
              </div>
            </div>
          )}

          {appendMode === 'absolute' && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '0.5px solid var(--border)' }}>
              <label className="form-label">加購截止時間</label>
              <input className="form-input" type="datetime-local"
                value={utcToLocal(form.append_until)}
                onChange={e => {
                  setForm(prev => ({ ...prev, append_until: localToISO(e.target.value) }))
                  setSaved(false)
                }} />

              {recentEnds.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: 'var(--text-3)' }}>沿用收單時間：</span>
                  {recentEnds.map(iso => (
                    <button key={iso} type="button"
                      onClick={() => { setForm(prev => ({ ...prev, append_until: iso })); setSaved(false) }}
                      style={{
                        padding: '3px 9px', borderRadius: 7, border: '0.5px solid var(--border)',
                        background: 'var(--surface)', fontSize: 12, cursor: 'pointer',
                      }}>
                      {new Date(iso).toLocaleString('zh-TW', {
                        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
                      })}
                    </button>
                  ))}
                </div>
              )}

              <div style={{ marginTop: 8, fontSize: 12, color: appendExpired ? 'var(--red)' : 'var(--text-3)', lineHeight: 1.7 }}>
                {appendExpired
                  ? '此時間已過，目前等同不開放加購。開新團時記得更新，或改用「結單後一段時間」讓它自動跟著每團走。'
                  : '所有訂單共用這個截止時間。開新團時要記得手動更新。'}
              </div>
            </div>
          )}
        </div>

        <div className="sec">匯款資訊（顯示於消費者訂單確認信）</div>
        <div className="card" style={{ padding: 16 }}>
          {inputRow('銀行名稱', 'bank_name', 'text', '例：中華郵政')}
          {inputRow('銀行代碼', 'bank_code', 'text', '例：700')}
          {inputRow('匯款帳號', 'bank_account', 'text', '例：0000000 0000000')}
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">戶名（選填）</label>
            <input className="form-input" type="text" placeholder="例：王小明"
              value={form.bank_account_holder ?? ''} onChange={set('bank_account_holder')} />
          </div>
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-3)' }}>
            未填匯款帳號時，訂單信會顯示「匯款帳號請洽客服取得」。
          </div>
        </div>

        <div className="sec">客服聯絡（顯示於商城頁尾、通知信 footer 與新訂單通知）</div>
        <div className="card" style={{ padding: 16 }}>
          {inputRow('客服 LINE 連結', 'contact_line_url', 'text', '例：https://line.me/R/ti/p/@xxxxxx')}
          {inputRow('客服電話', 'contact_phone', 'text', '例：02-12345678')}
          {inputRow('客服 Email', 'contact_email', 'text', '例：service@yourshop.com')}
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">新訂單通知信箱（收到客戶下單通知；留空則用客服 Email）</label>
            <input className="form-input" type="text" placeholder="例：owner@yourshop.com"
              value={form.order_notify_email ?? ''} onChange={set('order_notify_email')} />
          </div>
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-3)' }}>
            客服電話與 Email 會公開顯示在商城每一頁的頁尾（金物流審核需要）。
            留空時會改用「物流設定」的寄件人電話／Email，建議填寫對外的客服聯絡方式。
          </div>
        </div>

        <div className="sec">智慧客服（AI 自動回覆）</div>
        <div className="card" style={{ padding: 16 }}>
          {/* 2026-08-19 臨時鎖住：AI 回覆內容異常，平台端 ASSISTANT_KILL_SWITCH 已開、
              各店 ai_reply 已強制關閉，這裡先鎖死不讓店主自己點開，避免又被打開。
              問題排除後記得把這個 disabled 拿掉、告知已修復。 */}
          <label style={{
            display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'not-allowed',
            padding: 12, borderRadius: 10, background: 'var(--bg, #f7f7f5)', opacity: .55,
          }}>
            <input type="checkbox" checked={false} disabled style={{ marginTop: 2 }} />
            <span>
              <b style={{ fontSize: 14 }}>開啟 AI 客服自動回覆</b>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--text-3)', marginTop: 3, lineHeight: 1.6 }}>
                目前暫時停用維護中，排除問題後會再開放。這段期間所有客服訊息一律直接進「等真人」，
                由店員手動回覆。
              </span>
            </span>
          </label>
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

        <div className="sec">行銷追蹤</div>
        <div className="card" style={{ padding: 16 }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Meta Pixel ID（Facebook / Instagram 廣告追蹤）</label>
            <input className="form-input" type="text" inputMode="numeric" placeholder="例：1234567890123456"
              value={form.meta_pixel_id ?? ''}
              onChange={e => { setForm(prev => ({ ...prev, meta_pixel_id: e.target.value.replace(/\D/g, '') })); setSaved(false) }} />
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-3)', lineHeight: 1.7 }}>
              填入後商城會自動向 Meta 回報瀏覽商品、加入購物車、結帳與購買事件，
              下廣告時即可追蹤成效、優化受眾與再行銷；留空則不啟用、不載入任何追蹤程式。<br />
              Pixel ID 為一串純數字，可在{' '}
              <a href="https://business.facebook.com/events_manager" target="_blank" rel="noreferrer"
                style={{ color: 'var(--blue)' }}>Meta 事件管理工具</a>
              {' '}建立像素後取得。
            </div>
          </div>
        </div>

        {/* LINE 登入：平台開通（PlatformPage line_login_provisioned）後才顯示；店家再自行啟用 */}
        {store?.settings?.line_login_provisioned && (
          <>
            <div className="sec">LINE 登入（消費者用 LINE 帳號註冊/登入商城）</div>
            <div className="card" style={{ padding: 16 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, cursor: 'pointer', marginBottom: 12 }}>
                <input type="checkbox"
                  checked={!!form.line_login_enabled}
                  onChange={e => { setForm(prev => ({ ...prev, line_login_enabled: e.target.checked })); setSaved(false) }} />
                <b>啟用 LINE 登入</b>（開啟後商城登入頁會出現「用 LINE 繼續」按鈕）
              </label>
              {inputRow('LINE Login Channel ID', 'line_channel_id', 'text', '例：2010616155')}
              {inputRow('LIFF ID（LINE App 內登入頁）', 'line_liff_id', 'text', '例：2010616155-bJSaanw4')}
              {inputRow('Web 登入 Callback URL', 'line_callback_url', 'text', '例：https://你的商城網域/line-login/callback')}
              <div className="form-group" style={{ marginBottom: 10 }}>
                <label className="form-label">
                  LINE Channel Secret
                  <span style={{
                    fontSize: 11, marginLeft: 6, fontWeight: 600,
                    color: form.line_channel_secret_set ? 'var(--green)' : 'var(--text-3)',
                  }}>
                    {form.line_channel_secret_set ? '已設定' : '未設定'}
                  </span>
                </label>
                <input className="form-input" type="password" autoComplete="new-password"
                  placeholder={form.line_channel_secret_set ? '已設定（輸入新值可更新，留空維持不變）' : '貼上 LINE Login channel 的 Channel Secret'}
                  value={lineSecret}
                  onChange={e => { setLineSecret(e.target.value); setSaved(false) }} />
              </div>
              <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-3)', lineHeight: 1.7 }}>
                以上值都可在 <a href="https://developers.line.biz/console/" target="_blank" rel="noreferrer"
                  style={{ color: 'var(--blue)' }}>LINE Developers Console</a> 的 LINE Login channel 取得；
                Callback URL 需同步加入該 channel 的白名單，Email 取得權限需另外申請（審核制）。<br />
                Channel Secret 儲存後不會回顯（僅伺服器可讀取），要更換直接輸入新值再儲存即可。
              </div>
            </div>
          </>
        )}

        <div className="sec">出貨單寄件人（交貨便匯出用，可日後要匯出時再填）</div>
        <div className="card" style={{ padding: 16 }}>
          {inputRow('寄件人姓名', 'sender_name', 'text', '例：王小明', true)}
          {inputRow('寄件人電話', 'sender_phone', 'text', '例：0912345678', true)}
          {inputRow('寄件人 Email', 'sender_email', 'text', '例：service@yourshop.com')}
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

      {/* 綠界金物流：僅平台管理員可見與設定，理由見 store_ecpay_secrets migration —
          金鑰填錯代價是收款失敗或進錯帳戶，本輪不開放店主自助設定。獨立 RPC、獨立按鈕，
          刻意不掛進上面的主表單，避免店主存其他設定時意外一併送出這個區塊。
          特店編號會回顯（RPC 併回 settings.ecpay_merchant_id／ecpay_logistics_merchant_id，
          兩者本來就會出現在送往綠界的付款表單裡，不算機密）；HashKey/HashIV/寄件人資訊仍值只進不出。
          所有欄位留空送出＝維持原值，要整組刪除必須按下方「清除綠界設定」並二次確認。 */}
      {isPlatformAdmin && (
        <>
          <div className="sec" style={{ marginTop: 24 }}>
            綠界金物流設定（平台管理員）
            <span style={{
              fontSize: 11, marginLeft: 8, fontWeight: 600,
              color: form.ecpay_set ? 'var(--green)' : 'var(--text-3)',
            }}>
              {form.ecpay_set ? '已設定' : '未設定'}
            </span>
          </div>
          <div className="card" style={{ padding: 16 }}>
            {/* 對外開放開關：與金鑰分開。金鑰填好不等於想立刻開賣——先把物流單流程
                走過一遍確認沒問題，再按這個開關讓消費者看到。按下即生效，不必等下面的儲存。 */}
            <label style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, cursor: form.ecpay_set ? 'pointer' : 'not-allowed',
              padding: 12, marginBottom: 14, borderRadius: 10,
              background: ecpayEnabled ? 'var(--green-bg, #e8f7ee)' : 'var(--bg, #f7f7f5)',
              opacity: form.ecpay_set ? 1 : .55,
            }}>
              <input type="checkbox"
                checked={ecpayEnabled}
                disabled={!form.ecpay_set}
                onChange={e => toggleEcpayEnabled(e.target.checked)}
                style={{ marginTop: 2 }} />
              <span>
                <b style={{ fontSize: 14 }}>在商城開放綠界付款</b>
                <span style={{ display: 'block', fontSize: 12, color: 'var(--text-3)', marginTop: 3, lineHeight: 1.6 }}>
                  {form.ecpay_set
                    ? '關閉時結帳頁只出現銀行匯款，金鑰仍保留。要停售或排查問題時關掉它，不必清除金鑰。'
                    : '要先在下面填好金鑰並儲存，才能開放。'}
                </span>
              </span>
            </label>

            <div className="form-group" style={{ marginBottom: 10 }}>
              <label className="form-label">環境</label>
              <select className="form-input" value={ecpayForm.env} onChange={setEcpay('env')}>
                <option value="stage">測試（stage）</option>
                <option value="production">正式（production）</option>
              </select>
            </div>

            <div className="form-group" style={{ marginBottom: 10 }}>
              <label className="form-label">金流特店編號</label>
              <input className="form-input" type="text" placeholder="例：2000132（留空維持原值，不會清除）"
                value={ecpayForm.merchant_id} onChange={setEcpay('merchant_id')} />
            </div>
            <div className="form-group" style={{ marginBottom: 10 }}>
              <label className="form-label">金流 HashKey</label>
              <input className="form-input" type="password" autoComplete="new-password"
                placeholder={form.ecpay_set ? '已設定（輸入新值可更新，留空維持不變）' : '貼上綠界金流特店的 HashKey'}
                value={ecpayForm.hash_key} onChange={setEcpay('hash_key')} />
            </div>
            <div className="form-group" style={{ marginBottom: 14 }}>
              <label className="form-label">金流 HashIV</label>
              <input className="form-input" type="password" autoComplete="new-password"
                placeholder={form.ecpay_set ? '已設定（輸入新值可更新，留空維持不變）' : '貼上綠界金流特店的 HashIV'}
                value={ecpayForm.hash_iv} onChange={setEcpay('hash_iv')} />
            </div>

            <div className="form-group" style={{ marginBottom: 10 }}>
              <label className="form-label">物流特店編號</label>
              <input className="form-input" type="text" placeholder="例：2000933（金流物流分開申請，編號不同；留空維持原值）"
                value={ecpayForm.logistics_merchant_id} onChange={setEcpay('logistics_merchant_id')} />
            </div>
            <div className="form-group" style={{ marginBottom: 10 }}>
              <label className="form-label">物流 HashKey</label>
              <input className="form-input" type="password" autoComplete="new-password"
                placeholder={form.ecpay_set ? '已設定（輸入新值可更新，留空維持不變）' : '貼上綠界物流特店的 HashKey'}
                value={ecpayForm.logistics_hash_key} onChange={setEcpay('logistics_hash_key')} />
            </div>
            <div className="form-group" style={{ marginBottom: 14 }}>
              <label className="form-label">物流 HashIV</label>
              <input className="form-input" type="password" autoComplete="new-password"
                placeholder={form.ecpay_set ? '已設定（輸入新值可更新，留空維持不變）' : '貼上綠界物流特店的 HashIV'}
                value={ecpayForm.logistics_hash_iv} onChange={setEcpay('logistics_hash_iv')} />
            </div>

            <div className="form-group" style={{ marginBottom: 10 }}>
              <label className="form-label">
                寄件人姓名（綠界物流建單）
                <span style={{ color: 'var(--red)', fontSize: 11, marginLeft: 6, fontWeight: 600 }}>物流建單必填</span>
              </label>
              <input className="form-input" type="text" placeholder="例：王小明"
                value={ecpayForm.sender_name} onChange={setEcpay('sender_name')} />
            </div>
            <div className="form-group" style={{ marginBottom: 10 }}>
              <label className="form-label">
                寄件人手機（綠界物流建單）
                <span style={{ color: 'var(--red)', fontSize: 11, marginLeft: 6, fontWeight: 600 }}>物流建單必填</span>
              </label>
              <input className="form-input" type="text" placeholder="例：0912345678"
                value={ecpayForm.sender_phone} onChange={setEcpay('sender_phone')} />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">貨到付款上限（NT$）</label>
              <input className="form-input" type="number" placeholder="20000"
                value={ecpayForm.cod_max} onChange={setEcpay('cod_max')} />
            </div>

            {ecpayError && <div className="error-msg" style={{ marginTop: 12 }}>{ecpayError}</div>}

            <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 12, flexWrap: 'wrap' }}>
              <button type="button" className="btn" onClick={saveEcpay} disabled={ecpaySaving || ecpayClearing}
                style={{ width: 'auto', display: 'inline-block', padding: '8px 16px', fontSize: 13 }}>
                {ecpaySaving ? '儲存中…' : ecpaySaved ? '✓ 已儲存' : '儲存綠界設定'}
              </button>
              {form.ecpay_set && (
                <button type="button" onClick={clearEcpay} disabled={ecpaySaving || ecpayClearing}
                  style={{ background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer', fontSize: 12, padding: 0 }}>
                  {ecpayClearing ? '清除中…' : '清除綠界設定'}
                </button>
              )}
            </div>

            <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-3)', lineHeight: 1.7 }}>
              金流與物流是綠界分開申請的兩組金鑰，特店編號與 HashKey/HashIV 都不同，請分別填寫；
              正式環境上線前請先確認已在綠界後台完成撥款帳戶設定。<br />
              HashKey／HashIV／寄件人姓名／寄件人手機儲存後不會回顯（僅伺服器可讀取），要更換直接輸入新值再儲存即可，
              留空一律代表「維持原值」、不是清空。特店編號會回顯，方便確認目前掛的是測試還是正式帳號。<br />
              真的要整組移除（例如該店停用綠界）請按左邊的「清除綠界設定」，會二次確認 —— 清除後結帳頁立刻不再顯示綠界付款方式。
            </div>
          </div>
        </>
      )}
    </div>
  )
}
