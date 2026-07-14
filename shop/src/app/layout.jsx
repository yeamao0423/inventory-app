'use client'
import './globals.css'
import { createContext, useContext, useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { supabase } from '../lib/supabase'
import { getStore, getStorePages } from '../lib/store'
import { initMetaPixel, trackPageView, trackPixel } from '../lib/metaPixel'
import zhMessages from '../messages/zh.json'
import enMessages from '../messages/en.json'

function BagIcon({ size = 28 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6, verticalAlign: 'middle' }}><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>
}

const messages = { zh: zhMessages, en: enMessages }

// ── i18n ──────────────────────────────────
const I18nContext = createContext({ t: (k) => k, lang: 'zh', setLang: () => {} })
export function useI18n() { return useContext(I18nContext) }

// ── Cart Context ───────────────────────────
export const CartContext = createContext({ cart: [], addItem: () => {}, removeItem: () => {}, clearCart: () => {} })
export function useCart() { return useContext(CartContext) }

// ── User Context ───────────────────────────
const UserContext = createContext({ user: null, loading: true })
export function useUser() { return useContext(UserContext) }

// ── Root Layout ────────────────────────────
export default function RootLayout({ children }) {
  const [lang, setLang] = useState('zh')
  const [msgs, setMsgs] = useState(messages.zh)
  const [cart, setCart] = useState([])
  const [toast, setToast] = useState('')
  const [user, setUser] = useState(null)
  const [userLoading, setUserLoading] = useState(true)
  const [store, setStore] = useState(null)
  const [footerPages, setFooterPages] = useState([])

  // 抓當前店資訊（名稱、logo），驅動導覽列/標題/favicon/footer
  useEffect(() => {
    getStore().then(setStore).catch(() => {})
    getStorePages().then(setFooterPages).catch(() => {})
  }, [])

  // Meta Pixel：店家有在後台設定 Pixel ID 才載入（含首次 PageView）
  useEffect(() => {
    const pid = store?.settings?.meta_pixel_id
    if (pid) initMetaPixel(pid)
  }, [store])

  // SPA 換頁不會重新載入頁面，路由變化時補發 PageView（首次由 init 發）
  const pathname = usePathname()
  const isFirstPath = useRef(true)
  useEffect(() => {
    if (isFirstPath.current) { isFirstPath.current = false; return }
    trackPageView()
  }, [pathname])

  // 動態更新 favicon（分頁標題改由各頁 metadata 接管，避免覆蓋商品標題）
  useEffect(() => {
    if (!store) return
    const logo = store.settings?.logo_url
    if (logo) {
      let link = document.querySelector("link[rel='icon']")
      if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link) }
      link.href = logo
    }
  }, [store])

  useEffect(() => {
    const saved = localStorage.getItem('lang') || (navigator.language.startsWith('en') ? 'en' : 'zh')
    setLang(saved)
    setMsgs(messages[saved] || messages.zh)
    const savedCart = localStorage.getItem('cart')
    if (savedCart) setCart(JSON.parse(savedCart))
  }, [])

  useEffect(() => {
    setMsgs(messages[lang] || messages.zh)
    localStorage.setItem('lang', lang)
  }, [lang])

  useEffect(() => {
    localStorage.setItem('cart', JSON.stringify(cart))
  }, [cart])

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      setUserLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      setUser(session?.user ?? null)
    })
    return () => subscription.unsubscribe()
  }, [])

  function t(key) {
    const keys = key.split('.')
    let val = msgs
    for (const k of keys) val = val?.[k]
    return val || key
  }

  function addItem(item) {
    setCart(prev => {
      const key = `${item.id}-${item.variantLabel || ''}`
      const existing = prev.find(i => `${i.id}-${i.variantLabel || ''}` === key)
      if (existing) return prev.map(i => `${i.id}-${i.variantLabel || ''}` === key ? { ...i, qty: i.qty + item.qty } : i)
      return [...prev, item]
    })
    trackPixel('AddToCart', {
      content_ids: [String(item.id)],
      content_name: item.name,
      content_type: 'product',
      value: item.price * item.qty,
      currency: 'TWD',
    })
    showToast(lang === 'zh' ? '已加入購物車 ✓' : 'Added to cart ✓')
  }

  function removeItem(key) {
    setCart(prev => prev.filter(i => `${i.id}-${i.variantLabel || ''}` !== key))
  }

  function clearCart() { setCart([]) }

  function showToast(msg) {
    setToast(msg)
    setTimeout(() => setToast(''), 2500)
  }

  const totalQty = cart.reduce((s, i) => s + i.qty, 0)

  return (
    <html lang={lang === 'zh' ? 'zh-TW' : 'en'}>
      <body>
        <UserContext.Provider value={{ user, loading: userLoading }}>
          <I18nContext.Provider value={{ t, lang, setLang }}>
            <CartContext.Provider value={{ cart, addItem, removeItem, clearCart }}>
              <nav className="nav">
                <div className="nav-inner">
                  <Link href="/" className="nav-logo">
                    {(store?.settings?.brand_display ?? 'both') !== 'name' && (
                      store?.settings?.logo_url
                        ? <img src={store.settings.logo_url} alt="" style={{ height: 28, marginRight: 6, verticalAlign: 'middle' }} />
                        : <BagIcon size={28} />
                    )}
                    {(store?.settings?.brand_display ?? 'both') !== 'logo' && (store?.name || '')}
                  </Link>
                  <div className="nav-links">
                    <Link href="/products" className="nav-link">{t('nav.products')}</Link>
                    <Link href="/cart" className="nav-cart">
                      🛒 <span className="cart-text">{t('nav.cart')}</span>
                      {totalQty > 0 && <span className="cart-badge">{totalQty}</span>}
                    </Link>
                    {!userLoading && (
                      user
                        ? <Link href="/account" className="nav-link">{lang === 'zh' ? '會員中心' : 'Account'}</Link>
                        : <Link href="/auth" className="nav-link">{lang === 'zh' ? '登入' : 'Login'}</Link>
                    )}
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className={`lang-btn ${lang === 'zh' ? 'active' : ''}`} onClick={() => setLang('zh')}>中</button>
                      <button className={`lang-btn ${lang === 'en' ? 'active' : ''}`} onClick={() => setLang('en')}>EN</button>
                    </div>
                  </div>
                </div>
              </nav>

              {children}

              <footer className="footer">
                {footerPages.length > 0 && (
                  <div className="footer-links">
                    {footerPages.map(p => (
                      <Link key={p.slug} href={`/legal/${p.slug}`}>{p.title}</Link>
                    ))}
                  </div>
                )}
                {store?.settings?.sender_email && (
                  <div style={{ marginBottom: 6 }}>
                    {lang === 'en' ? 'Contact: ' : '聯絡我們：'}
                    <a href={`mailto:${store.settings.sender_email}`} style={{ color: 'inherit', textDecoration: 'underline' }}>
                      {store.settings.sender_email}
                    </a>
                  </div>
                )}
                © 2026 {store?.name || ''}. All rights reserved.
              </footer>

              {toast && <div className="toast">{toast}</div>}
            </CartContext.Provider>
          </I18nContext.Provider>
        </UserContext.Provider>
      </body>
    </html>
  )
}
