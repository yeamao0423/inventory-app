// 伺服器端資料抓取（Server Components 用）
// 規則：一律用 anon key（沿用 lib/supabase），靠 RLS 只露出已上架、藏住成本。
// 快取：用 unstable_cache 把 DB 查詢結果快取起來 + 掛 tag，後台改東西時用
//       revalidateTag(`store-${id}`) 立即失效（見 app/api/revalidate）。
//       revalidate: 3600 是保險，最久一小時自動更新一次。
import { cache } from 'react'
import { headers } from 'next/headers'
import { unstable_cache } from 'next/cache'
import { supabase } from './supabase'

const STORE_COLS = 'id, name, slug, settings, is_active'
const TTL = 3600 // 秒

// ── 店家：依 slug（快取，tag=store-slug-{slug}）──
function fetchStoreBySlug(slug) {
  return unstable_cache(
    async () => {
      if (!supabase) return null
      const { data } = await supabase.from('stores').select(STORE_COLS).eq('slug', slug).maybeSingle()
      return data || null
    },
    ['store-by-slug', slug],
    { tags: [`store-slug-${slug}`], revalidate: TTL },
  )()
}

// ── 店家：依自訂網域（快取，tag=store-domain-{host}）──
function fetchStoreByDomain(host) {
  return unstable_cache(
    async () => {
      if (!supabase) return null
      const { data } = await supabase.from('stores').select(STORE_COLS)
        .eq('custom_domain', host).eq('is_active', true).maybeSingle()
      return data || null
    },
    ['store-by-domain', host],
    { tags: [`store-domain-${host}`], revalidate: TTL },
  )()
}

// ── 店家：依 id（快取，tag=store-{id}）──
function fetchStoreById(storeId) {
  return unstable_cache(
    async () => {
      if (!supabase) return null
      const { data } = await supabase.from('stores').select(STORE_COLS).eq('id', storeId).maybeSingle()
      return data || null
    },
    ['store-by-id', String(storeId)],
    { tags: [`store-${storeId}`], revalidate: TTL },
  )()
}

// 平台主網域清單（過渡期可同時多個）。env 可覆寫，加新平台網域不用改程式。
// 注意：店主「自訂網域」（如 daigogo.com）不放這裡，那走 custom_domain 查詢。
const PLATFORM_DOMAINS = (process.env.NEXT_PUBLIC_PLATFORM_DOMAINS
  || 'daigogotw.com,likedaigo.com,localhost,127.0.0.1')
  .split(',').map(s => s.trim()).filter(Boolean)
const DEFAULT_SLUG = 'daigogo'

// host（去掉 port）→ { slug } 或 { customDomain }
function resolveStoreKey(hostname) {
  for (const root of PLATFORM_DOMAINS) {
    if (hostname === root) return { slug: DEFAULT_SLUG }            // 裸平台網域 → 過渡期預設 daigogo
    if (hostname.endsWith('.' + root)) {                           // 平台網域的子網域 → 取最前段當 slug
      const sub = hostname.slice(0, -(root.length + 1)).split('.')[0]
      return { slug: sub || DEFAULT_SLUG }
    }
  }
  return { customDomain: hostname }                                // 不屬任何平台網域 → 視為自訂網域
}

// 依請求 host 解析店家（server 版，取代 lib/store.js 的 window 判斷）。
// 優先序：自訂網域 > 平台子網域 > 裸平台網域預設。讀 headers() 不能進 unstable_cache，
// 所以這層只做字串判斷，真正的 DB 查詢走上面的快取函式。
export const getStoreByHost = cache(async () => {
  if (!supabase) return null
  if (process.env.NEXT_PUBLIC_STORE_SLUG) return fetchStoreBySlug(process.env.NEXT_PUBLIC_STORE_SLUG)

  const hostname = (headers().get('host') || '').split(':')[0]
  const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost')

  // 1) 自訂網域優先（店主已綁定的完整網域，如 daigogo.com）。localhost 系列不可能是自訂網域 → 跳過省一次查詢。
  if (!isLocalHost) {
    const byDomain = await fetchStoreByDomain(hostname)
    if (byDomain) return byDomain
  }

  // 2) 平台子網域 → slug；裸平台網域 → 預設 daigogo；都不是 → null（找不到店）
  const key = resolveStoreKey(hostname)
  if (key.customDomain) return null
  return fetchStoreBySlug(key.slug)
})

// ── 商品列表頁資料（快取，tag=store-{id}）──
export const getProductList = cache(async (storeId) => {
  if (!supabase || storeId == null) return { products: [], categories: [], tags: [] }
  return unstable_cache(
    async () => {
      const [{ data: sp }, { data: cats }, { data: tgs }] = await Promise.all([
        supabase
          .from('storefront_products')
          .select('*, products:shop_products(*, product_images(url, sort_order), categories(id, name, name_en), product_tags(tag_id), product_variants(stock, variant_price, sale_price))')
          .eq('store_id', storeId)
          .eq('published', true)
          .order('created_at', { ascending: false }),
        supabase.from('categories').select('*').eq('store_id', storeId).order('sort_order').order('name'),
        supabase.from('tags').select('*').eq('store_id', storeId).order('sort_order').order('name'),
      ])
      return { products: sp || [], categories: cats || [], tags: tgs || [] }
    },
    ['product-list', String(storeId)],
    { tags: [`store-${storeId}`], revalidate: TTL },
  )()
})

// 先輕量查出商品屬於哪家店（之後才能把詳情快取同時掛上 store-{id} tag）
function fetchProductStoreId(productId) {
  return unstable_cache(
    async () => {
      if (!supabase) return null
      const { data } = await supabase
        .from('storefront_products').select('store_id')
        .eq('product_id', productId).eq('published', true).maybeSingle()
      return data?.store_id ?? null
    },
    ['product-store-id', String(productId)],
    { tags: [`product-${productId}`], revalidate: TTL },
  )()
}

// ── 商品詳情（快取，tag=product-{id} + store-{id}）──
// 商品 ID 全域唯一 → 不需先知道店家即可反查。
export const getProductDetail = cache(async (productId) => {
  if (!supabase) return null
  const storeId = await fetchProductStoreId(productId)
  if (storeId == null) return null

  return unstable_cache(
    async () => {
      const { data: sp } = await supabase
        .from('storefront_products')
        .select('*, products:shop_products!inner(*, product_images(id, url, sort_order, tag_filter))')
        .eq('product_id', productId)
        .eq('published', true)
        .maybeSingle()
      if (!sp) return null

      const [{ data: varData }, { data: optData }, { data: optTypes }, { data: ptData }, { data: store }] = await Promise.all([
        // 明列欄位：不含 variant_cost（migration 39 對 anon 封鎖成本，select('*') 會整句報錯）
        supabase.from('product_variants')
          .select('id, product_id, options, stock, price_adjustment, variant_price, sale_price')
          .eq('product_id', sp.product_id),
        supabase.from('custom_options').select('*').eq('product_id', sp.product_id),
        supabase.from('variant_option_types')
          .select('*, variant_option_values(id, value, sort_order)')
          .eq('store_id', storeId)
          .order('sort_order'),
        supabase.from('product_tags').select('tag_id, tags(id, name, name_en)').eq('product_id', sp.product_id),
        supabase.from('stores').select(STORE_COLS).eq('id', storeId).maybeSingle(),
      ])

      return {
        sp,
        variants: varData || [],
        customOptions: optData || [],
        optTypes: optTypes || [],
        productTags: (ptData || []).map(pt => pt.tags).filter(Boolean),
        store: store || null,
      }
    },
    ['product-detail', String(productId)],
    { tags: [`product-${productId}`, `store-${storeId}`], revalidate: TTL },
  )()
})

// ── sitemap 用：該店已上架商品（id+name）與品牌清單（快取，tag=store-{id}）──
export const getSitemapData = cache(async (storeId) => {
  if (!supabase || storeId == null) return { products: [], brands: [] }
  return unstable_cache(
    async () => {
      const { data } = await supabase
        .from('storefront_products')
        .select('product_id, products:shop_products!inner(name, source)')
        .eq('store_id', storeId).eq('published', true)
      const rows = data || []
      const products = rows.map(r => ({ id: r.product_id, name: r.products?.name || '' }))
      const brands = [...new Set(rows.map(r => r.products?.source).filter(Boolean))]
      return { products, brands }
    },
    ['sitemap-data', String(storeId)],
    { tags: [`store-${storeId}`], revalidate: TTL },
  )()
})

// 給其他地方用（目前 product 詳情已內含 store）
export { fetchStoreById as getStoreById }
