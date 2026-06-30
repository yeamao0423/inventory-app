import { notFound, redirect } from 'next/navigation'
import { getProductDetail } from '../../../../lib/data'
import { slugifyName } from '../../../../lib/slug'
import ProductDetail from '../ProductDetail'

// 暫時：每次請求都抓最新（方便 local 測試）。F 層導入 ISR 後改為 revalidate + tag。
export const dynamic = 'force-dynamic'

// SEO：伺服器端產生標題/描述/分享縮圖（爬蟲、LINE/FB 分享看得到）
export async function generateMetadata({ params }) {
  const data = await getProductDetail(params.id)
  if (!data) return { title: '商品' }

  const { sp, store } = data
  const p = sp.products
  const name = p.name
  const desc = (sp.desc_zh || '').slice(0, 160)
  const img = [...(p.product_images || [])].sort((a, b) => a.sort_order - b.sort_order)[0]?.url
  const title = store?.name ? `${name}｜${store.name}` : name
  // 正規網址：永遠指向 /products/{id}/{目前名稱}，避免重複內容
  const canonical = `/products/${params.id}/${encodeURIComponent(slugifyName(name))}`

  return {
    title,
    description: desc || name,
    alternates: { canonical },
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
  // 一律用第一段 id 解析（全域唯一、不怕重名/改名）。第二段名稱只是裝飾。
  const data = await getProductDetail(params.id)
  if (!data) notFound()

  // 301 正規網址導正：名稱段缺少或與目前商品名不符時，轉到正確網址。
  // 效果：①舊的 /products/{id} 自動升級成帶名稱的漂亮網址
  //      ②商品改名後，舊名稱網址自動修正 ③Google 只索引一個正規網址。
  // catch-all 的 params.slug 在某些 Next 版本是百分比編碼，先 decode 再比對，避免中文 slug 無限導向。
  const canonicalSlug = slugifyName(data.sp.products.name)
  let requested = params.slug?.[0]
  if (requested != null) {
    try { requested = decodeURIComponent(requested) } catch { /* 壞編碼就原樣比對 */ }
  }
  if (canonicalSlug && requested !== canonicalSlug) {
    redirect(`/products/${params.id}/${encodeURIComponent(canonicalSlug)}`)
  }

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
