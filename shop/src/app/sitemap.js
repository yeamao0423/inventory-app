import { headers } from 'next/headers'
import { getStoreByHost, getPublishedProductIds } from '../lib/data'

// 每個網域產出自己的 sitemap：商品列表 + 該店所有已上架商品頁。
// 用 headers() 取目前網域 → 動態產生（依當前店家）。
export default async function sitemap() {
  const host = headers().get('host') || ''
  const proto = host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https'
  const base = `${proto}://${host}`

  const entries = [
    { url: `${base}/products`, changeFrequency: 'daily', priority: 0.8 },
  ]

  const store = await getStoreByHost()
  if (store) {
    const ids = await getPublishedProductIds(store.id)
    for (const id of ids) {
      entries.push({
        url: `${base}/products/${id}`,
        changeFrequency: 'weekly',
        priority: 0.6,
      })
    }
  }

  return entries
}
