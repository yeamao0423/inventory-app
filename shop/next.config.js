/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.supabase.co' },
    ],
  },
  async redirects() {
    // 首頁一律導向 /products。之前靠 app/page.jsx 的 redirect()，靜態預渲染後
    // Vercel 回 307 卻沒有 Location header（轉址只在 JS payload 裡），爬蟲進首頁
    // 就卡死 → Google 無法收錄。這裡改在邊緣層回標準 308 + Location。
    return [
      { source: '/', destination: '/products', permanent: true },
    ]
  },
  async headers() {
    // 只對「因人而異／敏感」路由禁止快取；商品頁交給各自的 revalidate（ISR），
    // 讓 CDN 能快取靜態 HTML。過去全站 no-store 會讓 ISR 完全失效。
    const noStore = { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }
    const privatePaths = [
      '/account/:path*',
      '/checkout/:path*',
      '/cart/:path*',
      '/auth/:path*',
      '/order/:path*',
      '/api/:path*',
    ]
    return privatePaths.map((source) => ({ source, headers: [noStore] }))
  },
}
module.exports = nextConfig
