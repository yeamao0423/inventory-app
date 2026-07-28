'use client'
import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../lib/supabase'
import { getStore, getStoreId } from '../../lib/store'
import { trackPixel } from '../../lib/metaPixel'
import { useI18n, useCart, useUser } from '../layout'

export default function CheckoutPage() {
  const { t, lang } = useI18n()
  const { cart, clearCart, appendTo, cancelAppend, hydrated } = useCart()
  const { user } = useUser()
  const router = useRouter()
  // 加購模式：購物車要併進既有訂單，不建新單也不重填收件資料
  const isAppend = !!appendTo?.token
  const [appendOrder, setAppendOrder] = useState(null)
  const [form, setForm] = useState({ name: '', phone: '', email: '', store_name: '', store_number: '', line_id: '', remittance_last5: '', note: '' })
  const [errors, setErrors] = useState({})
  const [submitting, setSubmitting] = useState(false)
  const [profileLoaded, setProfileLoaded] = useState(false)
  const [store, setStore] = useState(null)

  useEffect(() => {
    getStore().then(setStore).catch(() => {})
  }, [])

  useEffect(() => {
    if (!isAppend) return
    supabase.rpc('get_consumer_order', { p_token: appendTo.token })
      .then(({ data }) => setAppendOrder(data))
  }, [isAppend, appendTo?.token])

  useEffect(() => {
    if (hydrated && cart.length === 0 && !submitting) router.push('/cart')
  }, [hydrated, cart.length, submitting])

  // Meta Pixel：進入結帳事件（購物車就緒後發一次）
  const checkoutTracked = useRef(false)
  useEffect(() => {
    if (checkoutTracked.current || cart.length === 0) return
    checkoutTracked.current = true
    trackPixel('InitiateCheckout', {
      content_ids: cart.map(i => String(i.id)),
      num_items: cart.reduce((s, i) => s + i.qty, 0),
      value: cart.reduce((s, i) => s + i.price * i.qty, 0),
      currency: 'TWD',
    })
  }, [cart])

  // 登入用戶自動帶入個人資料
  useEffect(() => {
    if (!user || profileLoaded) return
    async function loadProfile() {
      const { data } = await supabase.from('consumers').select('name, phone, line_id').eq('id', user.id).single()
      if (data) {
        setForm(f => ({
          ...f,
          name: f.name || data.name || '',
          phone: f.phone || data.phone || '',
          email: f.email || user.email || '',
          line_id: f.line_id || data.line_id || '',
        }))
      } else {
        setForm(f => ({ ...f, email: f.email || user.email || '' }))
      }
      setProfileLoaded(true)
    }
    loadProfile()
  }, [user])

  // 優惠券
  const [couponCode, setCouponCode] = useState('')
  const [couponPreview, setCouponPreview] = useState(null) // { coupon_id, name, discount_amount } | null
  const [couponError, setCouponError] = useState('')
  const [couponLoading, setCouponLoading] = useState(false)

  const subtotal = cart.reduce((s, i) => s + i.price * i.qty, 0)
  const FREE_SHIPPING_THRESHOLD = store?.settings?.free_shipping_threshold ?? 3800
  const SHIPPING_FEE = store?.settings?.shipping_fee ?? 60
  const shippingFee = subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE
  const discountAmount = couponPreview?.discount_amount || 0
  const total = subtotal - discountAmount + shippingFee
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  // ── 加購金額試算：與 DB 的 append_to_order 用同一組規則 ──
  // 合併後小計重新對免運門檻，所以「加購跨過門檻」會把原本收的運費退掉。
  const originalItems = Array.isArray(appendOrder?.items_json) ? appendOrder.items_json : []
  const originalSubtotal = originalItems
    .filter(i => (i.status ?? 'active') !== 'cancelled')
    .reduce((s, i) => s + Number(i.price || 0) * Number(i.qty || 0), 0)
  const mergedSubtotal = originalSubtotal + subtotal
  const appendShippingFee = mergedSubtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE
  const appendNewTotal = mergedSubtotal - Number(appendOrder?.discount_amount || 0) + appendShippingFee
  const appendPaid = Number(appendOrder?.paid_amount || 0)
  const appendBalanceDue = appendNewTotal - appendPaid
  const prevShippingFee = Number(appendOrder?.shipping_fee || 0)

  async function submitAppend() {
    if (cart.length === 0) return
    setSubmitting(true)

    const { data, error } = await supabase.rpc('append_to_order', {
      p_token: appendTo.token,
      p_items_json: cart,
    })

    if (error || !data?.ok) {
      alert(data?.error || error?.message || t('common.error'))
      setSubmitting(false)
      return
    }

    trackPixel('Purchase', {
      content_ids: cart.map(i => String(i.id)),
      num_items: cart.reduce((s, i) => s + i.qty, 0),
      value: Number(data.new_total) - Number(data.previous_total),
      currency: 'TWD',
    }, { eventID: `${appendTo.token}-append-${Date.now()}` })

    // 加購通知信（不阻斷流程，失敗靜默處理）
    fetch('/api/send-order-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: appendTo.token, lang, mode: 'append' }),
    }).catch(err => console.error('Email send failed:', err))

    clearCart()
    cancelAppend()
    router.push(`/order/${appendTo.token}`)
  }

  // 優惠碼預覽（read-only 查詢，不扣額度）
  async function applyCoupon() {
    const code = couponCode.trim().toUpperCase()
    if (!code) return
    setCouponLoading(true)
    setCouponError('')
    setCouponPreview(null)

    try {
      const storeId = await getStoreId()
      // 點查 RPC（coupons/coupon_codes 已不開放匿名直讀）
      const { data: result } = await supabase
        .rpc('lookup_coupon', { p_code: code, p_store_id: storeId })

      if (!result?.found) { setCouponError(lang === 'zh' ? '優惠碼不存在' : 'Invalid coupon code'); setCouponLoading(false); return }
      if (result.is_used) { setCouponError(lang === 'zh' ? '此優惠碼已被使用' : 'This coupon has been used'); setCouponLoading(false); return }

      const coupon = result.coupon
      const couponId = coupon.id
      const isUnique = result.is_unique

      // 基本驗證
      if (!coupon.is_active) { setCouponError(lang === 'zh' ? '此優惠活動已停用' : 'This promotion is inactive'); setCouponLoading(false); return }
      const now = new Date()
      if (now < new Date(coupon.starts_at)) { setCouponError(lang === 'zh' ? '此優惠尚未開始' : 'This promotion has not started'); setCouponLoading(false); return }
      if (coupon.expires_at && now > new Date(coupon.expires_at)) { setCouponError(lang === 'zh' ? '此優惠碼已過期' : 'This coupon has expired'); setCouponLoading(false); return }
      if (!isUnique && coupon.max_usage && coupon.usage_count >= coupon.max_usage) { setCouponError(lang === 'zh' ? '此優惠碼已達使用上限' : 'This coupon has reached its usage limit'); setCouponLoading(false); return }
      if (subtotal < Number(coupon.min_amount)) { setCouponError(lang === 'zh' ? `未達最低消費 NT$${Number(coupon.min_amount).toLocaleString()}` : `Minimum spend NT$${Number(coupon.min_amount).toLocaleString()} required`); setCouponLoading(false); return }
      // 會員等級資格（限定等級的券需登入會員）
      if (result.level_ok === false) {
        const restricted = (coupon.allowed_level_ids || []).length > 0
        setCouponError(lang === 'zh'
          ? (restricted ? '此優惠僅限特定會員等級使用，請先登入符合資格的會員帳號' : '您不符合此優惠的使用資格')
          : 'This coupon is limited to specific member levels. Please sign in with an eligible account')
        setCouponLoading(false); return
      }

      // 計算折扣
      let discount = 0
      if (coupon.discount_type === 'fixed') {
        discount = Math.min(Number(coupon.discount_value), subtotal)
      } else {
        discount = subtotal * (Number(coupon.discount_value) / 100)
        if (coupon.max_discount) discount = Math.min(discount, Number(coupon.max_discount))
        discount = Math.min(discount, subtotal)
      }
      discount = Math.round(discount)

      setCouponPreview({ coupon_id: couponId, name: coupon.name, discount_amount: discount, code })
    } catch {
      setCouponError(lang === 'zh' ? '驗證失敗，請稍後再試' : 'Validation failed, please try again')
    }
    setCouponLoading(false)
  }

  function removeCoupon() {
    setCouponPreview(null)
    setCouponCode('')
    setCouponError('')
  }

  function validate() {
    const e = {}
    if (!form.name.trim()) e.name = t('checkout.required')
    if (!form.phone.trim()) e.phone = t('checkout.required')
    if (!form.email.trim()) e.email = t('checkout.required')
    if (!form.line_id.trim()) e.line_id = t('checkout.required')
    if (!form.store_name.trim()) e.store_name = t('checkout.required')
    if (!form.store_number.trim()) e.store_number = t('checkout.required')
    if (!form.remittance_last5.trim() || !/^\d{5}$/.test(form.remittance_last5.trim())) {
      e.remittance_last5 = lang === 'zh' ? '請輸入 5 位數字' : 'Please enter exactly 5 digits'
    }
    setErrors(e)
    return Object.keys(e).length === 0
  }

  async function submit() {
    if (!validate() || cart.length === 0) return
    setSubmitting(true)

    const storeId = await getStoreId()

    // Validate that all cart items are still available (not expired/sold out)
    const productIds = [...new Set(cart.map(i => i.id))]
    const { data: spCheck } = await supabase
      .from('storefront_products')
      .select('product_id, collection_end, sold_out, published')
      .eq('store_id', storeId)
      .in('product_id', productIds)

    const unavailable = (spCheck || []).filter(sp =>
      sp.sold_out || !sp.published || (sp.collection_end && new Date(sp.collection_end) < new Date())
    )
    if (unavailable.length > 0) {
      const unavailableIds = new Set(unavailable.map(u => u.product_id))
      const names = cart.filter(i => unavailableIds.has(i.id)).map(i => i.name)
      alert((lang === 'zh'
        ? `以下商品已無法購買，請返回購物車移除：\n${names.join('、')}`
        : `The following items are no longer available. Please remove them from your cart:\n${names.join(', ')}`
      ))
      setSubmitting(false)
      return
    }

    const itemsStr = cart.map(i =>
      `${i.name}${i.variantLabel ? ' ' + i.variantLabel : ''} × ${i.qty}${i.customNote ? ' [' + i.customNote + ']' : ''}`
    ).join(', ')

    // 原子操作：檢查庫存 + 驗證優惠券 → 扣庫存 + 建立訂單 + 記錄優惠券（單一 transaction）
    const orderTotal = subtotal + shippingFee  // 未折扣金額，RPC 內部會扣除折扣

    const { data: placeResult, error: placeError } = await supabase.rpc('place_order', {
      p_store_id: storeId,
      p_customer_name: form.name,
      p_email: form.email,
      p_phone: form.phone,
      p_address: `${form.store_name} (${form.store_number})`,
      p_store_name: form.store_name.trim(),
      p_store_number: form.store_number.trim(),
      p_line_id: form.line_id || null,
      p_remittance_last5: form.remittance_last5.trim(),
      p_note: form.note,
      p_items: itemsStr,
      p_items_json: cart,
      p_total_amount: orderTotal,
      p_shipping_fee: shippingFee,
      // coupon (nullable)
      p_coupon_code: couponPreview?.code || null,
      p_subtotal: couponPreview ? subtotal : null,
      p_consumer_email: form.email,
    })

    if (placeError || !placeResult?.ok) {
      const errMsg = placeResult?.error || placeError?.message || t('common.error')
      alert(errMsg)
      setSubmitting(false)
      return
    }

    const orderToken = placeResult.public_token  // 不可猜連結：完成頁以此查詢，取代可枚舉的流水號

    // Meta Pixel：購買完成事件。eventID 帶訂單 token，之後接 Conversions API 可據此去重
    trackPixel('Purchase', {
      content_ids: cart.map(i => String(i.id)),
      num_items: cart.reduce((s, i) => s + i.qty, 0),
      value: total,
      currency: 'TWD',
    }, { eventID: orderToken })

    // 寄訂單確認信（不阻斷成功流程，失敗靜默處理）。
    // 只送不可猜的 token，收件人與內容由 server 依 token 從 DB 重建（見 send-order-email）。
    fetch('/api/send-order-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: orderToken, lang }),
    }).catch(err => console.error('Email send failed:', err))

    clearCart()
    router.push(`/order/${orderToken}`)
  }

  // 導向必須等 localStorage 讀入後才判斷，否則重新整理結帳頁會因為
  // cart 還是初始空陣列而被踢回購物車；導向本身也要在 render 之外做。
  if (!hydrated) return null
  if (cart.length === 0 && !submitting) return null

  // ── 加購模式：不重填收件資料，只確認金額差額 ──
  if (isAppend) {
    const zh = lang === 'zh'
    const row = (label, value, style = {}) => (
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginBottom: 8, ...style }}>
        <span>{label}</span><span>{value}</span>
      </div>
    )

    return (
      <div style={{ padding: '40px 0', maxWidth: 560, margin: '0 auto' }}>
        <h1 className="form-title">
          {zh ? `加購到訂單 #${appendTo.orderNo}` : `Add to order #${appendTo.orderNo}`}
        </h1>

        {!appendOrder ? (
          <div style={{ color: 'var(--text-3)', padding: '30px 0' }}>{zh ? '載入中…' : 'Loading…'}</div>
        ) : !appendOrder.can_append ? (
          <div className="order-summary-card">
            <div style={{ fontSize: 14, lineHeight: 1.8 }}>
              {zh
                ? '這筆訂單已經無法加購了 —— 可能是加購時間已截止，或老闆已經開始採購。'
                : 'This order can no longer be modified — the window has closed or purchasing has started.'}
            </div>
            <button className="btn-primary" style={{ marginTop: 16 }}
              onClick={() => { cancelAppend(); router.push('/cart') }}>
              {zh ? '改為建立新訂單' : 'Create a new order instead'}
            </button>
          </div>
        ) : (
          <>
            <div className="order-summary-card">
              <div className="order-summary-title">{zh ? '加購商品' : 'Items to add'}</div>
              {cart.map(item => (
                <div className="order-summary-item" key={`${item.id}-${item.variantLabel || ''}`}>
                  <div className="order-summary-item-name">
                    {item.name}
                    {item.variantLabel && (
                      <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{item.variantLabel}</div>
                    )}
                    <div style={{ fontSize: 12, color: 'var(--text-3)' }}>× {item.qty}</div>
                  </div>
                  <div className="order-summary-item-price">NT${(item.price * item.qty).toLocaleString()}</div>
                </div>
              ))}
            </div>

            <div className="order-summary-card" style={{ marginTop: 16 }}>
              <div className="order-summary-title">{zh ? '金額變化' : 'Amount changes'}</div>
              {row(zh ? '原訂單金額' : 'Current order', `NT$${Number(appendOrder.total_amount || 0).toLocaleString()}`,
                { color: 'var(--text-2)' })}
              {row(zh ? '加購商品' : 'Items added', `+NT$${subtotal.toLocaleString()}`, { color: 'var(--text-2)' })}

              <hr className="order-summary-divider" />

              {prevShippingFee !== appendShippingFee ? (
                row(
                  zh ? '運費' : 'Shipping',
                  <span>
                    <span style={{ textDecoration: 'line-through', color: 'var(--text-3)' }}>NT${prevShippingFee}</span>
                    {' → '}
                    <span style={{ color: '#1a7a3c', fontWeight: 600 }}>
                      {appendShippingFee === 0 ? (zh ? '免運' : 'Free') : `NT$${appendShippingFee}`}
                    </span>
                  </span>,
                  { color: 'var(--text-2)' },
                )
              ) : (
                row(zh ? '運費' : 'Shipping',
                  appendShippingFee === 0 ? (zh ? '免運費' : 'Free') : `NT$${appendShippingFee}`,
                  { color: 'var(--text-2)' })
              )}

              {Number(appendOrder.discount_amount) > 0 && row(
                zh ? '優惠券折抵' : 'Coupon',
                `-NT$${Number(appendOrder.discount_amount).toLocaleString()}`,
                { color: '#1a7a3c' },
              )}

              <div className="order-summary-total">
                <span>{zh ? '加購後應付' : 'New total'}</span>
                <span>NT${appendNewTotal.toLocaleString()}</span>
              </div>

              {appendPaid > 0 && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '0.5px solid var(--border)' }}>
                  {row(zh ? '已收' : 'Already paid', `NT$${appendPaid.toLocaleString()}`, { color: 'var(--text-2)' })}
                  {row(
                    appendBalanceDue >= 0 ? (zh ? '需補匯' : 'Balance due') : (zh ? '待退款' : 'Refund due'),
                    `NT$${Math.abs(appendBalanceDue).toLocaleString()}`,
                    { fontWeight: 700, fontSize: 16, marginBottom: 0 },
                  )}
                </div>
              )}

              {prevShippingFee > 0 && appendShippingFee === 0 && (
                <div style={{ marginTop: 10, fontSize: 12, color: '#1a7a3c', lineHeight: 1.6 }}>
                  {zh
                    ? `加購後已達免運門檻，原本的 NT$${prevShippingFee} 運費已為你退掉。`
                    : `You've reached free shipping — the NT$${prevShippingFee} shipping fee has been removed.`}
                </div>
              )}

              <div style={{ marginTop: 14, fontSize: 12, color: 'var(--text-3)', lineHeight: 1.7 }}>
                {zh
                  ? '收件資訊與付款方式沿用原訂單，不需要重新填寫。加購商品會與原訂單一起出貨。'
                  : 'Shipping details carry over from the original order. Added items ship together.'}
              </div>
            </div>

            <button className="btn-primary" onClick={submitAppend} disabled={submitting} style={{ marginTop: 16 }}>
              {submitting ? t('checkout.submitting') : (zh ? '確認加購' : 'Confirm')}
            </button>
            <button
              onClick={() => { cancelAppend(); router.push('/cart') }}
              style={{
                width: '100%', marginTop: 10, padding: '12px 0', background: 'none',
                border: 'none', color: 'var(--text-3)', fontSize: 13, cursor: 'pointer',
              }}>
              {zh ? '取消加購，改為建立新訂單' : 'Cancel and create a new order'}
            </button>
          </>
        )}
      </div>
    )
  }

  return (
    <div style={{ padding: '40px 0' }}>
      <div className="checkout-wrap">
        {/* Form */}
        <div>
          <h1 className="form-title">{t('checkout.title')}</h1>

          {[
            { key: 'name', label: t('checkout.name'), type: 'text', required: true },
            { key: 'phone', label: t('checkout.phone'), type: 'tel', required: true },
            { key: 'email', label: t('checkout.email'), type: 'email', required: true },
            { key: 'line_id', label: t('checkout.line_id'), type: 'text', required: true, placeholder: t('checkout.line_id_placeholder') },
            { key: 'remittance_last5', label: t('checkout.remittance_last5'), type: 'text', required: true, placeholder: t('checkout.remittance_last5_placeholder'), maxLength: 5, inputMode: 'numeric' },
          ].map(({ key, label, type, required, placeholder, maxLength, inputMode }) => (
            <div className="form-group" key={key}>
              <label className="form-label">{label}{required ? ' *' : ''}</label>
              <input
                className="form-input"
                type={type}
                value={form[key]}
                onChange={e => set(key, e.target.value)}
                placeholder={placeholder || ''}
                maxLength={maxLength}
                inputMode={inputMode}
                style={errors[key] ? { borderColor: 'var(--red)' } : {}}
              />
              {errors[key] && <div className="form-error">{errors[key]}</div>}
            </div>
          ))}

          {/* 7-11 取貨門市 */}
          <div style={{ marginBottom: 16 }}>
            <label className="form-label">{t('checkout.store_section')} *</label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <input
                  className="form-input"
                  type="text"
                  value={form.store_name}
                  onChange={e => set('store_name', e.target.value)}
                  placeholder={t('checkout.store_name_placeholder')}
                  style={errors.store_name ? { borderColor: 'var(--red)' } : {}}
                />
                {errors.store_name && <div className="form-error">{errors.store_name}</div>}
              </div>
              <div>
                <input
                  className="form-input"
                  type="text"
                  value={form.store_number}
                  onChange={e => set('store_number', e.target.value)}
                  placeholder={t('checkout.store_number_placeholder')}
                  style={errors.store_number ? { borderColor: 'var(--red)' } : {}}
                />
                {errors.store_number && <div className="form-error">{errors.store_number}</div>}
              </div>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">{t('checkout.note')}</label>
            <textarea
              className="form-input"
              style={{ minHeight: 80, resize: 'vertical' }}
              placeholder={t('checkout.note_placeholder')}
              value={form.note}
              onChange={e => set('note', e.target.value)}
            />
          </div>

          <button className="btn-primary" onClick={submit} disabled={submitting} style={{ marginTop: 8 }}>
            {submitting ? t('checkout.submitting') : t('checkout.submit')}
          </button>
        </div>

        {/* Order Summary */}
        <div>
          <div className="order-summary-card">
            <div className="order-summary-title">{t('checkout.order_summary')}</div>
            {cart.map(item => (
              <div className="order-summary-item" key={`${item.id}-${item.color}-${item.size}`}>
                <div className="order-summary-item-name">
                  {item.name}
                  {item.variantLabel && (
                    <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{item.variantLabel}</div>
                  )}
                  <div style={{ fontSize: 12, color: 'var(--text-3)' }}>× {item.qty}</div>
                </div>
                <div className="order-summary-item-price">NT${(item.price * item.qty).toLocaleString()}</div>
              </div>
            ))}
            <hr className="order-summary-divider" />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, color: 'var(--text-2)', marginBottom: 8 }}>
              <span>{lang === 'zh' ? '小計' : 'Subtotal'}</span>
              <span>NT${subtotal.toLocaleString()}</span>
            </div>

            {/* 優惠碼輸入 */}
            {!couponPreview ? (
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    className="form-input"
                    style={{ flex: 1, fontSize: 14, textTransform: 'uppercase', fontFamily: 'monospace' }}
                    placeholder={lang === 'zh' ? '輸入優惠碼' : 'Coupon code'}
                    value={couponCode}
                    onChange={e => { setCouponCode(e.target.value); setCouponError('') }}
                    onKeyDown={e => e.key === 'Enter' && applyCoupon()}
                  />
                  <button
                    onClick={applyCoupon}
                    disabled={couponLoading || !couponCode.trim()}
                    style={{
                      padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border)',
                      background: 'var(--surface)', fontSize: 14, cursor: 'pointer',
                      opacity: couponLoading || !couponCode.trim() ? 0.5 : 1,
                    }}
                  >{couponLoading ? '...' : (lang === 'zh' ? '套用' : 'Apply')}</button>
                </div>
                {couponError && (
                  <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 4 }}>{couponError}</div>
                )}
              </div>
            ) : (
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                fontSize: 14, color: '#1a7a3c', marginBottom: 8,
                background: '#e8f7ee', padding: '8px 12px', borderRadius: 8,
              }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{couponPreview.name}</div>
                  <div style={{ fontSize: 12 }}>-NT${couponPreview.discount_amount.toLocaleString()}</div>
                </div>
                <button
                  onClick={removeCoupon}
                  style={{ background: 'none', border: 'none', fontSize: 16, cursor: 'pointer', color: '#999' }}
                >×</button>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, color: 'var(--text-2)', marginBottom: 8 }}>
              <span>{lang === 'zh' ? '運費' : 'Shipping'}</span>
              <span>{shippingFee === 0
                ? (lang === 'zh' ? '免運費' : 'Free')
                : `NT$${shippingFee}`
              }</span>
            </div>
            {shippingFee > 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 8 }}>
                {lang === 'zh'
                  ? `滿 NT$${FREE_SHIPPING_THRESHOLD.toLocaleString()} 免運費，還差 NT$${(FREE_SHIPPING_THRESHOLD - subtotal).toLocaleString()}`
                  : `Free shipping over NT$${FREE_SHIPPING_THRESHOLD.toLocaleString()}, NT$${(FREE_SHIPPING_THRESHOLD - subtotal).toLocaleString()} away`
                }
              </div>
            )}
            <div className="order-summary-total">
              <span>{t('cart.total')}</span>
              <span>NT${total.toLocaleString()}</span>
            </div>
            <div style={{ marginTop: 16, fontSize: 12, color: 'var(--text-3)', lineHeight: 1.6 }}>
              {lang === 'zh'
                ? '下單後我們將聯繫您確認付款方式'
                : 'We will contact you after order to confirm payment'
              }
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
