import { redirect } from 'next/navigation'

// 正式的首頁轉址在 next.config.js 的 redirects()（邊緣層 308 + Location，對爬蟲友善）。
// 這裡只是 fallback，正常情況下不會被執行到。
export default function HomePage() {
  redirect('/products')
}
