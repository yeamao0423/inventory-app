// 品牌主色注入：把 stores.settings.brand_color 變成一組 CSS 變數。
//
// 這是 server component，掛在 server render 的頁面（首頁、商品詳情）上，
// 首屏就帶著正確顏色、不會先閃一次預設黑再變色。layout.jsx 另有一份 client 端的注入，
// 負責購物車／結帳這些純 client 頁面 —— 兩邊算出來的值相同，重覆宣告無害。
//
// 安全：brandCss 只吐得出 `:root{--brand:#rrggbb;...}` 這種形狀。
// hex 在 normalizeHex 就被嚴格比對過，帶分號或 url(...) 的字串一律變成 null（整段不注入），
// 所以這裡的 dangerouslySetInnerHTML 沒有 CSS 注入面。
import { brandCss } from '../lib/brandColor'

export default function BrandStyle({ store }) {
  const css = brandCss(store?.settings?.brand_color)
  if (!css) return null
  return <style dangerouslySetInnerHTML={{ __html: css }} />
}
