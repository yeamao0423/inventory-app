import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getStoreByHost, getStoreHomeBlocks } from '../lib/data'
import Blocks, { hasBlocks } from './blocks/Blocks'
import BrandStyle from './BrandStyle'

// 首頁有兩種面貌，取決於店家有沒有編過區塊內容：
//   沒編過（home_blocks 為 null 或裡面一個區塊都不剩）→ 308 導向 /products，也就是既有的預設版面
//   編過                                            → 在這裡 server render 出區塊內容
//
// 這個轉址以前寫在 next.config.js 的 redirects()，因為它是邊緣層的靜態規則、看不到資料庫，
// 有了首頁客製就必須搬進來。搬回來會踩到當初把它移出去的那個坑：頁面若被靜態預渲染，
// Vercel 會回轉址狀態碼卻不帶 Location header（轉址只在 JS payload 裡），爬蟲進首頁就卡死。
// 解法是這頁本來就得讀 host 才知道是哪家店（getStoreByHost 會用 headers()），
// 加上 force-dynamic 明示，永遠不會被預渲染 → 轉址是真的 HTTP 狀態碼 + Location。
// **改這個檔案時務必保住的是「不預渲染」**，那才是那個坑的成因。
//
// 用 redirect（307 暫時）而不是 permanentRedirect（308 永久）：
// 「還沒編首頁」是暫時狀態，店家隨時會編。308 會被瀏覽器與搜尋引擎永久快取 ——
// 店家編好首頁之後，訪問過的人仍會被自己的瀏覽器擋在門外（實際發生過），
// Google 也會把首頁權重永久轉給 /products，之後很難救回來。
export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const store = await getStoreByHost()
  const storeName = store?.name || 'Daigogo'
  const host = (headers().get('host') || '').split(':')[0]
  const description = store?.settings?.seo_description || `${storeName} —— 精選代購商品，安心下單。`
  return {
    title: storeName,
    description,
    alternates: { canonical: `https://${host}/` },
    openGraph: {
      title: storeName,
      description,
      type: 'website',
      url: `https://${host}/`,
      ...(store?.settings?.logo_url ? { images: [{ url: store.settings.logo_url }] } : {}),
    },
  }
}

export default async function HomePage() {
  const store = await getStoreByHost()
  // 找不到店（網域沒對應）時也走預設版面，讓 /products 那邊統一處理錯誤畫面
  const content = store ? await getStoreHomeBlocks(store.id) : null

  if (!hasBlocks(content)) redirect('/products')

  return (
    <>
      <BrandStyle store={store} />
      <Blocks content={content} storeId={store.id} />
    </>
  )
}
