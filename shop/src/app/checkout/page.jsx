'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../lib/supabase'
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

  const subtotal = cart.reduce((s, i) => s + i.price * i.qty, 0)
  const FREE_SHIPPING_THRESHOLD = 3980
  const SHIPPING_FEE = 60
  const shippingFee = subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE
  const total = subtotal + shippingFee
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

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

    // Validate that all cart items are still available (not expired/sold out)
    const productIds = [...new Set(cart.map(i => i.id))]
    const { data: spCheck } = await supabase
      .from('storefront_products')
      .select('product_id, collection_end, sold_out, published')
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

    const { data, error } = await supabase.from('consumer_orders').insert({
      customer_name: form.name,
      email: form.email,
      phone: form.phone,
      address: `${form.store_name} (${form.store_number})`,
      store_name: form.store_name.trim(),
      store_number: form.store_number.trim(),
      line_id: form.line_id || null,
      remittance_last5: form.remittance_last5.trim(),
      note: form.note,
      items: itemsStr,
      items_json: cart,
      total_amount: total,
      payment_status: '未付',
      status: '待確認',
    }).select().single()

    if (error) {
      alert(t('common.error'))
      setSubmitting(false)
      return
    }

    // 扣減現貨商品庫存（收單模式不扣）
    for (const item of cart) {
      if (item.isCollection) continue // 收單模式不扣庫存
      if (item.variantId) {
        // 有規格：扣 product_variants.stock
        await supabase.rpc('decrement_variant_stock', { vid: item.variantId, qty: item.qty })
      } else {
        // 無規格：扣 products.quantity
        await supabase.rpc('decrement_product_stock', { pid: item.id, qty: item.qty })
      }
    }

    // 寄訂單確認信（不阻斷成功流程，失敗靜默處理）
    fetch('/api/send-order-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        order: {
          id: data.id,
          email: form.email,
          name: form.name,
          phone: form.phone,
          store_name: form.store_name,
          store_number: form.store_number,
          remittance_last5: form.remittance_last5.trim(),
          note: form.note,
        },
        items: cart,
        total,
        lang,
      }),
    }).catch(err => console.error('Email send failed:', err))

    clearCart()
    router.push(`/order/${data.id}`)
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
