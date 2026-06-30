import { getStoreByHost, getProductList } from '../../../../lib/data'
import ProductList from '../../ProductList'

// 暫時：用 host 解析店家會用到 headers()，本就是動態。F 層改 ISR 時一併處理。
export const dynamic = 'force-dynamic'

// SEO：每個品牌頁有自己的標題/描述，分享到 LINE/FB 聚焦該品牌（採購來源）。
export async function generateMetadata({ params }) {
  const source = decodeURIComponent(params.source)
  const store = await getStoreByHost()
  const title = store?.name ? `${source}｜${store.name}` : source
  return {
    title,
    description: store?.settings?.seo_description
      ? `${source}｜${store.settings.seo_description}`
      : `${source} 商品一覽`,
  }
}

export default async function BrandPage({ params }) {
  const source = decodeURIComponent(params.source)
  const store = await getStoreByHost()
  const { products, categories, tags } = store
    ? await getProductList(store.id)
    : { products: [], categories: [], tags: [] }

  // 品牌段直接交給 ProductList 預選；篩選邏輯共用，不重寫一份。
  return (
    <ProductList
      products={products}
      categories={categories}
      tags={tags}
      initialSource={source}
    />
  )
}
