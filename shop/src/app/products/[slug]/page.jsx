import { notFound } from 'next/navigation'
import { getProductDetail } from '../../../lib/data'
import ProductDetail from './ProductDetail'

// 暫時：每次請求都抓最新（方便 local 測試）。F 層導入 ISR 後改為 revalidate + tag。
export const dynamic = 'force-dynamic'

// SEO：伺服器端產生標題/描述/分享縮圖（爬蟲、LINE/FB 分享看得到）
export async function generateMetadata({ params }) {
  const data = await getProductDetail(params.slug)
  if (!data) return { title: '商品' }

  const { sp, store } = data
  const p = sp.products
  const name = p.name
  const desc = (sp.desc_zh || '').slice(0, 160)
  const img = [...(p.product_images || [])].sort((a, b) => a.sort_order - b.sort_order)[0]?.url
  const title = store?.name ? `${name}｜${store.name}` : name

  return {
    title,
    description: desc || name,
    openGraph: {
      title,
      description: desc || name,
      type: 'website',
      images: img ? [{ url: img }] : [],
    },
  }
}

// GEO：結構化資料，讓 AI 引擎能正確理解與引用這個商品
function buildProductJsonLd({ sp, store, productTags }) {
  const p = sp.products
  const images = [...(p.product_images || [])].sort((a, b) => a.sort_order - b.sort_order).map(i => i.url)
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.name,
    image: images,
    description: sp.desc_zh || undefined,
    sku: p.sku || undefined,
    brand: p.source ? { '@type': 'Brand', name: p.source } : undefined,
    offers: {
      '@type': 'Offer',
      price: String(sp.shop_price ?? 0),
      priceCurrency: 'TWD',
      availability: sp.sold_out ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock',
      ...(store?.name ? { seller: { '@type': 'Organization', name: store.name } } : {}),
    },
  }
}

export default async function ProductDetailPage({ params }) {
  const data = await getProductDetail(params.slug)
  if (!data) notFound()

  const jsonLd = buildProductJsonLd(data)

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <ProductDetail
        sp={data.sp}
        variants={data.variants}
        customOptions={data.customOptions}
        optTypes={data.optTypes}
        productTags={data.productTags}
      />
    </>
  )
}
