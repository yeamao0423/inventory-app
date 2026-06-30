// 把商品名稱轉成網址用 slug：保留中文（瀏覽器/Next 會自動百分比編碼），
// 只把空白與會破壞路由的保留字元換成連字號。純函式、零依賴。
// 注意：product_id 才是解析依據，slug 只是給人看 / 給 SEO 的裝飾段。
export function slugifyName(name) {
  return String(name ?? '')
    .trim()
    .replace(/[\s/\\?#%]+/g, '-')  // 空白與會破壞網址結構的字元 → -
    .replace(/-+/g, '-')           // 連續 - 收斂成一個
    .replace(/^-+|-+$/g, '')       // 去頭尾 -
}
