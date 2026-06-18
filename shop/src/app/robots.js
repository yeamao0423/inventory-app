import { headers } from 'next/headers'

// 每個網域產出自己的 robots.txt（含該店 sitemap 位置）。
// 購物車/結帳/會員/登入/訂單不需被收錄 → 擋掉。
export default function robots() {
  const host = headers().get('host') || ''
  const proto = host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https'
  const base = `${proto}://${host}`
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/cart', '/checkout', '/account', '/auth', '/order/'],
    },
    sitemap: `${base}/sitemap.xml`,
  }
}
