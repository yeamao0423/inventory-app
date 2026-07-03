'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../lib/supabase'
import { getStore, getStoreId } from '../../lib/store'
import { useI18n, useCart, useUser } from '../layout'

export default function CheckoutPage() {
  const { t, lang } = useI18n()
  const { cart, clearCart } = useCart()
  const { user } = useUser()
  const router = useRouter()
  const [form, setForm] = useState({ name: '', phone: '', email: '', store_name: '', store_number: '', line_id: '', remittance_last5: '', note: '' })
  const [errors, setErrors] = useState({})
  const [submitting, setSubmitting] = useState(false)
  const [profileLoaded, setProfileLoaded] = useState(false)
  const [store, setStore] = useState(null)

  useEffect(() => {
    getStore().then(setStore).catch(() => {})
  }, [])

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

  if (cart.length === 0 && !submitting) {
    if (typeof window !== 'undefined') router.push('/cart')
    return null
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
