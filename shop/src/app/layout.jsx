'use client'
import './globals.css'
import { createContext, useContext, useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { supabase } from '../lib/supabase'
import { getStore, getStorePages } from '../lib/store'
import { getMenuItems, resolvePin } from '../lib/menu'
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
  const [menuOpen, setMenuOpen] = useState(false)   // 手機版漢堡抽屜
  const [navCats, setNavCats] = useState([])        // 分類（專區）選單資料
  const [navBrands, setNavBrands] = useState([])    // 品牌（採購來源）選單資料
  const [navTags, setNavTags] = useState([])        // 標籤選單資料
  const [openCats, setOpenCats] = useState({})      // 抽屜內父分類展開狀態
  const [openGroups, setOpenGroups] = useState({})  // 抽屜內群組（分類/品牌/標籤）展開狀態

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

  // 漢堡抽屜：抓該店分類（含 parent_id 做兩層專區）＋已上架商品的品牌；換頁自動關閉；開啟時鎖 body 捲動
  useEffect(() => {
    if (!store) return
    supabase.from('categories')
      .select('id, name, name_en, parent_id, sort_order')
      .eq('store_id', store.id).eq('active', true)
      .order('sort_order').order('name')
      .then(({ data }) => setNavCats(data || []))
    supabase.from('storefront_products')
      .select('products:shop_products(source)')
      .eq('store_id', store.id).eq('published', true)
      .then(({ data }) => {
        setNavBrands([...new Set((data || []).map(r => r.products?.source).filter(Boolean))].sort())
      })
    supabase.from('tags')
      .select('id, name, name_en, sort_order')
      .eq('store_id', store.id)
      .order('sort_order').order('name')
      .then(({ data }) => setNavTags(data || []))
  }, [store])
  useEffect(() => { setMenuOpen(false) }, [pathname])
  useEffect(() => {
    document.body.style.overflow = menuOpen ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [menuOpen])

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

  // 導覽選單設定（店家在後台「選單」子分頁調整）：群組開關/順序＋自訂置頂項
  const menuItems = getMenuItems(store?.settings)
  const pinCtx = { cats: navCats, brands: navBrands, tags: navTags, lang }
  const navPins = menuItems.filter(i => i.type !== 'group').map(i => resolvePin(i, pinCtx)).filter(Boolean)

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
                    {/* 自訂置頂專區（桌機導覽列；手機由 CSS 隱藏、收進漢堡抽屜） */}
                    {navPins.map(p => (
                      <Link key={p.key} href={p.href} className="nav-link nav-link-pin">{p.label}</Link>
                    ))}
                    <Link href="/cart" className="nav-cart">
                      🛒 <span className="cart-text">{t('nav.cart')}</span>
                      {totalQty > 0 && <span className="cart-badge">{totalQty}</span>}
                    </Link>
                    {!userLoading && (
                      user
                        ? <Link href="/account" className="nav-link">{lang === 'zh' ? '會員中心' : 'Account'}</Link>
                        : <Link href="/auth" className="nav-link">{lang === 'zh' ? '登入' : 'Login'}</Link>
                    )}
                    {/* 語言切換：手機版收進漢堡抽屜（display 由 CSS 控制，勿加行內樣式） */}
                    <div className="nav-lang">
                      <button className={`lang-btn ${lang === 'zh' ? 'active' : ''}`} onClick={() => setLang('zh')}>中</button>
                      <button className={`lang-btn ${lang === 'en' ? 'active' : ''}`} onClick={() => setLang('en')}>EN</button>
                    </div>
                    <button className="nav-burger" onClick={() => setMenuOpen(true)} aria-label={lang === 'zh' ? '選單' : 'Menu'}>
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>
                    </button>
                  </div>
                </div>
              </nav>

              {/* 手機版漢堡抽屜：分類專區（兩層）＋會員＋語言切換。桌機由 CSS 隱藏。 */}
              <div className={`drawer-overlay${menuOpen ? ' show' : ''}`} onClick={() => setMenuOpen(false)} />
              <aside className={`drawer${menuOpen ? ' open' : ''}`}>
                <div className="drawer-head">
                  <span style={{ fontWeight: 700, fontSize: 16 }}>{store?.name || ''}</span>
                  <button className="drawer-close" onClick={() => setMenuOpen(false)} aria-label={lang === 'zh' ? '關閉' : 'Close'}>×</button>
                </div>
                <Link href="/products" className="drawer-link" onClick={() => setMenuOpen(false)}>{t('nav.products')}</Link>
                {/* 依店家選單設定渲染：置頂項為直接連結，群組項為可展開清單 */}
                {menuItems.map((item, mi) => {
                  const label = x => (lang === 'en' && x.name_en ? x.name_en : x.name)
                  const groupRow = (key, title, children) => (
                    <div key={`g-${key}`}>
                      <div className="drawer-row">
                        <button className="drawer-link drawer-toggle" onClick={() => setOpenGroups(s => ({ ...s, [key]: !s[key] }))}>
                          {title}
                        </button>
                        <button className="drawer-expand" onClick={() => setOpenGroups(s => ({ ...s, [key]: !s[key] }))} aria-label={openGroups[key] ? 'collapse' : 'expand'}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ transition: 'transform .2s', transform: openGroups[key] ? 'rotate(180deg)' : '' }}><path d="M6 9l6 6 6-6" /></svg>
                        </button>
                      </div>
                      {openGroups[key] && children}
                    </div>
                  )
                  if (item.type === 'group') {
                    if (!item.enabled) return null
                    if (item.key === 'categories' && navCats.length > 0) {
                      return groupRow('categories', lang === 'zh' ? '分類' : 'Categories', navCats.filter(c => !c.parent_id).map(c => {
                        const kids = navCats.filter(k => k.parent_id === c.id)
                        const expanded = !!openCats[c.id]
                        return (
                          <div key={c.id}>
                            <div className="drawer-row">
                              <Link href={`/products?cat=${c.id}`} className="drawer-link drawer-sub" onClick={() => setMenuOpen(false)}>
                                {label(c)}
                              </Link>
                              {kids.length > 0 && (
                                <button className="drawer-expand" onClick={() => setOpenCats(s => ({ ...s, [c.id]: !expanded }))} aria-label={expanded ? 'collapse' : 'expand'}>
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ transition: 'transform .2s', transform: expanded ? 'rotate(180deg)' : '' }}><path d="M6 9l6 6 6-6" /></svg>
                                </button>
                              )}
                            </div>
                            {expanded && kids.map(k => (
                              <Link key={k.id} href={`/products?cat=${k.id}`} className="drawer-link drawer-sub2" onClick={() => setMenuOpen(false)}>
                                {label(k)}
                              </Link>
                            ))}
                          </div>
                        )
                      }))
                    }
                    if (item.key === 'brands' && navBrands.length > 0) {
                      return groupRow('brands', lang === 'zh' ? '品牌' : 'Brands', navBrands.map(src => (
                        <Link key={src} href={`/products/brand/${encodeURIComponent(src)}`} className="drawer-link drawer-sub" onClick={() => setMenuOpen(false)}>
                          {src}
                        </Link>
                      )))
                    }
                    if (item.key === 'tags' && navTags.length > 0) {
                      return groupRow('tags', lang === 'zh' ? '標籤' : 'Tags', navTags.map(tg => (
                        <Link key={tg.id} href={`/products?tag=${tg.id}`} className="drawer-link drawer-sub" onClick={() => setMenuOpen(false)}>
                          {label(tg)}
                        </Link>
                      )))
                    }
                    return null
                  }
                  const pin = resolvePin(item, pinCtx)
                  return pin && (
                    <Link key={pin.key} href={pin.href} className="drawer-link drawer-pin" onClick={() => setMenuOpen(false)}>
                      {pin.label}
                    </Link>
                  )
                })}
                {!userLoading && (
                  user
                    ? <Link href="/account" className="drawer-link" onClick={() => setMenuOpen(false)}>{lang === 'zh' ? '會員中心' : 'Account'}</Link>
                    : <Link href="/auth" className="drawer-link" onClick={() => setMenuOpen(false)}>{lang === 'zh' ? '登入' : 'Login'}</Link>
                )}
                <div className="drawer-lang">
                  <button className={`lang-btn ${lang === 'zh' ? 'active' : ''}`} onClick={() => setLang('zh')}>中</button>
                  <button className={`lang-btn ${lang === 'en' ? 'active' : ''}`} onClick={() => setLang('en')}>EN</button>
                </div>
              </aside>

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
