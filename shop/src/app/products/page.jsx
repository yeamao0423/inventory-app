'use client'
import { useEffect, useState, useRef } from 'react'
import Link from 'next/link'
import { supabase } from '../../lib/supabase'
import { getStoreId } from '../../lib/store'
import { useI18n } from '../layout'

export default function ProductsPage() {
  const { t, lang } = useI18n()
  const [products, setProducts] = useState([])
  const [categories, setCategories] = useState([])
  const [tags, setTags] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [activeCat, setActiveCat] = useState(null)   // null = 全部
  const [activeTags, setActiveTags] = useState([])   // multi-select, OR logic
  const [activeSource, setActiveSource] = useState(null) // null = 全部
  const [filterOpen, setFilterOpen] = useState(false)
  const [page, setPage] = useState(1)
  const [sidebarOpen, setSidebarOpen] = useState({ tags: true, category: true, brand: true })
  const [sortBy, setSortBy] = useState('newest') // newest | oldest | price_asc | price_desc
  const [inStockOnly, setInStockOnly] = useState(true)
  const PAGE_SIZE = 20

  useEffect(() => {
    getStoreId().then(storeId => Promise.all([
      supabase
        .from('storefront_products')
        .select('*, products:shop_products(*, product_images(url, sort_order), categories(id, name, name_en), product_tags(tag_id), product_variants(stock))')
        .eq('store_id', storeId)
        .eq('published', true)
        .order('created_at', { ascending: false }),
      supabase.from('categories').select('*').eq('store_id', storeId).order('sort_order').order('name'),
      supabase.from('tags').select('*').eq('store_id', storeId).order('sort_order').order('name'),
    ])).then(([{ data: sp }, { data: cats }, { data: tgs }]) => {
      setProducts(sp || [])
      setCategories(cats || [])
      setTags(tgs || [])
      setLoading(false)
    })
  }, [])

  // Distinct sources from published products
  const sources = [...new Set(products.map(sp => sp.products?.source).filter(Boolean))].sort()

  const filtered = products.filter(sp => {
    const name = (lang === 'en' && sp.name_en ? sp.name_en : sp.products?.name) || ''
    const matchSearch = name.toLowerCase().includes(search.toLowerCase()) ||
      sp.products?.sku?.toLowerCase().includes(search.toLowerCase())
    const matchCat = activeCat === null || sp.products?.categories?.id === activeCat
    const productTagIds = (sp.products?.product_tags || []).map(pt => pt.tag_id)
    const matchTag = activeTags.length === 0 || activeTags.some(tid => productTagIds.includes(tid))
    const matchSource = activeSource === null || (sp.products?.source || '') === activeSource
    const isCollection = !!sp.collection_end
    const collectionExpired = isCollection && new Date(sp.collection_end) < new Date()
    const variants = sp.products?.product_variants || []
    const allVariantsSoldOut = variants.length > 0
      ? variants.every(v => (v.stock ?? 0) <= 0)
      : (sp.products?.quantity ?? 0) <= 0
    const skipStock = sp.skip_stock_check
    const stockUnavailable = !isCollection && !skipStock && allVariantsSoldOut
    const matchStock = !inStockOnly || (!sp.sold_out && !collectionExpired && !stockUnavailable)
    return matchSearch && matchCat && matchTag && matchSource && matchStock
  })

  // Sort
  const sortOptions = [
    { value: 'newest', label: lang === 'zh' ? '最新上架' : 'Newest' },
    { value: 'oldest', label: lang === 'zh' ? '最早上架' : 'Oldest' },
    { value: 'price_asc', label: lang === 'zh' ? '價格低到高' : 'Price: Low to High' },
    { value: 'price_desc', label: lang === 'zh' ? '價格高到低' : 'Price: High to Low' },
  ]
  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === 'oldest') return new Date(a.created_at) - new Date(b.created_at)
    if (sortBy === 'price_asc') return (a.shop_price || 0) - (b.shop_price || 0)
    if (sortBy === 'price_desc') return (b.shop_price || 0) - (a.shop_price || 0)
    return new Date(b.created_at) - new Date(a.created_at) // newest
  })

  // Reset to page 1 when any filter changes
  useEffect(() => { setPage(1) }, [search, activeCat, activeTags, activeSource, sortBy, inStockOnly])

  function toggleTag(id) {
    setActiveTags(prev => prev.includes(id) ? prev.filter(t => t !== id) : [...prev, id])
  }

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const paged = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const hasActiveFilter = activeCat || activeSource || activeTags.length > 0 || inStockOnly
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
      {activeCat && (
        <span className="filter-chip" onClick={() => setActiveCat(null)}>
          {(lang === 'en' && categories.find(c => c.id === activeCat)?.name_en) || categories.find(c => c.id === activeCat)?.name} ×
        </span>
      )}
      {activeSource && (
        <span className="filter-chip" onClick={() => setActiveSource(null)}>
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
        onClick={() => { setActiveCat(null); setActiveSource(null); setActiveTags([]); setInStockOnly(false) }}
        style={{ fontSize: 12, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px' }}
      >
        {zh ? '清除全部' : 'Clear all'}
      </button>
    </div>
  )

  // Shared product grid content
  const productContent = loading ? (
    <div className="product-grid">
      {Array.from({ length: 8 }).map((_, i) => (
        <div className="skeleton-card" key={i}>
          <div className="skeleton skeleton-img" />
          <div className="skeleton-info">
            <div className="skeleton skeleton-title" />
            <div className="skeleton skeleton-desc" />
            <div className="skeleton skeleton-price" />
          </div>
        </div>
      ))}
    </div>
  ) : filtered.length === 0 ? (
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
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', cursor: page === 1 ? 'default' : 'pointer', opacity: page === 1 ? 0.4 : 1 }}
          >
            ‹
          </button>
          {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
            <button
              key={p}
              onClick={() => setPage(p)}
              style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)', background: p === page ? 'var(--text)' : 'var(--bg)', color: p === page ? '#fff' : 'var(--text)', cursor: 'pointer', fontWeight: p === page ? 700 : 400, minWidth: 36 }}
            >
              {p}
            </button>
          ))}
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
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
              <div className="filter-dropdowns">
                {categories.length > 0 && (
                  <FilterDropdown
                    label={zh ? '所有分類' : 'All Categories'}
                    value={activeCat}
                    options={categories.map(c => ({ value: c.id, label: lang === 'en' && c.name_en ? c.name_en : c.name }))}
                    onChange={setActiveCat}
                  />
                )}
                {sources.length > 0 && (
                  <FilterDropdown
                    label={zh ? '所有品牌' : 'All Brands'}
                    value={activeSource}
                    options={sources.map(src => ({ value: src, label: src }))}
                    onChange={setActiveSource}
                  />
                )}
              </div>
              <div className="filter-tags-row">
                <button onClick={() => setInStockOnly(v => !v)}
                  className={inStockOnly ? 'filter-tag filter-tag-active' : 'filter-tag'}>
                  {zh ? '有貨' : 'In Stock'}
                </button>
                {tags.map(tg => (
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

            {/* Tags */}
            {tags.length > 0 && (
              <div className="sidebar-group">
                <button className="sidebar-group-title" onClick={() => setSidebarOpen(s => ({ ...s, tags: !s.tags }))}>
                  <span>{zh ? '標籤' : 'Tags'}</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ transition: 'transform .2s', transform: sidebarOpen.tags ? 'rotate(180deg)' : '' }}><path d="M6 9l6 6 6-6" /></svg>
                </button>
                {sidebarOpen.tags && (
                  <div className="filter-tags-row">
                    <button onClick={() => setInStockOnly(v => !v)}
                      className={inStockOnly ? 'filter-tag filter-tag-active' : 'filter-tag'}>
                      {zh ? '有貨' : 'In Stock'}
                    </button>
                    {tags.map(tg => (
                      <button key={tg.id} onClick={() => toggleTag(tg.id)}
                        className={activeTags.includes(tg.id) ? 'filter-tag filter-tag-active' : 'filter-tag'}>
                        {lang === 'en' && tg.name_en ? tg.name_en : tg.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Categories */}
            {categories.length > 0 && (
              <div className="sidebar-group">
                <button className="sidebar-group-title" onClick={() => setSidebarOpen(s => ({ ...s, category: !s.category }))}>
                  <span>{zh ? '分類' : 'Category'}</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ transition: 'transform .2s', transform: sidebarOpen.category ? 'rotate(180deg)' : '' }}><path d="M6 9l6 6 6-6" /></svg>
                </button>
                {sidebarOpen.category && (
                  <>
                    <button
                      className={`sidebar-option${activeCat === null ? ' active' : ''}`}
                      onClick={() => setActiveCat(null)}
                    >
                      {zh ? '全部分類' : 'All'}
                    </button>
                    {categories.map(c => (
                      <button
                        key={c.id}
                        className={`sidebar-option${activeCat === c.id ? ' active' : ''}`}
                        onClick={() => setActiveCat(activeCat === c.id ? null : c.id)}
                      >
                        {lang === 'en' && c.name_en ? c.name_en : c.name}
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}

            {/* Brands / Sources */}
            {sources.length > 0 && (
              <div className="sidebar-group">
                <button className="sidebar-group-title" onClick={() => setSidebarOpen(s => ({ ...s, brand: !s.brand }))}>
                  <span>{zh ? '品牌' : 'Brand'}</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ transition: 'transform .2s', transform: sidebarOpen.brand ? 'rotate(180deg)' : '' }}><path d="M6 9l6 6 6-6" /></svg>
                </button>
                {sidebarOpen.brand && (
                  <>
                    <button
                      className={`sidebar-option${activeSource === null ? ' active' : ''}`}
                      onClick={() => setActiveSource(null)}
                    >
                      {zh ? '全部品牌' : 'All'}
                    </button>
                    {sources.map(src => (
                      <button
                        key={src}
                        className={`sidebar-option${activeSource === src ? ' active' : ''}`}
                        onClick={() => setActiveSource(activeSource === src ? null : src)}
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
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h1 className="section-title" style={{ marginBottom: 0 }}>
                {t('nav.products')}
                <span style={{ fontSize: 15, fontWeight: 400, color: 'var(--text-3)', marginLeft: 8 }}>
                  ({sorted.length})
                </span>
              </h1>
              <div style={{ width: 170 }}>
                <FilterDropdown
                  label={sortOptions.find(o => o.value === sortBy)?.label}
                  value={sortBy}
                  options={sortOptions}
                  onChange={v => setSortBy(v || 'newest')}
                  hideReset
                />
              </div>
            </div>
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

  // Resolve tag names
  const productTagIds = (p.product_tags || []).map(pt => pt.tag_id)
  const productTags = (allTags || []).filter(tg => productTagIds.includes(tg.id))

  // Status logic
  const isSoldOut = sp.sold_out
  const isCollection = !!sp.collection_end
  const collectionExpired = isCollection && new Date(sp.collection_end) < new Date()
  const unavailable = isSoldOut || collectionExpired

  let statusBadge = null
  if (isSoldOut) {
    statusBadge = <span className="product-badge product-badge-soldout">{zh ? '缺貨中' : 'Sold Out'}</span>
  } else if (isCollection && collectionExpired) {
    statusBadge = <span className="product-badge product-badge-expired">{zh ? '收單已截止' : 'Collection Ended'}</span>
  } else if (isCollection) {
    const end = new Date(sp.collection_end)
    const dateStr = end.toLocaleDateString(zh ? 'zh-TW' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    statusBadge = <span className="product-badge product-badge-collection">{zh ? `收單至 ${dateStr}` : `Until ${dateStr}`}</span>
  }

  return (
    <Link href={`/products/${sp.product_id}`} className="product-card" style={unavailable ? { opacity: 0.6 } : {}}>
      <div style={{ position: 'relative' }}>
        {thumb
          ? <img src={thumb} alt={name} className="product-img-placeholder" style={{objectFit:'cover'}} loading="lazy" />
          : <div className="product-img-placeholder">📦</div>}
        {statusBadge && (
          <div style={{ position: 'absolute', top: 8, left: 8 }}>{statusBadge}</div>
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
          <span className="product-price">NT${Number(sp.shop_price || 0).toLocaleString()}</span>
        </div>
        <div className="product-variants-hint">
          {unavailable
            ? (isSoldOut ? (zh ? '缺貨中' : 'Sold Out') : (zh ? '收單已截止' : 'Collection Ended'))
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
