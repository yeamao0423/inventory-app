'use client'
import './globals.css'
import { createContext, useContext, useState, useEffect } from 'react'
import Link from 'next/link'
import { supabase } from '../lib/supabase'
import zhMessages from '../messages/zh.json'
import enMessages from '../messages/en.json'

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
  const [msgs, setMsgs] = useState({})
  const [cart, setCart] = useState([])
  const [toast, setToast] = useState('')
  const [user, setUser] = useState(null)
  const [userLoading, setUserLoading] = useState(true)

  useEffect(() => {
    const saved = localStorage.getItem('lang') || 'zh'
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
    <html lang={lang}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Daigogo</title>
        <link rel="icon" href="/logo.png" />
      </head>
      <body>
        <UserContext.Provider value={{ user, loading: userLoading }}>
          <I18nContext.Provider value={{ t, lang, setLang }}>
            <CartContext.Provider value={{ cart, addItem, removeItem, clearCart }}>
              <nav className="nav">
                <div className="nav-inner">
                  <Link href="/" className="nav-logo"><img src="/logo.png" alt="Daigogo" style={{ height: 28, marginRight: 6, verticalAlign: 'middle' }} />Daigogo</Link>
                  <div className="nav-links">
                    <Link href="/products" className="nav-link">{t('nav.products')}</Link>
                    <Link href="/cart" className="nav-cart">
                      🛒 {t('nav.cart')}
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
                © 2026 Daigogo. All rights reserved.
              </footer>

              {toast && <div className="toast">{toast}</div>}
            </CartContext.Provider>
          </I18nContext.Provider>
        </UserContext.Provider>
      </body>
    </html>
  )
}
