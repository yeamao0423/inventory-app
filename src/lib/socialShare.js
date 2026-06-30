// 社群分享：純函式，零依賴。供 StorefrontPage 的分享面板與 SettingsPage 的模板設定共用。

// 平台根網域；之後要換 likediago.com 改這一行即可。
export const ROOT_DOMAIN = 'daigogo.com'

// 文案模板可用變數
export const SHARE_VARS = [
  { token: '{商品名稱}', desc: '商品名稱' },
  { token: '{售價}', desc: '商城售價（數字，已加千分位）' },
  { token: '{連結}', desc: '商品頁網址' },
  { token: '{商店名稱}', desc: '店名' },
]

export const DEFAULT_SHARE_TEMPLATE = '🛍️ {商品名稱} 開賣囉！\n💰 NT${售價}\n👉 {連結}'

// 平台清單：mode 'share' 可直接開分享頁；mode 'copy' 只能複製文案讓使用者自行貼上。
export const PLATFORMS = [
  { key: 'line', label: 'Line', mode: 'share' },
  { key: 'threads', label: 'Threads', mode: 'share' },
  { key: 'facebook', label: 'Facebook', mode: 'copy' },
  { key: 'instagram', label: 'Instagram', mode: 'copy' },
]

// 推導商城網址：有自訂網域用店主的，否則 https://{slug}.{ROOT_DOMAIN}
export function resolveShopBaseUrl(store) {
  if (!store) return ''
  const domain = (store.custom_domain || '').trim()
  if (domain) return /^https?:\/\//.test(domain) ? domain.replace(/\/+$/, '') : `https://${domain}`
  if (store.slug) return `https://${store.slug}.${ROOT_DOMAIN}`
  return ''
}

// 商品名稱 → 網址 slug。與商城 shop/src/lib/slug.js 同邏輯（兩個獨立套件無法共用 import，需同步維護）。
export function slugifyProductName(name) {
  return String(name ?? '')
    .trim()
    .replace(/[\s/\\?#%]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// 商品公開連結。帶 name 時產生漂亮網址 /products/{id}/{slug}；不帶 name 仍相容舊格式 /products/{id}。
export function buildProductUrl(baseUrl, productId, name) {
  if (!baseUrl) return ''
  const base = `${baseUrl.replace(/\/+$/, '')}/products/${productId}`
  const slug = slugifyProductName(name)
  return slug ? `${base}/${encodeURIComponent(slug)}` : base
}

// 模板代入：未知變數原樣保留。售價為數字時加千分位。
export function renderTemplate(template, vars = {}) {
  const map = {
    '{商品名稱}': vars.name ?? '',
    '{售價}': vars.price != null && vars.price !== '' ? Number(vars.price).toLocaleString() : '',
    '{連結}': vars.link ?? '',
    '{商店名稱}': vars.storeName ?? '',
  }
  return String(template ?? '').replace(/\{[^}]+\}/g, (m) => (m in map ? map[m] : m))
}

// 產生直接分享的 URL（mode === 'share' 的平台才有）。
// facebook 分享器只吃網址（文字會被 FB 移除），故以複製文案為主、開分享器帶連結為輔。
export function buildShareUrl(platform, text, link) {
  const t = encodeURIComponent(text ?? '')
  const u = encodeURIComponent(link ?? '')
  switch (platform) {
    case 'line':
      return `https://line.me/R/msg/text/?${t}`
    case 'threads':
      return `https://www.threads.net/intent/post?text=${t}`
    case 'facebook':
      return `https://www.facebook.com/sharer/sharer.php?u=${u}`
    default:
      return ''
  }
}
