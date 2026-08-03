'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useI18n } from '../../layout'
import { useCart } from '../../layout'
import Reveal from '../../Reveal'
import { getActivePrice } from '../../../lib/salePrice'
import { trackPixel } from '../../../lib/metaPixel'
import { useBuyBar } from '../../../lib/useBuyBar'

// 資料由 server component（page.jsx）以 props 帶入，這裡只負責互動。
export default function ProductDetail({ sp, variants, customOptions, optTypes, productTags }) {
  const { t, lang } = useI18n()
  const { addItem } = useCart()
  const [customNote, setCustomNote] = useState('')
  const [qty, setQty] = useState(1)
  const [added, setAdded] = useState(false)
  // 黏底購買列：主視覺裡的 CTA 捲走之後接手同一顆按鈕（見 lib/useBuyBar.js）
  const { anchorRef, visible: barVisible } = useBuyBar()

  // 哪些規格類型被這個商品的 variants 使用（由 props 推導，server/client 結果一致）
  const usedTypeIds = new Set()
  variants.forEach(v => Object.keys(v.options || {}).forEach(tid => usedTypeIds.add(Number(tid))))
  const activeTypes = optTypes.filter(ty => usedTypeIds.has(ty.id))

  // 初始選擇：每個類型的第一個可用值
  const [selectedOptions, setSelectedOptions] = useState(() => {
    const initial = {}
    activeTypes.forEach(type => {
      const valueIds = [...new Set(variants.map(v => v.options?.[String(type.id)]).filter(Boolean))]
      if (valueIds.length) initial[String(type.id)] = valueIds[0]
    })
    return initial
  })

  const p = sp.products
  const name = lang === 'en' && sp.name_en ? sp.name_en : p.name
  const desc = lang === 'en' ? sp.desc_en : sp.desc_zh
  const sortedImages = [...(p.product_images || [])].sort((a, b) => a.sort_order - b.sort_order)
  const zh = lang === 'zh'

  // 依目前選到的規格過濾 gallery；若過濾後為空（該規格無專屬圖且無共用圖）則退回全部，避免開天窗
  const matched = sortedImages.filter(img => imageMatches(img, selectedOptions))
  const visibleImages = matched.length ? matched : sortedImages

  // Meta Pixel：瀏覽商品事件（每次進入詳情頁發一次）
  useEffect(() => {
    trackPixel('ViewContent', {
      content_ids: [String(p.id)],
      content_name: p.name,
      content_type: 'product',
      value: sp.shop_price,
      currency: 'TWD',
    })
  }, [p.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Collection / sold_out status
  const isCollection = !!sp.collection_end
  const collectionExpired = isCollection && new Date(sp.collection_end) < new Date()
  const markedSoldOut = sp.sold_out
  const skipStock = sp.skip_stock_check || isCollection

  // Find current variant based on selected options
  const currentVariant = variants.find(v =>
    Object.entries(selectedOptions).every(([tid, vid]) => v.options?.[tid] === vid)
  )
  const stock = currentVariant?.stock ?? (variants.length === 0 ? p.quantity : 0)
  const stockSoldOut = stock <= 0 && !skipStock
  const isSoldOut = markedSoldOut || stockSoldOut
  const isUnavailable = isSoldOut || collectionExpired
  const regularPrice = currentVariant?.variant_price != null ? Number(currentVariant.variant_price) : sp.shop_price + (currentVariant?.price_adjustment || 0)
  const sale = getActivePrice(sp, regularPrice, currentVariant?.sale_price)
  const price = sale.price

  // Human-readable label for cart
  const variantLabel = activeTypes.map(type => {
    const vid = selectedOptions[String(type.id)]
    const val = type.variant_option_values?.find(v => v.id === vid)
    return val ? val.value : null
  }).filter(Boolean).join(' / ')

  // Check if a value is sold out given current selections for other types
  function isValueSoldOut(typeId, valueId) {
    if (skipStock) return false
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
    // 即時再檢查一次收單是否已截止
    if (sp.collection_end && new Date(sp.collection_end) < new Date()) {
      alert(lang === 'zh' ? '收單已截止，無法加入購物車' : 'Collection period has ended')
      return
    }
    if (isUnavailable) return
    addItem({
      id: p.id,
      sku: p.sku,
      name,
      price,
      variantId: currentVariant?.id || null,
      variantLabel,
      customNote,
      qty,
      image: sortedImages[0]?.url || null,
      isCollection: skipStock,
    })
    setAdded(true)
    setTimeout(() => setAdded(false), 2000)
  }

  // 主視覺與黏底列共用同一顆按鈕的文案，避免兩處各寫一份而慢慢走鐘
  const ctaLabel = added
    ? '✓ ' + (zh ? '已加入' : 'Added!')
    : markedSoldOut
      ? (zh ? '缺貨中' : 'Out of Stock')
      : collectionExpired
        ? (zh ? '收單已截止' : 'Collection Ended')
        : stockSoldOut
          ? t('product.sold_out')
          : t('product.add_to_cart')

  return (
    <div className="has-buy-bar" style={{ minHeight: '70vh' }}>
      {/* Sticky sub-nav */}
      <div className="detail-subnav">
        <div className="container" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link href="/products" className="detail-back-btn">
            ← {zh ? '所有商品' : 'All Products'}
          </Link>
          <span className="detail-subnav-divider" />
          <span className="detail-subnav-name">{name}</span>
        </div>
      </div>

      <div className="detail-wrap">
        {/* Image gallery（規格切換時 remount，current 歸 0，不會停在已消失的圖）*/}
        <Reveal>
          <ImageGallery key={visibleImages.map(i => i.id).join('-')} images={visibleImages} name={name} />
        </Reveal>

        {/* Info */}
        <Reveal delay={80}>
          <h1 className="detail-name">{name}</h1>
          {productTags.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
              {productTags.map(tg => (
                <span key={tg.id} className="product-tag" style={{ fontSize: 12, padding: '3px 10px' }}>
                  {lang === 'en' && tg.name_en ? tg.name_en : tg.name}
                </span>
              ))}
            </div>
          )}
          {sale.onSale ? (
            <div className="detail-price" style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <span className="detail-price-sale">NT${Number(sale.price).toLocaleString()}</span>
              <span className="detail-price-old">NT${Number(sale.original).toLocaleString()}</span>
              <span className="product-badge product-badge-sale">{zh ? '特價' : 'Sale'}</span>
            </div>
          ) : (
            <div className="detail-price">NT${Number(price).toLocaleString()}</div>
          )}
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
                {/* 規格 chip 與組合商品頁共用 .spec-chip：兩頁的同一個動作要長得一樣。
                    樣式從行內搬到 CSS，hover／active／disabled 才有完整狀態。 */}
                <div className="spec-chip-row" style={{ marginTop: 8 }}>
                  {values.map(val => {
                    const isSelected = selectedOptions[String(type.id)] === val.id
                    const soldOut = isValueSoldOut(type.id, val.id)
                    const rep = repImageFor(sortedImages, type.id, val.id)
                    const onPick = () => !soldOut && setSelectedOptions(s => ({ ...s, [String(type.id)]: val.id }))
                    // 有代表圖 → 圖片 chip（點了選此值，與 gallery 過濾互補）；沒有 → 文字 chip
                    return (
                      <button
                        key={val.id}
                        className={`spec-chip${isSelected ? ' selected' : ''}`}
                        onClick={onPick}
                        disabled={soldOut}
                        aria-pressed={isSelected}
                        title={val.value}
                      >
                        {rep && <img className="spec-chip-img" src={rep.url} alt="" />}
                        {val.value}
                      </button>
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
              <button className="qty-btn" onClick={() => setQty(q => skipStock ? q + 1 : Math.min(stock, q + 1))} disabled={isUnavailable}>+</button>
              {!skipStock && (
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

          <div ref={anchorRef}>
            <button className="add-btn" onClick={handleAddToCart} disabled={isUnavailable}>
              {ctaLabel}
            </button>
          </div>
        </Reveal>
      </div>

      {/* 黏底購買列：不是第二顆 CTA，是上面那顆捲走之後接手的同一顆 */}
      <div className={`buy-bar${barVisible ? ' is-on' : ''}`} aria-hidden={!barVisible}>
        <div className="buy-bar-inner">
          <div className="buy-bar-price">
            <div className="buy-bar-label">
              {[variantLabel || name, qty > 1 ? `× ${qty}` : null].filter(Boolean).join('  ')}
            </div>
            <div className="buy-bar-value">NT${Number(price * qty).toLocaleString()}</div>
          </div>
          <button className="add-btn" onClick={handleAddToCart} disabled={isUnavailable} tabIndex={barVisible ? 0 : -1}>
            {ctaLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// 規格對應圖片：tag_filter={"<typeId>":[valueId,...]}；null=共用圖。
// 規則：每個有設限的維度，目前選到的值要落在允許清單內才顯示。
function imageMatches(img, selectedOptions) {
  const tf = img.tag_filter
  if (!tf) return true
  return Object.entries(tf).every(([typeId, vals]) => {
    if (!Array.isArray(vals) || vals.length === 0) return true
    const sel = selectedOptions[typeId]
    return sel == null || vals.map(Number).includes(Number(sel))
  })
}

// 某規格值的代表圖：images 已依 sort_order 排序，取第一張綁到該值的圖
function repImageFor(images, typeId, valueId) {
  return images.find(img => {
    const allowed = img.tag_filter?.[String(typeId)]
    return Array.isArray(allowed) && allowed.map(Number).includes(Number(valueId))
  }) || null
}

function ImageGallery({ images, name }) {
  const [current, setCurrent] = useState(0)

  if (images.length === 0) {
    return <div className="bundle-empty-hero">{name ? '這件商品還沒有照片' : ''}</div>
  }

  return (
    <div>
      <div className="gallery-main">
        {/* 首圖是這一頁的 LCP，明講優先度讓瀏覽器先抓它 */}
        <img
          src={images[current].url}
          alt={name}
          className="detail-img"
          fetchPriority="high"
        />
        {images.length > 1 && (
          <>
            <button
              className="gallery-arrow prev"
              aria-label="上一張"
              onClick={() => setCurrent(i => (i - 1 + images.length) % images.length)}
            >‹</button>
            <button
              className="gallery-arrow next"
              aria-label="下一張"
              onClick={() => setCurrent(i => (i + 1) % images.length)}
            >›</button>
          </>
        )}
        {/* 沒有底部圓點：下方的縮圖列已經把「共幾張、現在第幾張」講完了，
            圓點只是同一件事的第二種說法，而且壓在亮色照片上根本看不見。 */}
      </div>

      {images.length > 1 && (
        <div className="gallery-thumbs">
          {images.map((img, i) => (
            <button
              key={img.id ?? i}
              className={`gallery-thumb${i === current ? ' active' : ''}`}
              aria-label={`切換到第 ${i + 1} 張`}
              onClick={() => setCurrent(i)}
            >
              <img src={img.url} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
