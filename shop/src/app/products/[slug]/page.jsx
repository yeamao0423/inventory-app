'use client'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '../../../lib/supabase'
import { useI18n } from '../../layout'
import { useCart } from '../../layout'

export default function ProductDetailPage() {
  const { slug } = useParams()
  const { t, lang } = useI18n()
  const { addItem } = useCart()
  const [sp, setSp] = useState(null)
  const [variants, setVariants] = useState([])
  const [activeTypes, setActiveTypes] = useState([])  // option types used by this product
  const [selectedOptions, setSelectedOptions] = useState({}) // { typeId_str: valueId_num }
  const [customOptions, setCustomOptions] = useState([])
  const [customNote, setCustomNote] = useState('')
  const [qty, setQty] = useState(1)
  const [loading, setLoading] = useState(true)
  const [added, setAdded] = useState(false)

  useEffect(() => {
    async function load() {
      const { data: spData } = await supabase
        .from('storefront_products')
        .select('*, products!inner(*, product_images(id, url, sort_order))')
        .eq('products.sku', slug)
        .single()

      if (!spData) { setLoading(false); return }
      setSp(spData)

      const [{ data: varData }, { data: optData }, { data: optTypes }] = await Promise.all([
        supabase.from('product_variants').select('*').eq('product_id', spData.product_id),
        supabase.from('custom_options').select('*').eq('product_id', spData.product_id),
        supabase.from('variant_option_types')
          .select('*, variant_option_values(id, value, sort_order)')
          .order('sort_order'),
      ])

      const vars = varData || []
      const types = optTypes || []
      setVariants(vars)
      setCustomOptions(optData || [])

      // Determine which option types are used by this product's variants
      const usedTypeIds = new Set()
      vars.forEach(v => Object.keys(v.options || {}).forEach(tid => usedTypeIds.add(Number(tid))))
      const active = types.filter(t => usedTypeIds.has(t.id))
      setActiveTypes(active)

      // Set initial selections (first available value per type)
      const initial = {}
      active.forEach(type => {
        const valueIds = [...new Set(vars.map(v => v.options?.[String(type.id)]).filter(Boolean))]
        if (valueIds.length) initial[String(type.id)] = valueIds[0]
      })
      setSelectedOptions(initial)

      setLoading(false)
    }
    load()
  }, [slug])

  if (loading) return <div style={{ textAlign: 'center', padding: 80, color: 'var(--text-3)' }}>{t('common.loading')}</div>
  if (!sp) return <div style={{ textAlign: 'center', padding: 80, color: 'var(--text-3)' }}>{t('common.error')}</div>

  const p = sp.products
  const name = lang === 'en' && sp.name_en ? sp.name_en : p.name
  const desc = lang === 'en' ? sp.desc_en : sp.desc_zh
  const sortedImages = [...(p.product_images || [])].sort((a, b) => a.sort_order - b.sort_order)
  const zh = lang === 'zh'

  // Collection / sold_out status
  const isCollection = !!sp.collection_end
  const collectionExpired = isCollection && new Date(sp.collection_end) < new Date()
  const markedSoldOut = sp.sold_out

  // Find current variant based on selected options
  const currentVariant = variants.find(v =>
    Object.entries(selectedOptions).every(([tid, vid]) => v.options?.[tid] === vid)
  )
  const stock = currentVariant?.stock ?? (variants.length === 0 ? p.quantity : 0)
  const stockSoldOut = stock <= 0 && !isCollection // only check stock for non-collection items
  const isSoldOut = markedSoldOut || stockSoldOut
  const isUnavailable = isSoldOut || collectionExpired
  const price = sp.shop_price + (currentVariant?.price_adjustment || 0)

  // Human-readable label for cart
  const variantLabel = activeTypes.map(type => {
    const vid = selectedOptions[String(type.id)]
    const val = type.variant_option_values?.find(v => v.id === vid)
    return val ? val.value : null
  }).filter(Boolean).join(' / ')

  // Check if a value is sold out given current selections for other types
  function isValueSoldOut(typeId, valueId) {
    const matching = variants.filter(v => {
      if (v.options?.[String(typeId)] !== valueId) return false
      return Object.entries(selectedOptions).every(([tid, vid]) => {
        if (Number(tid) === typeId) return true
        return v.options?.[tid] === undefined || v.options?.[tid] === vid
      })
    })
    if (matching.length === 0) return true
    return matching.every(v => v.stock <= 0)
  }

  function handleAddToCart() {
    if (isUnavailable) return
    addItem({
      id: p.id,
      sku: p.sku,
      name,
      price,
      variantLabel,
      customNote,
      qty,
      image: null,
    })
    setAdded(true)
    setTimeout(() => setAdded(false), 2000)
  }

  return (
    <div style={{ minHeight: '70vh' }}>
      <div className="container" style={{ paddingTop: 24 }}>
        <Link href="/products" className="back-link">← {t('product.back')}</Link>
      </div>

      <div className="detail-wrap">
        {/* Image gallery */}
        <div>
          <ImageGallery images={sortedImages} name={name} />
        </div>

        {/* Info */}
        <div>
          <h1 className="detail-name">{name}</h1>
          <div className="detail-price">NT${Number(price).toLocaleString()}</div>
          {desc && <p className="detail-desc">{desc}</p>}

          {/* Dynamic option selectors */}
          {activeTypes.map(type => {
            const valueIds = [...new Set(variants.map(v => v.options?.[String(type.id)]).filter(Boolean))]
            const values = valueIds
              .map(vid => type.variant_option_values?.find(v => v.id === vid))
              .filter(Boolean)
              .sort((a, b) => a.sort_order - b.sort_order)
            const selectedVid = selectedOptions[String(type.id)]
            const selectedVal = type.variant_option_values?.find(v => v.id === selectedVid)

            return (
              <div className="spec-group" key={type.id}>
                <div className="spec-label">
                  {type.name}{selectedVal ? <>: <strong>{selectedVal.value}</strong></> : ''}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                  {values.map(val => {
                    const isSelected = selectedOptions[String(type.id)] === val.id
                    const soldOut = isValueSoldOut(type.id, val.id)
                    return (
                      <button
                        key={val.id}
                        onClick={() => !soldOut && setSelectedOptions(s => ({ ...s, [String(type.id)]: val.id }))}
                        style={{
                          fontSize: 13, padding: '4px 12px', borderRadius: 20,
                          background: isSelected ? 'var(--text)' : 'transparent',
                          color: isSelected ? '#fff' : soldOut ? 'var(--text-3)' : 'var(--text-2)',
                          border: '0.5px solid var(--border)',
                          cursor: soldOut ? 'default' : 'pointer',
                          textDecoration: soldOut ? 'line-through' : 'none',
                          transition: 'all .15s',
                          opacity: soldOut ? 0.5 : 1,
                        }}
                      >{val.value}</button>
                    )
                  })}
                </div>
              </div>
            )
          })}

          {/* Collection notice */}
          {isCollection && !collectionExpired && !markedSoldOut && (
            <div style={{ background: 'var(--amber-bg)', borderRadius: 12, padding: '12px 16px', marginBottom: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--amber)', marginBottom: 4 }}>
                {zh ? '限時收單商品' : 'Limited-Time Collection'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--amber)' }}>
                {zh ? '收單截止：' : 'Deadline: '}
                {new Date(sp.collection_end).toLocaleString(zh ? 'zh-TW' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          )}

          {collectionExpired && !markedSoldOut && (
            <div style={{ background: 'var(--border-light)', borderRadius: 12, padding: '12px 16px', marginBottom: 8 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-3)' }}>
                {zh ? '收單已截止' : 'Collection period has ended'}
              </div>
            </div>
          )}

          {markedSoldOut && (
            <div style={{ background: 'var(--red-bg)', borderRadius: 12, padding: '12px 16px', marginBottom: 8 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--red)' }}>
                {zh ? '缺貨中' : 'Out of Stock'}
              </div>
            </div>
          )}

          {/* Qty */}
          <div className="spec-group">
            <div className="spec-label">{t('product.qty')}</div>
            <div className="qty-wrap">
              <button className="qty-btn" onClick={() => setQty(q => Math.max(1, q - 1))} disabled={isUnavailable}>−</button>
              <span className="qty-num">{qty}</span>
              <button className="qty-btn" onClick={() => setQty(q => isCollection ? q + 1 : Math.min(stock, q + 1))} disabled={isUnavailable}>+</button>
              {!isCollection && (
                <span style={{ fontSize: 13, color: 'var(--text-3)' }}>
                  {isSoldOut
                    ? <span style={{ color: 'var(--red)' }}>{t('product.sold_out')}</span>
                    : <span style={{ color: 'var(--green)' }}>{t('product.in_stock')} ({stock})</span>
                  }
                </span>
              )}
            </div>
          </div>

          {/* Custom options */}
          {customOptions.length > 0 && customOptions.map(opt => (
            <div className="spec-group" key={opt.id}>
              <div className="spec-label">{opt.label}{opt.required && ' *'}</div>
              <textarea
                className="custom-textarea"
                placeholder={opt.placeholder || t('product.custom_placeholder')}
                value={customNote}
                onChange={e => setCustomNote(e.target.value)}
              />
            </div>
          ))}

          {customOptions.length === 0 && (
            <div className="spec-group">
              <div className="spec-label">{t('product.custom_note')}</div>
              <textarea
                className="custom-textarea"
                placeholder={t('product.custom_placeholder')}
                value={customNote}
                onChange={e => setCustomNote(e.target.value)}
              />
            </div>
          )}

          <button
            className="add-btn"
            onClick={handleAddToCart}
            disabled={isUnavailable}
          >
            {added
              ? '✓ ' + (zh ? '已加入' : 'Added!')
              : markedSoldOut
                ? (zh ? '缺貨中' : 'Out of Stock')
                : collectionExpired
                  ? (zh ? '收單已截止' : 'Collection Ended')
                  : stockSoldOut
                    ? t('product.sold_out')
                    : t('product.add_to_cart')
            }
          </button>
        </div>
      </div>
    </div>
  )
}

function ImageGallery({ images, name }) {
  const [current, setCurrent] = useState(0)

  if (images.length === 0) return <div className="detail-img">📦</div>

  return (
    <div>
      <div style={{ position: 'relative' }}>
        <img
          src={images[current].url}
          alt={name}
          className="detail-img"
          style={{ objectFit: 'cover', width: '100%' }}
        />
        {images.length > 1 && (
          <>
            <button
              onClick={() => setCurrent(i => (i - 1 + images.length) % images.length)}
              style={arrowBtn('left')}
            >‹</button>
            <button
              onClick={() => setCurrent(i => (i + 1) % images.length)}
              style={arrowBtn('right')}
            >›</button>
            <div style={{ position: 'absolute', bottom: 10, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 6 }}>
              {images.map((_, i) => (
                <div key={i} onClick={() => setCurrent(i)} style={{
                  width: 7, height: 7, borderRadius: '50%', cursor: 'pointer',
                  background: i === current ? '#fff' : 'rgba(255,255,255,0.5)',
                }} />
              ))}
            </div>
          </>
        )}
      </div>

      {images.length > 1 && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10, overflowX: 'auto', paddingBottom: 4 }}>
          {images.map((img, i) => (
            <img
              key={img.id ?? i}
              src={img.url}
              alt=""
              onClick={() => setCurrent(i)}
              style={{
                width: 60, height: 60, objectFit: 'cover', borderRadius: 8,
                flexShrink: 0, cursor: 'pointer',
                outline: i === current ? '2px solid var(--text)' : 'none',
                opacity: i === current ? 1 : 0.6,
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function arrowBtn(side) {
  return {
    position: 'absolute', top: '50%', transform: 'translateY(-50%)',
    [side]: 10, background: 'rgba(0,0,0,0.35)', color: '#fff',
    border: 'none', borderRadius: '50%', width: 36, height: 36,
    fontSize: 22, cursor: 'pointer', display: 'flex',
    alignItems: 'center', justifyContent: 'center', lineHeight: 1,
  }
}
