'use client'
import Link from 'next/link'
import { useI18n } from '../layout'
import { useCart } from '../layout'

export default function CartPage() {
  const { t, lang } = useI18n()
  const { cart, removeItem } = useCart()

  const subtotal = cart.reduce((s, i) => s + i.price * i.qty, 0)
  const FREE_SHIPPING_THRESHOLD = 3800
  const SHIPPING_FEE = 60
  const shippingFee = subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE
  const total = subtotal + shippingFee

  if (cart.length === 0) return (
    <div className="cart-wrap">
      <div className="empty-state">
        <div className="empty-icon">🛒</div>
        <div className="empty-title">{t('cart.empty')}</div>
        <div className="empty-sub">{t('cart.empty_sub')}</div>
        <Link href="/products" className="btn-primary" style={{ display: 'inline-block', padding: '14px 32px', borderRadius: 12 }}>
          {t('cart.continue')}
        </Link>
      </div>
    </div>
  )

  return (
    <div className="cart-wrap">
      <h1 style={{ fontSize: 26, fontWeight: 700, marginBottom: 24 }}>
        {t('cart.title')} · {cart.reduce((s, i) => s + i.qty, 0)} {t('cart.items')}
      </h1>

      {cart.map(item => {
        const key = `${item.id}-${item.variantLabel || ''}`
        return (
          <div key={key} className="cart-item">
            <div className="cart-item-img">📦</div>
            <div className="cart-item-info">
              <div className="cart-item-name">{item.name}</div>
              <div className="cart-item-variant">
                {item.variantLabel}
                {item.customNote && <div style={{ marginTop: 2, fontSize: 12, color: 'var(--text-3)' }}>✏️ {item.customNote}</div>}
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 4 }}>× {item.qty}</div>
              <button className="cart-remove" onClick={() => removeItem(key)}>{t('cart.remove')}</button>
            </div>
            <div className="cart-item-price">NT${(item.price * item.qty).toLocaleString()}</div>
          </div>
        )
      })}

      <div className="cart-total">
        <div className="cart-total-row">
          <span>{t('cart.subtotal')}</span>
          <span>NT${subtotal.toLocaleString()}</span>
        </div>
        <div className="cart-total-row">
          <span>{lang === 'zh' ? '運費' : 'Shipping'}</span>
          <span>{shippingFee === 0
            ? (lang === 'zh' ? '免運費' : 'Free')
            : `NT$${shippingFee}`
          }</span>
        </div>
        {shippingFee > 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 8 }}>
            {lang === 'zh'
              ? `滿 NT$${FREE_SHIPPING_THRESHOLD.toLocaleString()} 免運費`
              : `Free shipping over NT$${FREE_SHIPPING_THRESHOLD.toLocaleString()}`
            }
          </div>
        )}
        <div className="cart-total-final">
          <span>{t('cart.total')}</span>
          <span>NT${total.toLocaleString()}</span>
        </div>
      </div>

      <div className="cart-actions">
        <Link href="/products" className="btn-outline" style={{ textAlign: 'center', display: 'block', padding: 14, borderRadius: 12, border: '0.5px solid var(--border)' }}>
          {t('cart.continue')}
        </Link>
        <Link href="/checkout" className="btn-primary">
          {t('cart.checkout')} →
        </Link>
      </div>
    </div>
  )
}
