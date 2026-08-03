/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.supabase.co' },
      // 本機 Supabase Storage（區塊圖片在 local 開發時的來源）
      { protocol: 'http', hostname: '127.0.0.1' },
      { protocol: 'http', hostname: 'localhost' },
    ],
  },
  // 首頁的 `/` → `/products` 轉址原本寫在這裡（邊緣層 308）。
  // 有了首頁客製之後，「要不要轉址」取決於店家有沒有編過區塊內容，邊緣層看不到資料庫，
  // 所以轉址搬進 app/page.jsx，並在那裡用 force-dynamic + permanentRedirect 維持 308 + Location。
  // 詳細理由與不能退化成 307 的原因寫在 app/page.jsx 的檔頭。
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
      '/preview/:path*',   // 草稿預覽：內容尚未發佈，絕不可以被 CDN 快取或外流
    ]
    return privatePaths.map((source) => ({ source, headers: [noStore] }))
  },
}
module.exports = nextConfig
