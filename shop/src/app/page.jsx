'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '../lib/supabase'
import { useI18n } from './layout'

export default function HomePage() {
  const { t } = useI18n()
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase
      .from('storefront_products')
      .select('*, products(*, product_images(url, sort_order))')
      .eq('published', true)
      .limit(8)
      .then(({ data }) => {
        setProducts(data || [])
        setLoading(false)
      })
  }, [])

  return (
    <>
      {/* Hero */}
      <section className="hero">
        <div className="container">
          <h1 className="hero-title">{t('home.hero_title')}</h1>
          <p className="hero-sub">{t('home.hero_sub')}</p>
          <Link href="/products" className="hero-btn">{t('home.shop_now')} →</Link>
        </div>
      </section>

      {/* Featured */}
      <section className="section">
        <div className="container">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 32 }}>
            <h2 className="section-title" style={{ marginBottom: 0 }}>{t('home.featured')}</h2>
            <Link href="/products" style={{ fontSize: 14, color: 'var(--text-3)', borderBottom: '1px solid var(--border)' }}>
              {t('home.all_products')} →
            </Link>
          </div>

          {loading ? (
            <div style={{ color: 'var(--text-3)', textAlign: 'center', padding: '60px 0' }}>{t('common.loading')}</div>
          ) : products.length === 0 ? (
            <PlaceholderGrid />
          ) : (
            <div className="product-grid">
              {products.map(sp => <ProductCard key={sp.id} sp={sp} t={t} />)}
            </div>
          )}
        </div>
      </section>
    </>
  )
}

function ProductCard({ sp, t }) {
  const { lang } = useI18n()
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
        <div>
          <span className="product-price">NT${Number(sp.shop_price || 0).toLocaleString()}</span>
        </div>
        <div className="product-variants-hint">
          {lang === 'zh' ? '多種規格可選' : 'Multiple variants'}
        </div>
      </div>
    </Link>
  )
}

function PlaceholderGrid() {
  const demos = [
    { name: '示範商品 A', price: 1200, emoji: '👕' },
    { name: '示範商品 B', price: 850, emoji: '👜' },
    { name: '示範商品 C', price: 2400, emoji: '👟' },
    { name: '示範商品 D', price: 680, emoji: '🧢' },
  ]
  return (
    <div className="product-grid">
      {demos.map((d, i) => (
        <div key={i} className="product-card" style={{ opacity: 0.6 }}>
          <div className="product-img-placeholder">{d.emoji}</div>
          <div className="product-info">
            <div className="product-name">{d.name}</div>
            <div className="product-desc">請在後台新增商品後上架至商城</div>
            <div className="product-price">NT${d.price.toLocaleString()}</div>
          </div>
        </div>
      ))}
    </div>
  )
}
