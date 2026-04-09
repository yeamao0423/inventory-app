'use client'
import { useEffect, useState } from 'react'
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

  const filtered = products.filter(sp => {
    const name = (lang === 'en' && sp.name_en ? sp.name_en : sp.products?.name) || ''
    const matchSearch = name.toLowerCase().includes(search.toLowerCase()) ||
      sp.products?.sku?.toLowerCase().includes(search.toLowerCase())
    const matchCat = activeCat === null || sp.products?.categories?.id === activeCat
    const productTagIds = (sp.products?.product_tags || []).map(pt => pt.tag_id)
    const matchTag = activeTags.length === 0 || activeTags.some(tid => productTagIds.includes(tid))
    return matchSearch && matchCat && matchTag
  })

  function toggleTag(id) {
    setActiveTags(prev => prev.includes(id) ? prev.filter(t => t !== id) : [...prev, id])
  }

  return (
    <div className="section">
      <div className="container">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
          <h1 className="section-title" style={{ marginBottom: 0 }}>{t('nav.products')}</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#ebebeb', borderRadius: 10, padding: '8px 14px', minWidth: 220 }}>
            <span>🔍</span>
            <input
              style={{ border: 'none', background: 'transparent', outline: 'none', fontSize: 14, color: 'var(--text)', flex: 1 }}
              placeholder={lang === 'zh' ? '搜尋商品…' : 'Search products…'}
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>

        {/* Category filter */}
        {categories.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <button
              onClick={() => setActiveCat(null)}
              className={activeCat === null ? 'filter-pill filter-pill-active' : 'filter-pill'}
            >
              {lang === 'zh' ? '全部' : 'All'}
            </button>
            {categories.map(c => (
              <button
                key={c.id}
                onClick={() => setActiveCat(activeCat === c.id ? null : c.id)}
                className={activeCat === c.id ? 'filter-pill filter-pill-active' : 'filter-pill'}
              >
                {lang === 'en' && c.name_en ? c.name_en : c.name}
              </button>
            ))}
          </div>
        )}

        {/* Tag filter */}
        {tags.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 24 }}>
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

        {loading ? (
          <div style={{ color: 'var(--text-3)', textAlign: 'center', padding: '60px 0' }}>{t('common.loading')}</div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-3)' }}>
            {lang === 'zh' ? '找不到商品' : 'No products found'}
          </div>
        ) : (
          <div className="product-grid">
            {filtered.map(sp => <ProductCard key={sp.id} sp={sp} t={t} lang={lang} />)}
          </div>
        )}
      </div>
    </div>
  )
}

function ProductCard({ sp, t, lang }) {
  const p = sp.products
  if (!p) return null
  const name = lang === 'en' && sp.name_en ? sp.name_en : p.name
  const desc = lang === 'en' ? sp.desc_en : sp.desc_zh
  const thumb = [...(p.product_images || [])].sort((a, b) => a.sort_order - b.sort_order)[0]?.url

  return (
    <Link href={`/products/${p.sku}`} className="product-card">
      {thumb
        ? <img src={thumb} alt={name} className="product-img-placeholder" style={{objectFit:'cover'}} />
        : <div className="product-img-placeholder">📦</div>}
      <div className="product-info">
        <div className="product-name">{name}</div>
        {desc && <div className="product-desc">{desc}</div>}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span className="product-price">NT${Number(sp.shop_price || 0).toLocaleString()}</span>
        </div>
        <div className="product-variants-hint">
          {lang === 'zh' ? '點擊選擇規格' : 'Click to select variant'}
        </div>
      </div>
    </Link>
  )
}
