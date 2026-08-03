'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useI18n, useCart } from '../../layout'
import { getActivePrice } from '../../../lib/salePrice'
import { slugifyName } from '../../../lib/slug'
import { evaluateSelection } from '../../../lib/bundleCart'
import { trackPixel } from '../../../lib/metaPixel'

// 組合商品落地頁（簡化版：一張主圖 + 一段純文字，內容區塊系統做好後再換掉）。
// 資料由 server component 以 props 帶入，這裡只負責互動。
//
// 規則（見 docs/archive/bundle-plan.md）：
//   * 逐件選規格，缺貨規格不可選；可預訂的商品即使庫存 0 仍可選（尊重各商品自己的預購設定）
//   * 某件全部售完就標「已售完」，消費者可取消勾選該件
//   * 取消勾選任何一件 → 總價即時退回其餘商品的原價加總，並明白顯示「不適用套裝價」
//   * 加入購物車時，只有整套齊全才把 bundleId 掛上去 —— 拆著買就是單純的原價商品
export default function BundleDetail({ bundle, items, missingProductIds = [], optTypes }) {
  const { lang } = useI18n()
  const { addItems } = useCart()
  const zh = lang === 'zh'
  const [added, setAdded] = useState(false)

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

  // 合計與 CTA。桌機黏在右欄、手機放商品清單下方，兩處互斥顯示（見 globals.css），
  // 所以畫面上永遠只有一個，不是重複的行動呼籲。
  const buyBox = (
    <>
      <div className="cart-total" style={{ marginTop: 4 }}>
        <div className="cart-total-row">
          <span>{zh ? '已選商品原價加總' : 'Selected at regular price'}</span>
          <span>NT${selection.originalTotal.toLocaleString()}</span>
        </div>
        {selection.applies && (
          <div className="cart-total-row" style={{ color: '#1a7a3c' }}>
            <span>{zh ? '套裝價折抵' : 'Bundle discount'}</span>
            <span>-NT${selection.discount.toLocaleString()}</span>
          </div>
        )}
        <div className="cart-total-final">
          <span>{zh ? '合計' : 'Total'}</span>
          <span>NT${selection.payable.toLocaleString()}</span>
        </div>
      </div>

      <button className="add-btn" onClick={handleAdd} disabled={!anyIncluded}>
        {added
          ? '✓ ' + (zh ? '已加入購物車' : 'Added to cart')
          : selection.applies
            ? (zh ? '整套加入購物車' : 'Add the whole set to cart')
            : anyIncluded
              ? (zh ? '將已勾選的商品加入購物車' : 'Add selected items to cart')
              : (zh ? '請至少選一件' : 'Select at least one item')}
      </button>

      {added && (
        <Link href="/cart" className="btn-primary" style={{ display: 'block', textAlign: 'center', marginTop: 10 }}>
          {zh ? '前往購物車 →' : 'Go to cart →'}
        </Link>
      )}
    </>
  )

  return (
    <>
    <div className="detail-wrap">
      {/* 情境主圖 */}
      <div>
        {bundle.hero_image_url
          ? <img src={bundle.hero_image_url} alt={bundle.name} className="detail-img" style={{ objectFit: 'cover', width: '100%' }} />
          : <div className="detail-img" aria-hidden="true" />}
      </div>

      <div>
        <div style={{ fontSize: 12, color: 'var(--text-3)', letterSpacing: '0.08em', marginBottom: 6 }}>
          {zh ? '組合商品' : 'BUNDLE'}
        </div>
        <h1 className="detail-name">{bundle.name}</h1>

        {/* 套裝價 vs 原價加總 */}
        <div className="detail-price" style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <span className={selection.applies ? 'detail-price-sale' : ''}>
            NT${Number(selection.payable).toLocaleString()}
          </span>
          {selection.applies && listPrice > selection.payable && (
            <>
              <span className="detail-price-old">NT${listPrice.toLocaleString()}</span>
              <span className="product-badge product-badge-sale">
                {zh ? `套裝價省 NT$${selection.discount.toLocaleString()}` : `Save NT$${selection.discount.toLocaleString()}`}
              </span>
            </>
          )}
        </div>

        {/* 不適用套裝價時，明白講清楚為什麼 */}
        {!selection.applies && (
          <div style={{ background: 'var(--amber-bg)', borderRadius: 12, padding: '12px 16px', marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--amber)', marginBottom: 4 }}>
              {zh ? '目前不適用套裝價' : 'Bundle price not applied'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--amber)', lineHeight: 1.7 }}>
              {missingProductIds.length > 0
                ? (zh ? '這個組合有商品已下架，暫時湊不齊整套。已勾選的商品仍可以原價購買。'
                      : 'Some items in this bundle are no longer available. Selected items can still be bought at regular price.')
                : selection.complete
                  ? (zh ? `套裝價 NT$${Number(bundle.bundle_price).toLocaleString()} 未低於目前原價加總，以原價計算。`
                        : 'The bundle price is not lower than the current total, so regular prices apply.')
                  : (zh ? `套裝價只在整套齊全時成立。目前少了 ${selection.totalCount - selection.includedCount} 件，其餘以原價購買。`
                        : `The bundle price applies only to the complete set. ${selection.totalCount - selection.includedCount} item(s) missing — the rest are at regular price.`)}
            </div>
          </div>
        )}

        {bundle.description && (
          <p className="detail-desc" style={{ whiteSpace: 'pre-wrap' }}>{bundle.description}</p>
        )}

        <div className="bundle-buy-desktop">{buyBox}</div>
      </div>
    </div>

    {/* 商品清單：全寬，不受右欄那約 456px 的限制。
        社群導購來的人要看清楚每一件長什麼樣，圖不能只有指甲蓋大。 */}
    <section className="bundle-items">
      <h2 className="bundle-items-head">
        {zh
          ? `這一套包含 ${items.length + missingProductIds.length} 件`
          : `${items.length + missingProductIds.length} items in this set`}
      </h2>
      <p className="bundle-items-sub">
        {zh
          ? '每件各自選尺寸／規格。整套齊全才適用套裝價，少拿一件就以原價計算。'
          : 'Pick a size for each item. The bundle price applies only to the complete set.'}
      </p>

      <div className="bundle-grid">
        {rows.map(r => {
          const productHref = `/products/${r.sp.products.id}/${encodeURIComponent(slugifyName(r.sp.products.name))}`
          const dim = r.unavailable || !r.included
          return (
            <article key={r.productId} className={`bundle-card${dim ? ' is-dim' : ''}`}>
              <Link href={productHref} className="bundle-card-media">
                {r.image && <img src={r.image} alt={r.name} loading="lazy" />}
                {r.unavailable
                  ? <span className="bundle-card-flag">
                      {r.collectionExpired ? (zh ? '收單已截止' : 'Closed') : (zh ? '已售完' : 'Sold out')}
                    </span>
                  : r.skipStock
                    ? <span className="bundle-card-flag">{zh ? '可預訂' : 'Pre-order'}</span>
                    : null}
              </Link>

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
                      <div className="bundle-chips">
                        {values.map(val => {
                          const isSelected = r.options[String(type.id)] === val.id
                          const soldOut = isValueSoldOut(r.variants, r.options, type.id, val.id, r.skipStock)
                          return (
                            <button
                              key={val.id}
                              className={`bundle-chip${isSelected ? ' selected' : ''}`}
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

                <div className="bundle-card-foot">
                  {r.unavailable
                    ? null
                    : (
                      <button className="bundle-toggle" onClick={() => toggle(r.productId)}>
                        {r.included
                          ? (zh ? '這件我不要' : 'Remove this item')
                          : (zh ? '加回這件' : 'Add it back')}
                      </button>
                    )}
                </div>
              </div>
            </article>
          )
        })}
      </div>

      {missingProductIds.length > 0 && (
        <p className="bundle-items-sub" style={{ marginTop: 14, marginBottom: 0 }}>
          {zh ? `另有 ${missingProductIds.length} 件已下架，無法購買。` : `${missingProductIds.length} item(s) are no longer available.`}
        </p>
      )}
    </section>

    <div className="bundle-buy-mobile">{buyBox}</div>
    </>
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
    image: images[0]?.url || null,
    name: lang === 'en' && sp.name_en ? sp.name_en : p.name,
  }
}
