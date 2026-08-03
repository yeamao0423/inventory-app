// 區塊內容渲染的 server 入口：正規化 → 把「商品精選」要的商品查出來 → 交給 BlocksView 畫。
//
// 真正的版面在 BlocksView.jsx（純渲染、可被 server 或 client 樹共用），這支只做資料。
// 分家的理由：後台的即時預覽要在瀏覽器裡用同一份渲染器重畫，
// 但商城正式頁面必須維持 server render（SEO：curl 拿到的 HTML 就要有區塊文字與商品名稱）。
//
// 商品查詢走 lib/data.js 的 getBlockProducts（getProductList 已被快取，這裡不多打 DB）。
import { normalizeContent } from '../../lib/contentBlocks'
import { getBlockProducts } from '../../lib/data'
import BlocksView from './BlocksView'

/**
 * 區塊內容 → JSX。`raw` 直接吃資料庫來的 jsonb，正規化在這裡面做。
 * 內容是 null（沒編過）或正規化後一個區塊都不剩時回 null，
 * 呼叫端據此走既有的預設版面 —— null 不等於空白頁。
 */
export default async function Blocks({ content: raw, storeId }) {
  const content = normalizeContent(raw)
  if (!content || content.blocks.length === 0) return null

  const entries = await Promise.all(
    content.blocks
      .filter(b => b.type === 'products')
      .map(async b => [b.id, storeId == null ? [] : await getBlockProducts(storeId, b)]),
  )

  return <BlocksView blocks={content.blocks} productsByBlock={Object.fromEntries(entries)} />
}

/** 呼叫端不必自己 import normalizeContent 就能判斷「這份內容有沒有東西可畫」。 */
export function hasBlocks(raw) {
  const content = normalizeContent(raw)
  return !!content && content.blocks.length > 0
}
