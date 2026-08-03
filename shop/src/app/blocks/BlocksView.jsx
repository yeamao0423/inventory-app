// 區塊的純渲染層 —— 只吃 props，不碰資料庫、沒有 state。
//
// ⚠️ 這支刻意**不加 'use client'**。沒有指令的元件會跟著使用它的樹走：
// 商城正式頁面（Blocks.jsx）在 server 樹裡用它 → 它就是 server component，
// 一個 byte 的 JS 都不會多送給客人，首頁與商品頁的 SSR/ISR、SEO 完全不受影響；
// 後台即時預覽（preview/live/LiveCanvas.jsx）在 client 樹裡用它 → 它自動變成 client component，
// 打字時可以在瀏覽器裡重畫。加上 'use client' 就會把商城正式頁面也一起拖下水，別加。
//
// 同理，這裡不可以出現 useState / onClick / useEffect。要互動請另外包一個小的 client 元件。
//
// 安全：所有文字都走 JSX 內插，React 會自動逸出（<script> 會變成純文字，不會執行）。
// 不要為了「支援粗體」就改用 dangerouslySetInnerHTML —— body 明確不解析 Markdown、不接受 HTML。
import Image from 'next/image'
import Link from 'next/link'
import { splitParagraphs } from '../../lib/contentBlocks'
import { getCardPricing } from '../../lib/salePrice'
import { slugifyName } from '../../lib/slug'

// next/image 只吃 next.config.js remotePatterns 允許的網域，遇到別的會直接丟錯把整頁弄掛。
// 店主貼進來的圖片網址不保證是我們的 Storage（例如從舊站搬過來的外連圖），
// 所以這裡分流：認得的網域走 next/image（有最佳化），其餘退回原生 <img>。
// 兩條路徑都畫在同一個固定長寬比的容器裡，所以無論走哪條都不會有 CLS。
function isOptimizable(url) {
  if (url.startsWith('/')) return true
  try {
    const u = new URL(url)
    if (u.protocol === 'https:' && u.hostname.endsWith('.supabase.co')) return true
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return true
    return false
  } catch {
    return false
  }
}

function BlockImage({ url, alt, ratio, sizes, priority = false }) {
  if (!url) {
    return <div className="blk-img blk-img-empty" style={{ aspectRatio: ratio }} aria-hidden="true" />
  }
  return (
    <div className="blk-img" style={{ aspectRatio: ratio }}>
      {isOptimizable(url)
        ? <Image src={url} alt={alt} fill sizes={sizes} priority={priority} style={{ objectFit: 'cover' }} />
        // eslint-disable-next-line @next/next/no-img-element
        : <img src={url} alt={alt} loading={priority ? 'eager' : 'lazy'} />}
    </div>
  )
}

// body 允許換行但不解析 Markdown：一行一段，標記字元原樣顯示。
function Paragraphs({ body, className }) {
  const paras = splitParagraphs(body)
  if (!paras.length) return null
  return (
    <div className={className}>
      {paras.map((line, i) => <p key={i}>{line}</p>)}
    </div>
  )
}

// ── 主視覺 ────────────────────────────────
// 背景圖滿版，但文字回到 .container 裡靠左 —— 標題左緣因此與導覽列 logo、
// 下方所有區塊的左緣落在同一條線上。文字置中於視窗會多出第二條基準線，寬螢幕上很明顯。
function HeroBlock({ block, first }) {
  const { image, title, subtitle, buttonText, buttonHref } = block
  return (
    <section className="blk blk-hero">
      <BlockImage url={image} alt={title || ''} ratio="21 / 9" sizes="100vw" priority={first} />
      <div className="blk-hero-overlay">
        <div className="container">
          <div className="blk-hero-inner">
            {title && <h2 className="blk-hero-title">{title}</h2>}
            {subtitle && <p className="blk-hero-sub">{subtitle}</p>}
            {/* href 已在正規化階段過白名單，javascript: 這類會變成空字串 → 不畫按鈕 */}
            {buttonText && buttonHref && (
              <Link href={buttonHref} className="blk-btn">{buttonText}</Link>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

// 店主設定的圖片佔比 → 十二欄的欄跨距。
// 25/33/50/67/75 這五個值本來就是 3/4/6/8/9 欄，用欄跨距表達之後比例才精準
// （33% 其實是 33.333%），而且圖片邊緣會跟商品精選的卡片邊緣對齊在同一條格線上。
const RATIO_COLS = { 25: 3, 33: 4, 50: 6, 67: 8, 75: 9 }

// ── 圖文並排 ──────────────────────────────
// 比例只在桌機生效；手機一律上下堆疊（並排在手機上會兩邊都太窄），
// 堆疊由 globals.css 的 media query 負責。
function MediaTextBlock({ block }) {
  const { image, imageSide, imageRatio, title, body } = block
  const cols = RATIO_COLS[imageRatio] || 6
  return (
    <section className={`blk blk-media-text blk-img-${imageSide}`}>
      <div className="container blk-grid blk-media-text-grid"
        style={{ '--blk-img-cols': cols, '--blk-body-cols': 12 - cols }}>
        <div className="blk-media-text-media">
          <BlockImage url={image} alt={title || ''} ratio="4 / 3"
            sizes={`(max-width: 760px) 100vw, ${Math.round(cols / 12 * 100)}vw`} />
        </div>
        <div className="blk-media-text-body">
          {title && <h2 className="blk-title">{title}</h2>}
          <Paragraphs body={body} className="blk-body" />
        </div>
      </div>
    </section>
  )
}

// ── 文字段落 ──────────────────────────────
function TextBlock({ block }) {
  const { title, body } = block
  return (
    <section className="blk blk-text">
      <div className="container">
        <div className="blk-narrow">
          {title && <h2 className="blk-title">{title}</h2>}
          <Paragraphs body={body} className="blk-body" />
        </div>
      </div>
    </section>
  )
}

// ── 商品精選 ──────────────────────────────
// 商品由呼叫端先挑好（server 端查資料庫／預覽端查快照），這裡只負責畫。
function ProductsBlock({ block, items }) {
  // 一件都挑不到（商品下架、分類清空）就整個區塊不出現，不要留一塊空白給客人看
  if (!items.length) return null
  return (
    <section className="blk blk-products">
      <div className="container">
        {block.title && <h2 className="blk-title">{block.title}</h2>}
        <div className="blk-grid blk-product-grid">
          {items.map(sp => <BlockProductCard key={sp.product_id} sp={sp} />)}
        </div>
      </div>
    </section>
  )
}

// 區塊裡的商品卡片：刻意是精簡版（圖／名稱／價格）。
// 列表頁那張卡帶著篩選、庫存、收單狀態等 client 端邏輯，那些不該被複製一份到這裡。
function BlockProductCard({ sp }) {
  const p = sp.products
  if (!p) return null
  const name = p.name
  const thumb = [...(p.product_images || [])].sort((a, b) => a.sort_order - b.sort_order)[0]?.url
  const price = getCardPricing(sp)
  const fmt = (min, max) => (min === max
    ? `NT$${min.toLocaleString()}`
    : `NT$${min.toLocaleString()}~${max.toLocaleString()}`)

  return (
    <Link href={`/products/${sp.product_id}/${slugifyName(name)}`} className="product-card">
      <BlockImage url={thumb} alt={name} ratio="1 / 1"
        sizes="(max-width: 600px) 50vw, (max-width: 1024px) 33vw, 25vw" />
      <div className="product-info">
        <div className="product-name">{name}</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          {price.onSale ? (
            <>
              <span className="product-price product-price-sale">{fmt(price.saleMin, price.saleMax)}</span>
              <span className="product-price-old">{fmt(price.regularMin, price.regularMax)}</span>
            </>
          ) : (
            <span className="product-price">{fmt(price.regularMin, price.regularMax)}</span>
          )}
        </div>
      </div>
    </Link>
  )
}

/**
 * 已正規化的區塊陣列 → JSX。
 *
 * @param blocks          normalizeContent() 的輸出（呼叫端負責正規化，這裡不再驗）
 * @param productsByBlock { [blockId]: storefront_products[] } —— 商品精選區塊要顯示的商品
 */
export default function BlocksView({ blocks, productsByBlock = {} }) {
  return (
    <div className="blocks">
      {blocks.map((block, i) => {
        if (block.type === 'products') {
          return <ProductsBlock key={block.id} block={block} items={productsByBlock[block.id] || []} />
        }
        const Renderer = RENDERERS[block.type]
        // normalizeContent 已經濾掉未知型別，這裡是最後一道保險
        if (!Renderer) return null
        return <Renderer key={block.id} block={block} first={i === 0} />
      })}
    </div>
  )
}

const RENDERERS = {
  hero: HeroBlock,
  media_text: MediaTextBlock,
  text: TextBlock,
}
