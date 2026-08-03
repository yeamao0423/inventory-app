import { notFound, redirect } from 'next/navigation'
import { getBundleDetail, getAllPublishedBundleParams } from '../../../../lib/data'
import { slugifyName } from '../../../../lib/slug'
import BrandStyle from '../../../BrandStyle'
import BundleDetail from '../BundleDetail'

// ISR：與商品詳情頁對稱 —— 靠 params.id 反查店，不讀 host，可完整靜態快取。
// 後台存檔時 /api/revalidate 打 store-{id} tag 立即失效。
export const revalidate = 3600
export const dynamicParams = true

export async function generateStaticParams() {
  const bundles = await getAllPublishedBundleParams()
  // 回傳原始（未編碼）slug；Next.js 自行處理 URL 編碼，傳已編碼會雙重編碼。
  return bundles.map(b => ({ id: String(b.id), slug: [slugifyName(b.name)] }))
}

export async function generateMetadata({ params }) {
  const data = await getBundleDetail(params.id)
  if (!data) return { title: '組合商品' }

  const { bundle, store } = data
  const title = store?.name ? `${bundle.name}｜${store.name}` : bundle.name
  const desc = (bundle.description || '').slice(0, 160)
  const canonical = `/bundles/${params.id}/${encodeURIComponent(slugifyName(bundle.name))}`

  return {
    title,
    description: desc || bundle.name,
    alternates: { canonical },
    openGraph: {
      title,
      description: desc || bundle.name,
      type: 'website',
      images: bundle.hero_image_url ? [{ url: bundle.hero_image_url }] : [],
    },
  }
}

export default async function BundleLandingPage({ params }) {
  const data = await getBundleDetail(params.id)
  if (!data) notFound()

  // 301 正規網址導正，與商品頁同一套規則：名稱段只是裝飾，id 才是解析依據。
  // catch-all 的 params.slug 在某些 Next 版本是百分比編碼，先 decode 再比對，避免中文 slug 無限導向。
  const canonicalSlug = slugifyName(data.bundle.name)
  let requested = params.slug?.[0]
  if (requested != null) {
    try { requested = decodeURIComponent(requested) } catch { /* 壞編碼就原樣比對 */ }
  }
  if (canonicalSlug && requested !== canonicalSlug) {
    redirect(`/bundles/${params.id}/${encodeURIComponent(canonicalSlug)}`)
  }

  // 品牌主色在 server 端就注入，首屏直接是正確顏色。
  // 這頁之前漏掉了，只靠 layout 的 client 注入，開頁會先閃一次預設黑再變色。
  return (
    <>
      <BrandStyle store={data.store} />
      <BundleDetail
        bundle={data.bundle}
        items={data.items}
        missingProductIds={data.missingProductIds}
        optTypes={data.optTypes}
      />
    </>
  )
}
