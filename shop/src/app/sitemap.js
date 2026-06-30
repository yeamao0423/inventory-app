import { headers } from 'next/headers'
import { getStoreByHost, getSitemapData } from '../lib/data'
import { slugifyName } from '../lib/slug'

// 每個網域產出自己的 sitemap：商品列表 + 各品牌頁 + 該店所有已上架商品頁。
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
    const { products, brands } = await getSitemapData(store.id)
    for (const b of brands) {
      entries.push({
        url: `${base}/products/brand/${encodeURIComponent(b)}`,
        changeFrequency: 'daily',
        priority: 0.7,
      })
    }
    for (const p of products) {
      const slug = slugifyName(p.name)
      entries.push({
        url: slug ? `${base}/products/${p.id}/${encodeURIComponent(slug)}` : `${base}/products/${p.id}`,
        changeFrequency: 'weekly',
        priority: 0.6,
      })
    }
  }

  return entries
}
