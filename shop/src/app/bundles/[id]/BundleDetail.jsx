'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useI18n, useCart } from '../../layout'
import Reveal from '../../Reveal'
import { getActivePrice } from '../../../lib/salePrice'
import { slugifyName } from '../../../lib/slug'
import { evaluateSelection } from '../../../lib/bundleCart'
import { trackPixel } from '../../../lib/metaPixel'
import { useCountUp } from '../../../lib/useCountUp'
import { useBuyBar } from '../../../lib/useBuyBar'
import { repImageFor, visibleImages } from '../../../lib/variantImages'

// 組合商品落地頁。資料由 server component 以 props 帶入，這裡只負責互動。
//
// 規則（見 docs/archive/bundle-plan.md）：
//   * 逐件選規格，缺貨規格不可選；可預訂的商品即使庫存 0 仍可選（尊重各商品自己的預購設定）
//   * 某件全部售完就標「已售完」，消費者可取消勾選該件
//   * 取消勾選任何一件 → 總價即時退回其餘商品的原價加總，並明白顯示「不適用套裝價」
//   * 加入購物車時，只有整套齊全才把 bundleId 掛上去 —— 拆著買就是單純的原價商品
//
// 版面（見 globals.css「組合商品落地頁」段）：
//   主視覺與商品清單共用 --detail-max，左緣切齊；清單不塞進右欄，圖要看得清楚。
export default function BundleDetail({ bundle, items, missingProductIds = [], optTypes }) {
  const { lang } = useI18n()
  const { addItems } = useCart()
  const zh = lang === 'zh'
  const [added, setAdded] = useState(false)
  const { anchorRef, visible: barVisible } = useBuyBar()

  const [picks, setPicks] = useState(() => {
    const init = {}
    items.forEach(it => {
      const types = activeTypesFor(it.variants, optTypes)
      init[it.productId] = { included: true, options: initialOptions(it.variants, types, skipStockFor(it.sp)) }
    })
    return init
  })

  const rows = items.map(it => {
    const options = picks[it.productId]?.options || {}
    const state = resolveItem(it, optTypes, options, lang)
    // 不可購買的品項一律不算在內（也不能勾選）
    const included = !!picks[it.productId]?.included && !state.unavailable
    return { ...it, ...state, options, included }
  })

  // 下架商品雖然無從顯示，仍佔著組合的一個位置 —— 補進來讓套裝價正確地不成立
  const selection = evaluateSelection(
    [
      ...rows.map(r => ({ productId: r.productId, price: r.price, included: r.included })),
      ...missingProductIds.map(pid => ({ productId: pid, price: 0, included: false })),
    ],
    bundle.bundle_price,
  )

  const listPrice = rows.reduce((s, r) => s + r.price, 0) // 全套原價加總（含未勾選的，作為對比用）
  const anyIncluded = selection.includedCount > 0
  const totalItems = items.length + missingProductIds.length

  // 價格補間：勾／不勾造成的價差要看得出來，瞬間跳值等於沒有回饋
  const payableShown = useCountUp(selection.payable)

  function toggle(productId) {
    setPicks(p => ({ ...p, [productId]: { ...p[productId], included: !p[productId]?.included } }))
  }
  function pickOption(productId, typeId, valueId) {
    setPicks(p => ({
      ...p,
      [productId]: { ...p[productId], options: { ...p[productId]?.options, [String(typeId)]: valueId } },
    }))
  }

  function handleAdd() {
    const chosen = rows.filter(r => r.included)
    if (chosen.length === 0) return
    // 套裝價成立才掛 bundleId：拆著買本來就是原價，掛上去只會在購物車顯示無意義的「缺件」警告
    const tagged = selection.applies
    addItems(chosen.map(r => ({
      id: r.sp.products.id,
      sku: r.sp.products.sku,
      name: r.name,
      price: r.price,
      variantId: r.currentVariant?.id || null,
      variantLabel: r.variantLabel,
      customNote: '',
      qty: 1,
      image: r.image,
      isCollection: r.skipStock,
      ...(tagged ? { bundleId: bundle.id, bundleName: bundle.name } : {}),
    })))
    trackPixel('AddToCart', {
      content_ids: chosen.map(r => String(r.sp.products.id)),
      content_type: 'product',
      value: selection.payable,
      currency: 'TWD',
    })
    setAdded(true)
  }

  const ctaLabel = added
    ? '✓ ' + (zh ? '已加入購物車' : 'Added to cart')
    : selection.applies
      ? (zh ? '整套加入購物車' : 'Add the whole set')
      : anyIncluded
        ? (zh ? '將已勾選的加入購物車' : 'Add selected items')
        : (zh ? '請至少選一件' : 'Select at least one')

  // 主視覺：有情境主圖就用，沒有就拿組合內商品的實拍圖拼一張。
  // 全部是真實資料，不放佔位灰塊 —— 那是這一頁改版前最刺眼的問題。
  const collage = bundle.hero_image_url
    ? [bundle.hero_image_url]
    : rows.map(r => r.image).filter(Boolean).slice(0, 3)

  // 欄數跟著件數走，不留空格。4 件走 2×2，避免最後一列孤零零一張。
  const cols = totalItems <= 1 ? 1 : totalItems === 2 || totalItems === 4 ? 2 : 3

  return (
    <div className="has-buy-bar">
      <div className="detail-subnav">
        <div className="container" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link href="/products" className="detail-back-btn">
            ← {zh ? '所有商品' : 'All Products'}
          </Link>
          <span className="detail-subnav-divider" />
          <span className="detail-subnav-name">{bundle.name}</span>
        </div>
      </div>

      <div className="detail-wrap">
        <Reveal>
          {collage.length > 0 ? (
            <div className="bundle-collage" data-n={collage.length}>
              {collage.map((url, i) => (
                <div key={url + i} className="bundle-collage-cell">
                  <img
                    src={url}
                    alt={i === 0 ? bundle.name : ''}
                    fetchPriority={i === 0 ? 'high' : undefined}
                    loading={i === 0 ? 'eager' : 'lazy'}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="bundle-empty-hero">
              {zh ? '這個組合還沒有商品照片' : 'No photos for this set yet'}
            </div>
          )}
        </Reveal>

        <Reveal delay={80} className="bundle-buy-col">
          <div className="detail-eyebrow">{zh ? '組合商品' : 'Bundle'}</div>
          <h1 className="detail-name">{bundle.name}</h1>

          <div className="detail-price bundle-price-row">
            <span className={selection.applies ? 'detail-price-sale' : ''}>
              NT${payableShown.toLocaleString()}
            </span>
            {selection.applies && listPrice > selection.payable && (
              <>
                <span className="detail-price-old">NT${listPrice.toLocaleString()}</span>
                <span key={selection.discount} className="bundle-save value-pop">
                  {zh ? `省 NT$${selection.discount.toLocaleString()}` : `Save NT$${selection.discount.toLocaleString()}`}
                </span>
              </>
            )}
          </div>

          {bundle.description && (
            <p className="detail-desc" style={{ whiteSpace: 'pre-wrap' }}>{bundle.description}</p>
          )}

          {/* 折抵成立時給收據，不成立時給原因。兩者互斥 ——
              之前是大數字講一次、下面的卡片再講一次，同一件事佔了兩塊版面。 */}
          {selection.applies ? (
            <div className="bundle-receipt">
              <div className="bundle-receipt-row">
                <span>{zh ? `已選 ${selection.includedCount} 件原價加總` : `${selection.includedCount} items at regular price`}</span>
                <span>NT${selection.originalTotal.toLocaleString()}</span>
              </div>
              <div className="bundle-receipt-row is-discount">
                <span>{zh ? '套裝價折抵' : 'Bundle discount'}</span>
                <span>-NT${selection.discount.toLocaleString()}</span>
              </div>
              <div className="bundle-receipt-row is-total">
                <span>{zh ? '合計' : 'Total'}</span>
                <span>NT${selection.payable.toLocaleString()}</span>
              </div>
            </div>
          ) : (
            <div className="bundle-status" data-tone="warn">
              <div className="bundle-status-title">
                {zh ? '目前不適用套裝價' : 'Bundle price not applied'}
              </div>
              <div className="bundle-status-body">
                {missingProductIds.length > 0
                  ? (zh ? '這個組合有商品已下架，暫時湊不齊整套。已勾選的商品仍可以原價購買。'
                        : 'Some items in this set are no longer available. Selected items can still be bought at regular price.')
                  : selection.complete
                    ? (zh ? `套裝價 NT$${Number(bundle.bundle_price).toLocaleString()} 未低於目前原價加總，以原價計算。`
                          : 'The bundle price is not lower than the current total, so regular prices apply.')
                    : (zh ? `套裝價只在整套齊全時成立。目前少了 ${selection.totalCount - selection.includedCount} 件，其餘以原價購買。`
                          : `The bundle price applies only to the complete set. ${selection.totalCount - selection.includedCount} item(s) are missing, so the rest are at regular price.`)}
              </div>
            </div>
          )}

          <div ref={anchorRef}>
            <button className="add-btn" onClick={handleAdd} disabled={!anyIncluded}>{ctaLabel}</button>
          </div>

          {added && (
            <Link href="/cart" className="btn-primary" style={{ display: 'block', textAlign: 'center', marginTop: 10, padding: 14, borderRadius: 'var(--r-ctl)', fontWeight: 600 }}>
              {zh ? '前往購物車 →' : 'Go to cart →'}
            </Link>
          )}
        </Reveal>
      </div>

      {/* 商品清單：全寬，不受右欄那約 500px 的限制。
          社群導購來的人要看清楚每一件長什麼樣，圖不能只有指甲蓋大。 */}
      <section className="bundle-items" id="items">
        <Reveal>
          <h2 className="bundle-items-head">
            {zh ? `這一套包含 ${totalItems} 件` : `${totalItems} items in this set`}
          </h2>
          <p className="bundle-items-sub">
            {zh
              ? '每件各自選尺寸／規格。整套齊全才適用套裝價，少拿一件就以原價計算。'
              : 'Pick a size for each item. The bundle price applies only to the complete set.'}
          </p>
        </Reveal>

        <div className="bundle-grid" style={{ '--cols': cols }}>
          {rows.map((r, idx) => {
            const productHref = `/products/${r.sp.products.id}/${encodeURIComponent(slugifyName(r.sp.products.name))}`
            const off = r.unavailable || !r.included
            return (
              <Reveal
                as="article"
                key={r.productId}
                delay={idx * 70}
                className={`bundle-card${off ? ' is-off' : ''}`}
              >
                <Link href={productHref} className="bundle-card-media">
                  {/* key 綁圖片網址：換規格換圖時重新掛載，才播得出淡入 */}
                  {r.image && <img key={r.image} src={r.image} alt={r.name} loading="lazy" className="bundle-card-img" />}
                  {r.unavailable
                    ? <span className="bundle-card-flag">
                        {r.collectionExpired ? (zh ? '收單已截止' : 'Closed') : (zh ? '已售完' : 'Sold out')}
                      </span>
                    : r.skipStock
                      ? <span className="bundle-card-flag">{zh ? '可預訂' : 'Pre-order'}</span>
                      : null}
                </Link>

                {/* 包含／排除：決定套裝價成不成立的動作，放在卡片最顯眼的角落。
                    改版前這是卡片最底的一條底線文字。 */}
                {!r.unavailable && (
                  <button
                    className="bundle-check"
                    role="checkbox"
                    aria-checked={r.included}
                    aria-label={r.included
                      ? (zh ? `把「${r.name}」移出這一套` : `Remove ${r.name} from the set`)
                      : (zh ? `把「${r.name}」加回這一套` : `Add ${r.name} back to the set`)}
                    title={r.included ? (zh ? '這件我不要' : 'Remove this item') : (zh ? '加回這件' : 'Add it back')}
                    onClick={() => toggle(r.productId)}
                  >
                    {r.included ? <CheckIcon /> : <PlusIcon />}
                  </button>
                )}

                <div className="bundle-card-body">
                  <Link href={productHref} className="bundle-card-name">{r.name}</Link>

                  <div className="bundle-card-price">
                    NT${r.price.toLocaleString()}
                    {r.onSale && <s>NT${r.original.toLocaleString()}</s>}
                  </div>

                  {r.unavailable && (
                    <div className="bundle-card-warn">
                      {zh ? '這件目前買不到，不會列入結帳。' : 'This item is unavailable and will not be included.'}
                    </div>
                  )}

                  {/* 選規格是這頁的主要動作，所以放在卡片主體、不縮排、按鈕加大 */}
                  {!r.unavailable && r.activeTypes.map(type => {
                    const values = valuesFor(type, r.variants)
                    return (
                      <div key={type.id}>
                        <div className="bundle-spec-label">{type.name}</div>
                        <div className="spec-chip-row">
                          {values.map(val => {
                            const isSelected = r.options[String(type.id)] === val.id
                            const soldOut = isValueSoldOut(r.variants, r.options, type.id, val.id, r.skipStock)
                            return (
                              <button
                                key={val.id}
                                className={`spec-chip${isSelected ? ' selected' : ''}`}
                                onClick={() => !soldOut && pickOption(r.productId, type.id, val.id)}
                                disabled={soldOut}
                                aria-pressed={isSelected}
                              >{val.value}</button>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                </div>

                {/* 底列固定在卡片最後一列，規格組數不同的卡片底部才會切齊。
                    正常狀態放目前選到的規格（結帳會用的就是這一串），不是「已列入這一套」——
                    右上角的勾已經說了那件事，每張卡再寫一次只是佔位的廢話。 */}
                <div className="bundle-card-foot">
                  {r.unavailable
                    ? (zh ? '不列入這一套' : 'Not in this set')
                    : r.included
                      ? (r.variantLabel || (zh ? '無需選規格' : 'No options needed'))
                      : (zh ? '已移出，不適用套裝價' : 'Removed, bundle price no longer applies')}
                </div>
              </Reveal>
            )
          })}
        </div>

        {missingProductIds.length > 0 && (
          <p className="bundle-items-sub" style={{ marginTop: 18, marginBottom: 0 }}>
            {zh ? `另有 ${missingProductIds.length} 件已下架，無法購買。` : `${missingProductIds.length} item(s) are no longer available.`}
          </p>
        )}
      </section>

      {/* 黏底購買列：不是第二顆 CTA，是上面那顆捲走之後接手的同一顆 */}
      <div className={`buy-bar${barVisible ? ' is-on' : ''}`} aria-hidden={!barVisible}>
        <div className="buy-bar-inner">
          <div className="buy-bar-price">
            <div className="buy-bar-label">
              {selection.applies
                ? (zh ? `套裝價 · 省 NT$${selection.discount.toLocaleString()}` : `Bundle price, save NT$${selection.discount.toLocaleString()}`)
                : (zh ? `已選 ${selection.includedCount} 件` : `${selection.includedCount} selected`)}
            </div>
            <div className="buy-bar-value">NT${payableShown.toLocaleString()}</div>
          </div>
          <button className="add-btn" onClick={handleAdd} disabled={!anyIncluded} tabIndex={barVisible ? 0 : -1}>
            {ctaLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// 圖示沿用 layout.jsx 既有的做法：24 格 viewBox、stroke currentColor 的內嵌 SVG。
// 這個 repo 不裝 icon 套件（見 CLAUDE.md 的最小依賴原則），所以維持同一套慣例。
function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

// ── 以下為與商品詳情頁相同的規格／庫存判斷（同一套既有行為，不繞過預購設定）──

function skipStockFor(sp) {
  return !!(sp?.skip_stock_check || sp?.collection_end)
}

function activeTypesFor(variants, optTypes) {
  const used = new Set()
  ;(variants || []).forEach(v => Object.keys(v.options || {}).forEach(tid => used.add(Number(tid))))
  return (optTypes || []).filter(ty => used.has(ty.id))
}

function valuesFor(type, variants) {
  const ids = [...new Set((variants || []).map(v => v.options?.[String(type.id)]).filter(Boolean))]
  return ids
    .map(vid => type.variant_option_values?.find(v => v.id === vid))
    .filter(Boolean)
    .sort((a, b) => a.sort_order - b.sort_order)
}

// 在其他維度維持目前選擇的前提下，這個值還有沒有貨
function isValueSoldOut(variants, selectedOptions, typeId, valueId, skipStock) {
  if (skipStock) return false
  const matching = (variants || []).filter(v => {
    if (v.options?.[String(typeId)] !== valueId) return false
    return Object.entries(selectedOptions).every(([tid, vid]) => {
      if (Number(tid) === typeId) return true
      return v.options?.[tid] === undefined || v.options?.[tid] === vid
    })
  })
  if (matching.length === 0) return true
  return matching.every(v => v.stock <= 0)
}

// 初始選擇：每個維度挑第一個還有貨的值，全缺貨才退回第一個
function initialOptions(variants, activeTypes, skipStock) {
  const initial = {}
  activeTypes.forEach(type => {
    const values = valuesFor(type, variants)
    const avail = values.find(v => !isValueSoldOut(variants, initial, type.id, v.id, skipStock))
    const pick = avail || values[0]
    if (pick) initial[String(type.id)] = pick.id
  })
  return initial
}

function resolveItem(item, optTypes, options, lang) {
  const sp = item.sp
  const p = sp.products
  const variants = item.variants || []
  const activeTypes = activeTypesFor(variants, optTypes)

  const isCollection = !!sp.collection_end
  const collectionExpired = isCollection && new Date(sp.collection_end) < new Date()
  const skipStock = skipStockFor(sp)

  const currentVariant = variants.find(v =>
    Object.entries(options).every(([tid, vid]) => v.options?.[tid] === vid),
  )
  const stock = currentVariant?.stock ?? (variants.length === 0 ? p.quantity : 0)
  const stockSoldOut = stock <= 0 && !skipStock
  // 「所有規格都售完」才是整件售完；單一規格缺貨只是那個選項不可選
  const allSoldOut = !skipStock && (variants.length > 0
    ? variants.every(v => v.stock <= 0)
    : (p.quantity ?? 0) <= 0)
  const unavailable = sp.sold_out || collectionExpired || allSoldOut || stockSoldOut

  const regularPrice = currentVariant?.variant_price != null
    ? Number(currentVariant.variant_price)
    : Number(sp.shop_price) + (currentVariant?.price_adjustment || 0)
  const sale = getActivePrice(sp, regularPrice, currentVariant?.sale_price)

  const variantLabel = activeTypes.map(type => {
    const vid = options[String(type.id)]
    return type.variant_option_values?.find(v => v.id === vid)?.value || null
  }).filter(Boolean).join(' / ')

  const images = [...(p.product_images || [])].sort((a, b) => a.sort_order - b.sort_order)
  // 選了什麼規格就顯示對應的圖。與商品詳情頁同一支函式，行為一致。
  const shown = visibleImages(images, options)

  return {
    activeTypes,
    currentVariant,
    skipStock,
    collectionExpired,
    unavailable,
    price: sale.price,
    original: sale.original,
    onSale: sale.onSale,
    variantLabel,
    image: shown[0]?.url || null,
    images,
    name: lang === 'en' && sp.name_en ? sp.name_en : p.name,
  }
}
