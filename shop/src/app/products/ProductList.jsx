'use client'
import { useEffect, useState, useRef } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useI18n } from '../layout'
import { getCardPricing } from '../../lib/salePrice'
import { slugifyName } from '../../lib/slug'
import { getMenuItems, groupEnabled, resolvePin } from '../../lib/menu'

// 無法下單判斷：手動售完、收單截止、或庫存歸零。限時單與略過庫存檢查的商品不看庫存；
// 多規格只要任一規格有庫存即算有貨。篩選、排序、卡片三處共用，勿各自複製。
function getAvailability(sp) {
  const isCollection = !!sp.collection_end
  const collectionExpired = isCollection && new Date(sp.collection_end) < new Date()
  const variants = sp.products?.product_variants || []
  const allVariantsSoldOut = variants.length > 0
    ? variants.every(v => (v.stock ?? 0) <= 0)
    : (sp.products?.quantity ?? 0) <= 0
  const outOfStock = !!sp.sold_out || (!isCollection && !sp.skip_stock_check && allVariantsSoldOut)
  return { isCollection, collectionExpired, outOfStock, canOrder: !outOfStock && !collectionExpired }
}

// 資料由 server component（page.jsx）以 props 帶入。分頁狀態走 URL ?page=N。
// initialSource：品牌頁 /products/brand/[source] 帶入，預選該品牌（採購來源）。
// menuSettings：store.settings（含 menu 選單設定：群組開關＋自訂置頂專區）。
export default function ProductList({ products, categories, tags, initialSource = null, menuSettings = null }) {
  const { t, lang } = useI18n()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [search, setSearch] = useState('')
  // 分類改由網址驅動：/products?cat=<id>（漢堡選單「專區」連結可直達、可分享）。null = 全部。
  const activeCat = Number(searchParams.get('cat')) || null
  const [activeTags, setActiveTags] = useState([])   // multi-select, OR logic
  // 品牌（採購來源）改由網址驅動：/products/brand/[source]。null = 全部。
  const activeSource = initialSource ?? null
  const [filterOpen, setFilterOpen] = useState(false)         // 手機篩選面板
  const [deskFilterOpen, setDeskFilterOpen] = useState(false) // 桌機篩選列（與手機分開，避免互相牽動）
  const [sidebarOpen, setSidebarOpen] = useState({ pins: true, category: true, brand: true })
  const [openCats, setOpenCats] = useState({})       // 側欄父分類展開狀態 { catId: bool }
  const [sortBy, setSortBy] = useState('newest') // newest | oldest | price_asc | price_desc
  const [inStockOnly, setInStockOnly] = useState(false)
  const [saleOnly, setSaleOnly] = useState(false)
  const PAGE_SIZE = 30

  // Distinct sources from published products
  const sources = [...new Set(products.map(sp => sp.products?.source).filter(Boolean))].sort()

  // 分類階層：頂層＋子分類（parent_id）。選父分類時，子分類底下的商品也一併顯示。
  const topCats = categories.filter(c => !c.parent_id)
  const childrenOf = id => categories.filter(c => c.parent_id === id)
  const catName = c => (lang === 'en' && c.name_en ? c.name_en : c.name)

  // 選單設定：群組開關（關閉的群組不在側欄/篩選出現）＋自訂置頂專區
  const menuItems = getMenuItems(menuSettings)
  const showTagsGroup = groupEnabled(menuItems, 'tags')
  const showCatsGroup = groupEnabled(menuItems, 'categories')
  const showBrandsGroup = groupEnabled(menuItems, 'brands')
  const pins = menuItems.filter(i => i.type !== 'group')
    .map(i => resolvePin(i, { cats: categories, brands: sources, tags, lang }))
    .filter(Boolean)

  const filtered = products.filter(sp => {
    const name = (lang === 'en' && sp.name_en ? sp.name_en : sp.products?.name) || ''
    const matchSearch = name.toLowerCase().includes(search.toLowerCase()) ||
      sp.products?.sku?.toLowerCase().includes(search.toLowerCase())
    const cat = sp.products?.categories
    const matchCat = activeCat === null || cat?.id === activeCat || cat?.parent_id === activeCat
    const productTagIds = (sp.products?.product_tags || []).map(pt => pt.tag_id)
    const matchTag = activeTags.length === 0 || activeTags.some(tid => productTagIds.includes(tid))
    const matchSource = activeSource === null || (sp.products?.source || '') === activeSource
    const matchStock = !inStockOnly || getAvailability(sp).canOrder
    const matchSale = !saleOnly || getCardPricing(sp).onSale
    return matchSearch && matchCat && matchTag && matchSource && matchStock && matchSale
  })

  // Sort
  const sortOptions = [
    { value: 'newest', label: lang === 'zh' ? '最新上架' : 'Newest' },
    { value: 'oldest', label: lang === 'zh' ? '最早上架' : 'Oldest' },
    { value: 'sale_first', label: lang === 'zh' ? '特價優先' : 'On Sale First' },
    { value: 'price_asc', label: lang === 'zh' ? '價格低到高' : 'Price: Low to High' },
    { value: 'price_desc', label: lang === 'zh' ? '價格高到低' : 'Price: High to Low' },
  ]
  // 有效價最低值（特價中則為特價，否則原價）— 排序用
  const effPrice = sp => getCardPricing(sp).saleMin
  const sorted = [...filtered].sort((a, b) => {
    // 無法下單的（缺貨／收單截止）一律沉底，群組內再照所選排序
    const ua = getAvailability(a).canOrder ? 0 : 1
    const ub = getAvailability(b).canOrder ? 0 : 1
    if (ua !== ub) return ua - ub
    if (sortBy === 'oldest') return new Date(a.created_at) - new Date(b.created_at)
    if (sortBy === 'sale_first') {
      const sa = getCardPricing(a).onSale ? 0 : 1
      const sb = getCardPricing(b).onSale ? 0 : 1
      if (sa !== sb) return sa - sb
      return new Date(b.created_at) - new Date(a.created_at)
    }
    if (sortBy === 'price_asc') return effPrice(a) - effPrice(b)
    if (sortBy === 'price_desc') return effPrice(b) - effPrice(a)
    return new Date(b.created_at) - new Date(a.created_at) // newest
  })

  // ── 分頁：頁碼存在 URL ?page=N ──
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const rawPage = Number(searchParams.get('page')) || 1
  const page = Math.min(Math.max(1, rawPage), totalPages) // clamp 到有效範圍
  const paged = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  function goToPage(n) {
    const params = new URLSearchParams(Array.from(searchParams.entries()))
    if (n <= 1) params.delete('page')
    else params.set('page', String(n))
    const qs = params.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // 品牌選取 → 導向可分享的品牌網址（null = 回全部商品）。
  function goToBrand(src) {
    router.push(src ? `/products/brand/${encodeURIComponent(src)}` : '/products', { scroll: false })
  }

  // 分類選取 → 寫回網址 ?cat=<id> 並回到第 1 頁。null = 清除分類。
  function goToCat(id) {
    const params = new URLSearchParams(Array.from(searchParams.entries()))
    if (id == null) params.delete('cat')
    else params.set('cat', String(id))
    params.delete('page')
    const qs = params.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  // 標籤連結支援：/products?tag=<id>（漢堡選單、置頂專區用）。
  const tagParam = Number(searchParams.get('tag')) || null
  useEffect(() => {
    if (tagParam) setActiveTags([tagParam])
  }, [tagParam])

  // 清除全部：一次移除 cat / tag / page 參數
  function clearUrlFilters() {
    const params = new URLSearchParams(Array.from(searchParams.entries()))
    params.delete('cat'); params.delete('tag'); params.delete('page')
    const qs = params.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  // 篩選/排序改變 → 回到第 1 頁（移除 page 參數）。略過首次渲染。
  const firstRender = useRef(true)
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return }
    if (!searchParams.has('page')) return
    const params = new URLSearchParams(Array.from(searchParams.entries()))
    params.delete('page')
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, activeCat, activeTags, activeSource, sortBy, inStockOnly, saleOnly])

  function toggleTag(id) {
    setActiveTags(prev => prev.includes(id) ? prev.filter(t => t !== id) : [...prev, id])
    // 手動增減標籤後移除網址 tag 參數，避免網址與實際選取脫鉤
    if (searchParams.has('tag')) {
      const params = new URLSearchParams(Array.from(searchParams.entries()))
      params.delete('tag')
      const qs = params.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    }
  }

  const hasActiveFilter = activeCat || activeSource || activeTags.length > 0 || inStockOnly || saleOnly
  const zh = lang === 'zh'

  // Shared filter summary chips
  const filterChips = hasActiveFilter && (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16, alignItems: 'center' }}>
      <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{zh ? '篩選中：' : 'Filtered:'}</span>
      {inStockOnly && (
        <span className="filter-chip" onClick={() => setInStockOnly(false)}>
          {zh ? '有貨' : 'In Stock'} ×
        </span>
      )}
      {saleOnly && (
        <span className="filter-chip" onClick={() => setSaleOnly(false)}>
          {zh ? '特價中' : 'On Sale'} ×
        </span>
      )}
      {activeCat && (
        <span className="filter-chip" onClick={() => goToCat(null)}>
          {(lang === 'en' && categories.find(c => c.id === activeCat)?.name_en) || categories.find(c => c.id === activeCat)?.name} ×
        </span>
      )}
      {activeSource && (
        <span className="filter-chip" onClick={() => goToBrand(null)}>
          {activeSource} ×
        </span>
      )}
      {activeTags.map(tid => {
        const tg = tags.find(t => t.id === tid)
        return tg ? (
          <span key={tid} className="filter-chip" onClick={() => toggleTag(tid)}>
            {lang === 'en' && tg.name_en ? tg.name_en : tg.name} ×
          </span>
        ) : null
      })}
      <button
        onClick={() => { setActiveTags([]); setInStockOnly(false); setSaleOnly(false); if (initialSource) goToBrand(null); else clearUrlFilters() }}
        style={{ fontSize: 12, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px' }}
      >
        {zh ? '清除全部' : 'Clear all'}
      </button>
    </div>
  )

  // Shared product grid content
  const productContent = filtered.length === 0 ? (
    <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-3)' }}>
      {zh ? '找不到商品' : 'No products found'}
    </div>
  ) : (
    <>
      <div className="product-grid">
        {paged.map(sp => <ProductCard key={sp.id} sp={sp} t={t} lang={lang} allTags={tags} />)}
      </div>
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 32, flexWrap: 'wrap' }}>
          <button
            onClick={() => goToPage(page - 1)}
            disabled={page === 1}
            style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', cursor: page === 1 ? 'default' : 'pointer', opacity: page === 1 ? 0.4 : 1 }}
          >
            ‹
          </button>
          {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
            <button
              key={p}
              onClick={() => goToPage(p)}
              style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)', background: p === page ? 'var(--text)' : 'var(--bg)', color: p === page ? '#fff' : 'var(--text)', cursor: 'pointer', fontWeight: p === page ? 700 : 400, minWidth: 36 }}
            >
              {p}
            </button>
          ))}
          <button
            onClick={() => goToPage(page + 1)}
            disabled={page === totalPages}
            style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', cursor: page === totalPages ? 'default' : 'pointer', opacity: page === totalPages ? 0.4 : 1 }}
          >
            ›
          </button>
        </div>
      )}
    </>
  )

  return (
    <div className="section">
      <div className="container">
        {/* Mobile: title + toggle + collapsible filter bar */}
        <div className="mobile-filter-area">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h1 className="section-title" style={{ marginBottom: 0 }}>{t('nav.products')}</h1>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div style={{ width: 130 }}>
                <FilterDropdown
                  label={sortOptions.find(o => o.value === sortBy)?.label}
                  value={sortBy}
                  options={sortOptions}
                  onChange={v => setSortBy(v || 'newest')}
                  hideReset
                />
              </div>
              <button
                className="filter-toggle-btn"
                onClick={() => setFilterOpen(v => !v)}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="4" y1="6" x2="20" y2="6" /><line x1="8" y1="12" x2="20" y2="12" /><line x1="12" y1="18" x2="20" y2="18" />
                  <circle cx="6" cy="12" r="1.5" fill="currentColor" /><circle cx="10" cy="18" r="1.5" fill="currentColor" />
                </svg>
                {zh ? '篩選' : 'Filter'}
                {(hasActiveFilter || search || inStockOnly) && <span className="filter-toggle-dot" />}
              </button>
            </div>
          </div>
          {filterOpen && (
            <div className="filter-bar" style={{ animation: 'filterSlideDown .2s ease' }}>
              <div className="filter-search">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  style={{ border: 'none', background: 'transparent', outline: 'none', fontSize: 15, color: 'var(--text)', flex: 1, minWidth: 0 }}
                  placeholder={zh ? '搜尋商品…' : 'Search…'}
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  autoFocus
                />
                {search && (
                  <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', fontSize: 16, color: 'var(--text-3)', cursor: 'pointer', padding: 0 }}>×</button>
                )}
              </div>
              {/* 分類/品牌已收進導覽列漢堡選單（layout.jsx），手機篩選面板只留搜尋＋標籤 */}
              <div className="filter-tags-row">
                <button onClick={() => setInStockOnly(v => !v)}
                  className={inStockOnly ? 'filter-tag filter-tag-active' : 'filter-tag'}>
                  {zh ? '有貨' : 'In Stock'}
                </button>
                <button onClick={() => setSaleOnly(v => !v)}
                  className={saleOnly ? 'filter-tag filter-tag-sale-active' : 'filter-tag'}>
                  {zh ? '特價中' : 'On Sale'}
                </button>
                {showTagsGroup && tags.map(tg => (
                  <button key={tg.id} onClick={() => toggleTag(tg.id)}
                    className={activeTags.includes(tg.id) ? 'filter-tag filter-tag-active' : 'filter-tag'}>
                    {lang === 'en' && tg.name_en ? tg.name_en : tg.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          {filterChips}
          {productContent}
        </div>

        {/* Desktop: sidebar + main layout */}
        <div className="products-layout">
          <aside className="filter-sidebar">
            {/* Search */}
            <div className="sidebar-search">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                className="sidebar-search-input"
                placeholder={zh ? '搜尋商品…' : 'Search…'}
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              {search && (
                <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', fontSize: 14, color: 'var(--text-3)', cursor: 'pointer', padding: 0, lineHeight: 1 }}>×</button>
              )}
            </div>

            {/* 精選專區（店家在後台「選單」設定的置頂項目） */}
            {pins.length > 0 && (
              <div className="sidebar-group">
                <button className="sidebar-group-title" onClick={() => setSidebarOpen(s => ({ ...s, pins: !s.pins }))}>
                  <span>{zh ? '精選專區' : 'Featured'}</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ transition: 'transform .2s', transform: sidebarOpen.pins ? 'rotate(180deg)' : '' }}><path d="M6 9l6 6 6-6" /></svg>
                </button>
                {sidebarOpen.pins && pins.map(p => (
                  <Link key={p.key} href={p.href} className="sidebar-option sidebar-option-pin">{p.label}</Link>
                ))}
              </div>
            )}

            {/* 標籤/篩選 pills 移到商品列表上方（排序旁），與手機版一致；側欄留純導覽 */}

            {/* Categories */}
            {showCatsGroup && categories.length > 0 && (
              <div className="sidebar-group">
                <button className="sidebar-group-title" onClick={() => setSidebarOpen(s => ({ ...s, category: !s.category }))}>
                  <span>{zh ? '分類' : 'Category'}</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ transition: 'transform .2s', transform: sidebarOpen.category ? 'rotate(180deg)' : '' }}><path d="M6 9l6 6 6-6" /></svg>
                </button>
                {sidebarOpen.category && (
                  <>
                    <button
                      className={`sidebar-option${activeCat === null ? ' active' : ''}`}
                      onClick={() => goToCat(null)}
                    >
                      {zh ? '全部分類' : 'All'}
                    </button>
                    {topCats.map(c => {
                      const kids = childrenOf(c.id)
                      // 子分類被選中時自動展開，其餘依使用者點擊狀態
                      const expanded = openCats[c.id] ?? kids.some(k => k.id === activeCat)
                      return (
                        <div key={c.id}>
                          <div style={{ display: 'flex', alignItems: 'center' }}>
                            <button
                              className={`sidebar-option${activeCat === c.id ? ' active' : ''}`}
                              style={{ flex: 1 }}
                              onClick={() => goToCat(activeCat === c.id ? null : c.id)}
                            >
                              {catName(c)}
                            </button>
                            {kids.length > 0 && (
                              <button
                                onClick={() => setOpenCats(s => ({ ...s, [c.id]: !expanded }))}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px', color: 'var(--text-3)' }}
                              >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ transition: 'transform .2s', transform: expanded ? 'rotate(180deg)' : '' }}><path d="M6 9l6 6 6-6" /></svg>
                              </button>
                            )}
                          </div>
                          {kids.length > 0 && expanded && kids.map(k => (
                            <button
                              key={k.id}
                              className={`sidebar-option${activeCat === k.id ? ' active' : ''}`}
                              style={{ paddingLeft: 22 }}
                              onClick={() => goToCat(activeCat === k.id ? null : k.id)}
                            >
                              {catName(k)}
                            </button>
                          ))}
                        </div>
                      )
                    })}
                  </>
                )}
              </div>
            )}

            {/* Brands / Sources */}
            {showBrandsGroup && sources.length > 0 && (
              <div className="sidebar-group">
                <button className="sidebar-group-title" onClick={() => setSidebarOpen(s => ({ ...s, brand: !s.brand }))}>
                  <span>{zh ? '品牌' : 'Brand'}</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ transition: 'transform .2s', transform: sidebarOpen.brand ? 'rotate(180deg)' : '' }}><path d="M6 9l6 6 6-6" /></svg>
                </button>
                {sidebarOpen.brand && (
                  <>
                    <button
                      className={`sidebar-option${activeSource === null ? ' active' : ''}`}
                      onClick={() => goToBrand(null)}
                    >
                      {zh ? '全部品牌' : 'All'}
                    </button>
                    {sources.map(src => (
                      <button
                        key={src}
                        className={`sidebar-option${activeSource === src ? ' active' : ''}`}
                        onClick={() => goToBrand(activeSource === src ? null : src)}
                      >
                        {src}
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}

          </aside>

          <div className="products-main">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <div className="section-title" style={{ marginBottom: 0 }}>
                {t('nav.products')}
                <span style={{ fontSize: 15, fontWeight: 400, color: 'var(--text-3)', marginLeft: 8 }}>
                  ({sorted.length})
                </span>
              </div>
              {/* 排序＋篩選按鈕（與手機版一致：點開才展開標籤，避免標籤一多把版面撐爆） */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 170 }}>
                  <FilterDropdown
                    label={sortOptions.find(o => o.value === sortBy)?.label}
                    value={sortBy}
                    options={sortOptions}
                    onChange={v => setSortBy(v || 'newest')}
                    hideReset
                  />
                </div>
                <button className="filter-toggle-btn" onClick={() => setDeskFilterOpen(v => !v)}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="4" y1="6" x2="20" y2="6" /><line x1="8" y1="12" x2="20" y2="12" /><line x1="12" y1="18" x2="20" y2="18" />
                    <circle cx="6" cy="12" r="1.5" fill="currentColor" /><circle cx="10" cy="18" r="1.5" fill="currentColor" />
                  </svg>
                  {zh ? '篩選' : 'Filter'}
                  {(inStockOnly || saleOnly || activeTags.length > 0) && <span className="filter-toggle-dot" />}
                </button>
              </div>
            </div>
            {deskFilterOpen && (
              <div className="filter-tags-row" style={{ marginBottom: 16, animation: 'filterSlideDown .2s ease' }}>
                <button onClick={() => setInStockOnly(v => !v)}
                  className={inStockOnly ? 'filter-tag filter-tag-active' : 'filter-tag'}>
                  {zh ? '有貨' : 'In Stock'}
                </button>
                <button onClick={() => setSaleOnly(v => !v)}
                  className={saleOnly ? 'filter-tag filter-tag-sale-active' : 'filter-tag'}>
                  {zh ? '特價中' : 'On Sale'}
                </button>
                {showTagsGroup && tags.map(tg => (
                  <button key={tg.id} onClick={() => toggleTag(tg.id)}
                    className={activeTags.includes(tg.id) ? 'filter-tag filter-tag-active' : 'filter-tag'}>
                    {lang === 'en' && tg.name_en ? tg.name_en : tg.name}
                  </button>
                ))}
              </div>
            )}
            {filterChips}
            {productContent}
          </div>
        </div>
      </div>
    </div>
  )
}

function ProductCard({ sp, t, lang, allTags }) {
  const p = sp.products
  if (!p) return null
  const name = lang === 'en' && sp.name_en ? sp.name_en : p.name
  const desc = lang === 'en' ? sp.desc_en : sp.desc_zh
  const thumb = [...(p.product_images || [])].sort((a, b) => a.sort_order - b.sort_order)[0]?.url
  const zh = lang === 'zh'
  const card = getCardPricing(sp)
  const fmtRange = (min, max) => min === max
    ? `NT$${min.toLocaleString()}`
    : `NT$${min.toLocaleString()}~${max.toLocaleString()}`

  // Resolve tag names
  const productTagIds = (p.product_tags || []).map(pt => pt.tag_id)
  const productTags = (allTags || []).filter(tg => productTagIds.includes(tg.id))

  // Status logic（含庫存歸零；規則見 getAvailability）
  const { isCollection, collectionExpired, outOfStock, canOrder } = getAvailability(sp)
  const unavailable = !canOrder

  let statusBadge = null
  if (outOfStock) {
    statusBadge = <span className="product-badge product-badge-soldout">{zh ? '缺貨中' : 'Sold Out'}</span>
  } else if (collectionExpired) {
    statusBadge = <span className="product-badge product-badge-expired">{zh ? '收單已截止' : 'Collection Ended'}</span>
  } else if (isCollection) {
    const end = new Date(sp.collection_end)
    const dateStr = end.toLocaleDateString(zh ? 'zh-TW' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    statusBadge = <span className="product-badge product-badge-collection">{zh ? `收單至 ${dateStr}` : `Until ${dateStr}`}</span>
  }

  return (
    <Link href={`/products/${sp.product_id}/${slugifyName(name)}`} className="product-card" style={unavailable ? { opacity: 0.6 } : {}}>
      <div style={{ position: 'relative' }}>
        {thumb
          ? <img src={thumb} alt={name} className="product-img-placeholder" style={{objectFit:'cover'}} loading="lazy" />
          : <div className="product-img-placeholder">📦</div>}
        {(statusBadge || (card.onSale && !unavailable)) && (
          <div style={{ position: 'absolute', top: 8, left: 8, display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
            {statusBadge}
            {card.onSale && !unavailable && (
              <span className="product-badge product-badge-sale">{zh ? '特價' : 'Sale'}</span>
            )}
          </div>
        )}
      </div>
      <div className="product-info">
        <div className="product-name">{name}</div>
        {productTags.length > 0 && (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4, marginBottom: 2 }}>
            {productTags.map(tg => (
              <span key={tg.id} className="product-tag">
                {lang === 'en' && tg.name_en ? tg.name_en : tg.name}
              </span>
            ))}
          </div>
        )}
        {desc && <div className="product-desc">{desc}</div>}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          {card.onSale ? (
            <>
              <span className="product-price product-price-sale">{fmtRange(card.saleMin, card.saleMax)}</span>
              <span className="product-price-old">{fmtRange(card.regularMin, card.regularMax)}</span>
            </>
          ) : (
            <span className="product-price">{fmtRange(card.regularMin, card.regularMax)}</span>
          )}
        </div>
        <div className="product-variants-hint">
          {unavailable
            ? (outOfStock ? (zh ? '缺貨中' : 'Sold Out') : (zh ? '收單已截止' : 'Collection Ended'))
            : (zh ? '點擊選擇規格' : 'Click to select variant')
          }
        </div>
      </div>
    </Link>
  )
}

function FilterDropdown({ label, value, options, onChange, hideReset }) {
  const [open, setOpen] = useState(false)
  const [dropup, setDropup] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    if (open) document.addEventListener('click', handleClick, true)
    return () => document.removeEventListener('click', handleClick, true)
  }, [open])

  const selected = options.find(o => o.value === value)

  const handleToggle = () => {
    if (!open && ref.current) {
      const rect = ref.current.getBoundingClientRect()
      const spaceBelow = window.innerHeight - rect.bottom
      setDropup(spaceBelow < 220)
    }
    setOpen(v => !v)
  }

  return (
    <div className="custom-dropdown" ref={ref}>
      <button className="custom-dropdown-btn" onClick={handleToggle}>
        <span className={selected ? 'custom-dropdown-selected' : ''}>{selected ? selected.label : label}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ flexShrink: 0, transition: 'transform .2s', transform: open ? 'rotate(180deg)' : '' }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className={`custom-dropdown-menu${dropup ? ' dropup' : ''}`}>
          {!hideReset && (
            <div
              className={`custom-dropdown-item ${!value ? 'active' : ''}`}
              onClick={() => { onChange(null); setOpen(false) }}
            >
              {label}
            </div>
          )}
          {options.map(opt => (
            <div
              key={opt.value}
              className={`custom-dropdown-item ${value === opt.value ? 'active' : ''}`}
              onClick={() => { onChange(opt.value); setOpen(false) }}
            >
              {opt.label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
