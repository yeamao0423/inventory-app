'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useI18n } from '../layout'
import { useCart } from '../layout'
import { fetchBundlesByIds } from '../../lib/bundles'
import { bundleIdsInCart, cartLineKey, computeCartTotals, evaluateBundle } from '../../lib/bundleCart'

export default function CartPage() {
  const { t, lang } = useI18n()
  const { cart, removeItem } = useCart()
  const zh = lang === 'zh'

  // 購物車裡出現過的組合定義（anon 讀，只拿得到已發佈的）。
  // 查不到＝組合已下架，各件退回原價 —— 這正是我們要顯示的狀態。
  const [bundles, setBundles] = useState([])
  const bundleIds = bundleIdsInCart(cart)
  const bundleKey = bundleIds.join(',')
  useEffect(() => {
    if (bundleIds.length === 0) { setBundles([]); return }
    let alive = true
    fetchBundlesByIds(bundleIds).then(rows => { if (alive) setBundles(rows) }).catch(() => {})
    return () => { alive = false }
  }, [bundleKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const { subtotal, bundleDiscount, itemsTotal } = computeCartTotals(cart, bundles)
  const FREE_SHIPPING_THRESHOLD = 3800
  const SHIPPING_FEE = 60
  // 免運門檻看的是商品原價加總，與結帳／加購同一套規則（折扣不影響門檻）
  const shippingFee = subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE
  const total = itemsTotal + shippingFee

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

  // 依所屬組合分群；沒掛組合的維持原本的平鋪清單
  const groups = bundleIds.map(id => {
    const def = bundles.find(b => b.id === id)
    const lines = cart.filter(i => i.bundleId === id)
    return {
      id,
      name: def?.name || lines[0]?.bundleName || '',
      lines,
      def,
      state: def ? evaluateBundle(cart, def) : null,
    }
  })
  const loose = cart.filter(i => i.bundleId == null || i.bundleId === '')

  const itemRow = item => {
    const key = cartLineKey(item)
    return (
      <div key={key} className="cart-item">
        {item.image
          ? <img src={item.image} alt={item.name} className="cart-item-img" style={{ objectFit: 'cover' }} />
          : <div className="cart-item-img">📦</div>
        }
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
  }

  return (
    <div className="cart-wrap">
      <h1 style={{ fontSize: 26, fontWeight: 700, marginBottom: 24 }}>
        {t('cart.title')} · {cart.reduce((s, i) => s + i.qty, 0)} {t('cart.items')}
      </h1>

      {/* 組合商品：整套放在同一個框裡，套裝價成不成立一眼看得出來 */}
      {groups.map(g => (
        <div key={g.id} style={{ border: '0.5px solid var(--border)', borderRadius: 12, padding: 12, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>
              <span style={{ color: 'var(--text-3)', fontWeight: 400, marginRight: 6 }}>{zh ? '組合商品' : 'Bundle'}</span>
              {g.name}
            </div>
            <Link href={`/bundles/${g.id}`} style={{ fontSize: 12, color: 'var(--blue)', flexShrink: 0 }}>
              {zh ? '查看組合' : 'View bundle'}
            </Link>
          </div>

          {g.lines.map(itemRow)}

          {g.state?.applies ? (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#1a7a3c', marginTop: 8, fontWeight: 600 }}>
              <span>{zh ? `套裝價 NT$${g.state.bundlePrice.toLocaleString()}（原價 NT$${g.state.originalTotal.toLocaleString()}）` : `Bundle price NT$${g.state.bundlePrice.toLocaleString()}`}</span>
              <span>-NT${g.state.discount.toLocaleString()}</span>
            </div>
          ) : (
            <div style={{ background: 'var(--amber-bg)', borderRadius: 10, padding: '10px 12px', marginTop: 8 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--amber)', marginBottom: 3 }}>
                {zh ? '目前不適用套裝價' : 'Bundle price not applied'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--amber)', lineHeight: 1.7 }}>
                {!g.def
                  ? (zh ? '這個組合已下架，以下商品改以各件原價計算。'
                        : 'This bundle is no longer available; the items below are charged at regular price.')
                  : (zh ? `套裝價只在整套齊全時成立。這個組合還缺 ${g.state.missingProductIds.length} 件，目前以各件原價計算 —— 回組合頁補齊就會恢復。`
                        : `The bundle price applies only to the complete set. ${g.state.missingProductIds.length} item(s) missing — items are charged at regular price until you add them back.`)}
              </div>
              {g.def && g.state.missingProductIds.length > 0 && (
                <Link href={`/bundles/${g.id}`} style={{ display: 'inline-block', marginTop: 6, fontSize: 12, color: 'var(--blue)' }}>
                  {zh ? '回組合頁補齊 →' : 'Back to the bundle →'}
                </Link>
              )}
            </div>
          )}
        </div>
      ))}

      {loose.map(itemRow)}

      <div className="cart-total">
        <div className="cart-total-row">
          <span>{t('cart.subtotal')}</span>
          <span>NT${subtotal.toLocaleString()}</span>
        </div>
        {bundleDiscount > 0 && (
          <div className="cart-total-row" style={{ color: '#1a7a3c' }}>
            <span>{zh ? '套裝價折抵' : 'Bundle discount'}</span>
            <span>-NT${bundleDiscount.toLocaleString()}</span>
          </div>
        )}
        <div className="cart-total-row">
          <span>{zh ? '運費' : 'Shipping'}</span>
          <span>{shippingFee === 0
            ? (zh ? '免運費' : 'Free')
            : `NT$${shippingFee}`
          }</span>
        </div>
        {shippingFee > 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 8 }}>
            {zh
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
