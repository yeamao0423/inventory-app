import { getStoreByHost, getProductList } from '../../lib/data'
import ProductList from './ProductList'

// 暫時：用 host 解析店家會用到 headers()，本就是動態。F 層改 ISR 時一併處理。
export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const store = await getStoreByHost()
  const title = store?.name ? `商品一覽｜${store.name}` : '商品一覽'
  return {
    title,
    description: store?.settings?.seo_description || title,
  }
}

export default async function ProductsPage() {
  const store = await getStoreByHost()
  const { products, categories, tags } = store
    ? await getProductList(store.id)
    : { products: [], categories: [], tags: [] }

  return <ProductList products={products} categories={categories} tags={tags} />
}
