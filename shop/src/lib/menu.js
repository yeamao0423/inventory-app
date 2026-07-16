// 商城導覽選單設定（stores.settings.menu）。
// 一份有序清單，混排兩種項目：
//   群組項 { type: 'group', key: 'categories'|'brands'|'tags', enabled: bool }
//   置頂項 { type: 'category', id } | { type: 'brand', value } | { type: 'tag', id }
// 未設定時 fallback 預設（三個群組全開）。置頂項指向的對象不存在/下架時由呼叫端略過。

export const DEFAULT_MENU = [
  { type: 'group', key: 'categories', enabled: true },
  { type: 'group', key: 'brands', enabled: true },
  { type: 'group', key: 'tags', enabled: true },
]

export function getMenuItems(settings) {
  const menu = settings?.menu
  return Array.isArray(menu) && menu.length > 0 ? menu : DEFAULT_MENU
}

// 群組是否啟用（不在清單裡視同關閉——正常資料一定包含三個群組項）
export function groupEnabled(items, key) {
  const g = items.find(i => i.type === 'group' && i.key === key)
  return !!g?.enabled
}

// 置頂項解析成可渲染的連結資料；對象不存在（被刪/下架/無商品）回 null。
// cats: 上架分類清單、brands: 有商品的品牌清單、tags: 標籤清單、lang: 'zh'|'en'
export function resolvePin(item, { cats = [], brands = [], tags = [], lang = 'zh' } = {}) {
  const label = x => (lang === 'en' && x.name_en ? x.name_en : x.name)
  if (item.type === 'category') {
    const c = cats.find(c => c.id === item.id)
    return c ? { key: `cat-${c.id}`, href: `/products?cat=${c.id}`, label: label(c) } : null
  }
  if (item.type === 'brand') {
    if (!brands.includes(item.value)) return null
    return { key: `brand-${item.value}`, href: `/products/brand/${encodeURIComponent(item.value)}`, label: item.value }
  }
  if (item.type === 'tag') {
    const t = tags.find(t => t.id === item.id)
    return t ? { key: `tag-${t.id}`, href: `/products?tag=${t.id}`, label: label(t) } : null
  }
  return null
}
