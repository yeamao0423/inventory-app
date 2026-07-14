import { notFound } from 'next/navigation'
import { getStoreByHost, getStorePage } from '../../../lib/data'
import { renderMarkdown } from '../../../lib/markdown'

// 店家自訂靜態頁（服務條款／FAQ／隱私權／自訂頁）。
// 用 host 解析店家會用到 headers() → 動態渲染；內容由後台寫入 store_pages.body（Markdown）。
export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }) {
  const store = await getStoreByHost()
  const page = store ? await getStorePage(store.id, params.slug) : null
  if (!page) return { title: store?.name || '' }
  return {
    title: store?.name ? `${page.title}｜${store.name}` : page.title,
    robots: { index: true, follow: true },
  }
}

export default async function LegalPage({ params }) {
  const store = await getStoreByHost()
  const page = store ? await getStorePage(store.id, params.slug) : null
  if (!page) notFound()

  return (
    <div className="container legal">
      <h1 className="legal-title">{page.title}</h1>
      <div className="legal-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(page.body) }} />
    </div>
  )
}
