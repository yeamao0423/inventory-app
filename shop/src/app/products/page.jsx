import { headers } from 'next/headers'
import { getStoreByHost, getProductList } from '../../lib/data'
import ProductList from './ProductList'

// 暫時：用 host 解析店家會用到 headers()，本就是動態。F 層改 ISR 時一併處理。
export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const store = await getStoreByHost()
  const storeName = store?.name || 'Daigogo'
  const title = `商品一覽｜${storeName}`
  const description = store?.settings?.seo_description
    || `瀏覽 ${storeName} 全部商品，快速下單、安心代購。`
  const host = (headers().get('host') || '').split(':')[0]
  const siteUrl = `https://${host}`
  const logoUrl = store?.settings?.logo_url

  return {
    title,
    description,
    alternates: { canonical: `${siteUrl}/products` },
    openGraph: {
      title,
      description,
      type: 'website',
      url: `${siteUrl}/products`,
      ...(logoUrl ? { images: [{ url: logoUrl }] } : {}),
    },
  }
}

export default async function ProductsPage() {
  const store = await getStoreByHost()
  const { products, categories, tags } = store
    ? await getProductList(store.id)
    : { products: [], categories: [], tags: [] }

  return <ProductList products={products} categories={categories} tags={tags} menuSettings={store?.settings} />
}
