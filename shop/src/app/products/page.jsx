'use client'
import { useEffect, useState, useRef } from 'react'
import Link from 'next/link'
import { supabase } from '../../lib/supabase'
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

  useEffect(() => {
    Promise.all([
      supabase
        .from('storefront_products')
        .select('*, products(*, product_images(url, sort_order), categories(id, name, name_en), product_tags(tag_id))')
        .eq('published', true)
        .order('created_at', { ascending: false }),
      supabase.from('categories').select('*').order('sort_order').order('name'),
      supabase.from('tags').select('*').order('sort_order').order('name'),
    ]).then(([{ data: sp }, { data: cats }, { data: tgs }]) => {
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
    return matchSearch && matchCat && matchTag && matchSource
  })

  function toggleTag(id) {
    setActiveTags(prev => prev.includes(id) ? prev.filter(t => t !== id) : [...prev, id])
  }

  return (
    <div className="section">
      <div className="container">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h1 className="section-title" style={{ marginBottom: 0 }}>{t('nav.products')}</h1>
          <button
            className="filter-toggle-btn"
            onClick={() => setFilterOpen(v => !v)}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="4" y1="6" x2="20" y2="6" /><line x1="8" y1="12" x2="20" y2="12" /><line x1="12" y1="18" x2="20" y2="18" />
              <circle cx="6" cy="12" r="1.5" fill="currentColor" /><circle cx="10" cy="18" r="1.5" fill="currentColor" />
            </svg>
            {lang === 'zh' ? '篩選' : 'Filter'}
            {(activeCat || activeSource || activeTags.length > 0 || search) && (
              <span className="filter-toggle-dot" />
            )}
          </button>
        </div>

        {/* Collapsible filter bar */}
        {filterOpen && (
          <div className="filter-bar">
            {/* Search */}
            <div className="filter-search">
              <span style={{ color: 'var(--text-3)', fontSize: 15, flexShrink: 0 }}>🔍</span>
              <input
                style={{ border: 'none', background: 'transparent', outline: 'none', fontSize: 15, color: 'var(--text)', flex: 1, minWidth: 0 }}
                placeholder={lang === 'zh' ? '搜尋商品…' : 'Search…'}
                value={search}
                onChange={e => setSearch(e.target.value)}
                autoFocus
              />
              {search && (
                <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', fontSize: 16, color: 'var(--text-3)', cursor: 'pointer', padding: 0 }}>×</button>
              )}
            </div>

            {/* Dropdowns row */}
            <div className="filter-dropdowns">
              {categories.length > 0 && (
                <FilterDropdown
                  label={lang === 'zh' ? '所有分類' : 'All Categories'}
                  value={activeCat}
                  options={categories.map(c => ({
                    value: c.id,
                    label: lang === 'en' && c.name_en ? c.name_en : c.name,
                  }))}
                  onChange={setActiveCat}
                />
              )}
              {sources.length > 0 && (
                <FilterDropdown
                  label={lang === 'zh' ? '所有品牌' : 'All Brands'}
                  value={activeSource}
                  options={sources.map(src => ({ value: src, label: src }))}
                  onChange={setActiveSource}
                />
              )}
            </div>

            {/* Tags */}
            {tags.length > 0 && (
              <div className="filter-tags-row">
                {tags.map(tg => (
                  <button
                    key={tg.id}
                    onClick={() => toggleTag(tg.id)}
                    className={activeTags.includes(tg.id) ? 'filter-tag filter-tag-active' : 'filter-tag'}
                  >
                    {lang === 'en' && tg.name_en ? tg.name_en : tg.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Active filter summary */}
        {(activeCat || activeSource || activeTags.length > 0) && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{lang === 'zh' ? '篩選中：' : 'Filtered:'}</span>
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
              onClick={() => { setActiveCat(null); setActiveSource(null); setActiveTags([]) }}
              style={{ fontSize: 12, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px' }}
            >
              {lang === 'zh' ? '清除全部' : 'Clear all'}
            </button>
          </div>
        )}

        {loading ? (
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
            {lang === 'zh' ? '找不到商品' : 'No products found'}
          </div>
        ) : (
          <div className="product-grid">
            {filtered.map(sp => <ProductCard key={sp.id} sp={sp} t={t} lang={lang} allTags={tags} />)}
          </div>
        )}
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
    <Link href={`/products/${p.sku}`} className="product-card" style={unavailable ? { opacity: 0.6 } : {}}>
      <div style={{ position: 'relative' }}>
        {thumb
          ? <img src={thumb} alt={name} className="product-img-placeholder" style={{objectFit:'cover'}} />
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

function FilterDropdown({ label, value, options, onChange }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    if (open) document.addEventListener('pointerdown', handleClick)
    return () => document.removeEventListener('pointerdown', handleClick)
  }, [open])

  const selected = options.find(o => o.value === value)

  return (
    <div className="custom-dropdown" ref={ref}>
      <button className="custom-dropdown-btn" onClick={() => setOpen(v => !v)}>
        <span className={selected ? 'custom-dropdown-selected' : ''}>{selected ? selected.label : label}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ flexShrink: 0, transition: 'transform .2s', transform: open ? 'rotate(180deg)' : '' }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="custom-dropdown-menu">
          <div
            className={`custom-dropdown-item ${!value ? 'active' : ''}`}
            onClick={() => { onChange(null); setOpen(false) }}
          >
            {label}
          </div>
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
