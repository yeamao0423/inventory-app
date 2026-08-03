'use client'
// 店主編排過的商品頁。沒編排過的店走的是隔壁的 ProductDetail（原封不動的內建版型），
// 這支只有 resolveProductContent 拿得到內容時才會被畫出來 —— 那個分流是整個功能的安全閥。
//
// 版面規則只有三條：
//   1. 麵包屑固定在最上方，不進區塊系統。它是導覽而不是內容，讓店主把它排到頁面中間
//      只會做出一個沒有人回得去的商品頁。
//   2. 區塊照順序流進十二欄格線（.blk-grid），每塊吃 span 欄；900px 以下一律 12 欄。
//   3. 黏底購買列畫在區塊樹外，它不是第二顆 CTA，是 product_cta 捲走之後接手的同一顆。
//      anchorRef 因此掛在 product_cta 上，而不是掛在某個固定位置。
//
// 靜態區塊（hero / media_text / text / products）交給既有的 BlocksView，不另寫一份 ——
// 兩份渲染器遲早漂移，首頁與商品頁的同一個區塊看起來就會不一樣。
import Link from 'next/link'
import ProductStateProvider, { useProductState } from './ProductStateProvider'
import { PRODUCT_RENDERERS } from './blocks'
import BlocksView from '../../blocks/BlocksView'
import { useBuyBar } from '../../../lib/useBuyBar'
import './product-blocks.css'

/**
 * @param blocks           已正規化的區塊陣列（呼叫端負責 resolveProductContent）
 * @param productsByBlock  { [blockId]: storefront_products[] } —— 商品精選區塊要顯示的商品
 * @param editing          後台預覽的編輯模式：攔截連結與按鈕、回報點到哪一塊
 * @param selectedId       目前選中的 blockId（畫外框）
 * @param highlightId      後台滑鼠正移過的 blockId（畫較淡的外框）
 * @param onSelectBlock    編輯模式下點到區塊時呼叫，簽名 (blockId | null) => void
 */
export default function ProductPageView({
  sp, variants, customOptions, optTypes, productTags,
  blocks, productsByBlock = {},
  editing = false, selectedId = null, highlightId = null, onSelectBlock,
}) {
  return (
    <ProductStateProvider
      sp={sp}
      variants={variants}
      customOptions={customOptions}
      optTypes={optTypes}
      productTags={productTags}
    >
      <PageBody
        blocks={blocks}
        productsByBlock={productsByBlock}
        editing={editing}
        selectedId={selectedId}
        highlightId={highlightId}
        onSelectBlock={onSelectBlock}
      />
    </ProductStateProvider>
  )
}

// 版面本體拆出來只為了能用 useProductState（Provider 的值在同一個元件裡讀不到）
function PageBody({ blocks, productsByBlock, editing, selectedId, highlightId, onSelectBlock }) {
  const { name, zh, price, qty, variantLabel, ctaLabel, isUnavailable, addToCart } = useProductState()
  // 傳區塊組成當 key：預覽裡店主一搬動區塊，product_cta 就是另一個 DOM 節點了，
  // observer 得重掛才不會盯著一個已經被移掉的節點看（正式站版面固定，這個值不會變）。
  const { anchorRef, visible: barVisible } = useBuyBar(blocks.map(b => b.id).join(','))

  // 編輯模式的委派 listener：整頁只掛這一個，而不是每個區塊各掛一個。
  // 區塊數量會隨店主編排長到幾十個，每塊一個 listener 等於每次重排都重掛幾十次。
  //
  // 用 capture 而不是 bubble：要在事件走到按鈕自己的 onClick 之前就攔下來。
  // 沒攔的話，店主在預覽裡點「加入購物車」會真的把東西加進他自己的購物車。
  function onClickCapture(e) {
    if (!editing) return
    e.preventDefault()
    e.stopPropagation()
    const hit = e.target?.closest?.('[data-block-id]')
    onSelectBlock?.(hit?.getAttribute('data-block-id') ?? null)
  }

  return (
    <div
      className={`pp-page has-buy-bar${editing ? ' pp-editing' : ''}`}
      onClickCapture={onClickCapture}
    >
      {/* 麵包屑：固定在最上方，不是區塊 */}
      <div className="detail-subnav">
        <div className="container pp-subnav-inner">
          <Link href="/products" className="detail-back-btn">
            ← {zh ? '所有商品' : 'All Products'}
          </Link>
          <span className="detail-subnav-divider" />
          <span className="detail-subnav-name">{name}</span>
        </div>
      </div>

      <div className="pp-wrap">
        <div className="container blk-grid pp-grid">
          {blocks.map(block => {
            const Renderer = PRODUCT_RENDERERS[block.type]
            const cls = [
              'pp-cell',
              editing && block.id === selectedId ? 'is-selected' : '',
              editing && block.id === highlightId ? 'is-highlighted' : '',
            ].filter(Boolean).join(' ')
            return (
              <div
                key={block.id}
                className={cls}
                style={{ '--pp-span': block.span }}
                // 正式站不吐這個屬性：它只是編輯器的把手，沒必要出現在客人的 HTML 裡
                data-block-id={editing ? block.id : undefined}
              >
                {Renderer
                  ? <Renderer block={block} anchorRef={block.type === 'product_cta' ? anchorRef : undefined} />
                  // 靜態區塊沿用商城既有的渲染器。一次只餵一塊：BlocksView 自己的垂直節奏
                  // 在格線裡不適用（格線的 gap 已經負責間距），CSS 那邊會把它歸零。
                  : <BlocksView blocks={[block]} productsByBlock={productsByBlock} />}
              </div>
            )
          })}
        </div>
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
          <button type="button" className="add-btn" onClick={addToCart}
            disabled={isUnavailable} tabIndex={barVisible ? 0 : -1}>
            {ctaLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
