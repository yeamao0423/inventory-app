'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../lib/supabase'
import { useI18n } from '../layout'
import { useCart } from '../layout'

export default function CheckoutPage() {
  const { t, lang } = useI18n()
  const { cart, clearCart } = useCart()
  const router = useRouter()
  const [form, setForm] = useState({ name: '', phone: '', email: '', address: '', note: '' })
  const [errors, setErrors] = useState({})
  const [submitting, setSubmitting] = useState(false)

  const total = cart.reduce((s, i) => s + i.price * i.qty, 0)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  function validate() {
    const e = {}
    if (!form.name.trim()) e.name = t('checkout.required')
    if (!form.phone.trim()) e.phone = t('checkout.required')
    if (!form.email.trim()) e.email = t('checkout.required')
    if (!form.address.trim()) e.address = t('checkout.required')
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
      address: form.address,
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
          address: form.address,
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
            { key: 'name', label: t('checkout.name'), type: 'text' },
            { key: 'phone', label: t('checkout.phone'), type: 'tel' },
            { key: 'email', label: t('checkout.email'), type: 'email' },
            { key: 'address', label: t('checkout.address'), type: 'text' },
          ].map(({ key, label, type }) => (
            <div className="form-group" key={key}>
              <label className="form-label">{label} *</label>
              <input
                className="form-input"
                type={type}
                value={form[key]}
                onChange={e => set(key, e.target.value)}
                style={errors[key] ? { borderColor: 'var(--red)' } : {}}
              />
              {errors[key] && <div className="form-error">{errors[key]}</div>}
            </div>
          ))}

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
