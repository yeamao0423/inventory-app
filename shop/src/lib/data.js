// 伺服器端資料抓取（Server Components 用）
// 規則：一律用 anon key（沿用 lib/supabase），靠 RLS 只露出已上架、藏住成本。
// 快取：用 unstable_cache 把 DB 查詢結果快取起來 + 掛 tag，後台改東西時用
//       revalidateTag(`store-${id}`) 立即失效（見 app/api/revalidate）。
//       revalidate: 3600 是保險，最久一小時自動更新一次。
import { cache } from 'react'
import { headers } from 'next/headers'
import { unstable_cache } from 'next/cache'
import { supabase } from './supabase'
import { pickBlockProducts } from './blockProducts'

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
          .select('*, products:shop_products(*, product_images(url, sort_order), categories(id, name, name_en, parent_id), product_tags(tag_id), product_variants(stock, variant_price, sale_price))')
          .eq('store_id', storeId)
          .eq('published', true)
          .order('created_at', { ascending: false }),
        // 只取上架分類（下架的父分類其子分類也不會出現在選單樹，因子分類靠父節點展開）
        supabase.from('categories').select('*').eq('store_id', storeId).eq('active', true).order('sort_order').order('name'),
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

// ── generateStaticParams 用：所有已上架商品的 id + name（跨店）──
// 商品詳情頁靠全域唯一的 product_id 反查店，不讀 host，故 build 時可預先渲染全部商品頁。
// 不掛 unstable_cache：build 時執行一次即可，不需跨請求快取。
export async function getAllPublishedProductParams() {
  if (!supabase) return []
  const { data } = await supabase
    .from('storefront_products')
    .select('product_id, products:shop_products!inner(name)')
    .eq('published', true)
  return (data || []).map(r => ({ id: r.product_id, name: r.products?.name || '' }))
}

// ── 靜態頁：該店已發佈頁清單（footer/導覽用，快取 tag=store-{id}）──
export const getStorePages = cache(async (storeId) => {
  if (!supabase || storeId == null) return []
  return unstable_cache(
    async () => {
      const { data } = await supabase
        .from('store_pages')
        .select('slug, title, sort_order')
        .eq('store_id', storeId).eq('is_published', true)
        .order('sort_order').order('id')
      return data || []
    },
    ['store-pages', String(storeId)],
    { tags: [`store-${storeId}`], revalidate: TTL },
  )()
})

// ── 靜態頁：單一已發佈頁（依 store + slug，快取 tag=store-{id}）──
export const getStorePage = cache(async (storeId, slug) => {
  if (!supabase || storeId == null || !slug) return null
  return unstable_cache(
    async () => {
      const { data } = await supabase
        .from('store_pages')
        .select('slug, title, body, updated_at')
        .eq('store_id', storeId).eq('slug', slug).eq('is_published', true)
        .maybeSingle()
      return data || null
    },
    ['store-page', String(storeId), slug],
    { tags: [`store-${storeId}`], revalidate: TTL },
  )()
})

// ── 組合商品：先輕量查出組合屬於哪家店（之後才能把詳情快取也掛上 store-{id} tag）──
function fetchBundleStoreId(bundleId) {
  return unstable_cache(
    async () => {
      if (!supabase) return null
      const { data } = await supabase
        .from('bundles').select('store_id')
        .eq('id', bundleId).eq('is_published', true).maybeSingle()
      return data?.store_id ?? null
    },
    ['bundle-store-id', String(bundleId)],
    { tags: [`bundle-${bundleId}`], revalidate: TTL },
  )()
}

// ── 組合商品落地頁（快取，tag=bundle-{id} + store-{id}）──
// 組合 id 全域唯一 → 與商品詳情頁一樣不需先知道店家即可反查，可完整靜態快取。
// 回傳的 items 逐件帶著該商品的上架資料與規格，讓消費者在落地頁直接選規格。
export const getBundleDetail = cache(async (bundleId) => {
  if (!supabase) return null
  const storeId = await fetchBundleStoreId(bundleId)
  if (storeId == null) return null

  return unstable_cache(
    async () => {
      const { data: bundle } = await supabase
        .from('bundles')
        .select('*, bundle_items(product_id, sort_order)')
        .eq('id', bundleId)
        .eq('is_published', true)
        .maybeSingle()
      if (!bundle) return null

      const ordered = [...(bundle.bundle_items || [])].sort((a, b) => a.sort_order - b.sort_order)
      const productIds = ordered.map(bi => bi.product_id)
      if (productIds.length === 0) {
        return { bundle, items: [], missingProductIds: [], optTypes: [], store: null }
      }

      const [{ data: sps }, { data: varData }, { data: optTypes }, { data: store }] = await Promise.all([
        supabase
          .from('storefront_products')
          .select('*, products:shop_products!inner(*, product_images(id, url, sort_order, tag_filter))')
          .eq('store_id', storeId)
          .eq('published', true)
          .in('product_id', productIds),
        // 明列欄位：不含 variant_cost（migration 39 對 anon 封鎖成本，select('*') 會整句報錯）
        supabase.from('product_variants')
          .select('id, product_id, options, stock, price_adjustment, variant_price, sale_price')
          .in('product_id', productIds),
        supabase.from('variant_option_types')
          .select('*, variant_option_values(id, value, sort_order)')
          .eq('store_id', storeId)
          .order('sort_order'),
        supabase.from('stores').select(STORE_COLS).eq('id', storeId).maybeSingle(),
      ])

      // 已下架／已刪除的商品沒有東西可以顯示，但**不能當作它不存在** ——
      // 結帳時 DB 仍會以 bundle_items 判定完整性，缺這件就不給套裝價。
      // 所以另外回報 missingProductIds，讓落地頁的價格與結帳結果一致。
      const spByProduct = new Map((sps || []).map(sp => [sp.product_id, sp]))
      const items = productIds
        .filter(pid => spByProduct.has(pid))
        .map(pid => ({
          productId: pid,
          sp: spByProduct.get(pid),
          variants: (varData || []).filter(v => v.product_id === pid),
        }))
      const missingProductIds = productIds.filter(pid => !spByProduct.has(pid))

      return { bundle, items, missingProductIds, optTypes: optTypes || [], store: store || null }
    },
    ['bundle-detail', String(bundleId)],
    { tags: [`bundle-${bundleId}`, `store-${storeId}`], revalidate: TTL },
  )()
})

// ── generateStaticParams 用：所有已發佈組合的 id + name（跨店）──
// 不掛 unstable_cache：build 時執行一次即可。
export async function getAllPublishedBundleParams() {
  if (!supabase) return []
  const { data } = await supabase.from('bundles').select('id, name').eq('is_published', true)
  return data || []
}

// 給其他地方用（目前 product 詳情已內含 store）
export { fetchStoreById as getStoreById }

// ── 首頁區塊內容（快取，tag=store-{id}）──
// 刻意不塞進 STORE_COLS：那組欄位被每一頁的店家查詢共用，把首頁 blocks 掛上去
// 等於每頁都多背一份用不到的 jsonb。首頁自己多打一次（已快取）比較划算。
// 回傳原始 jsonb，正規化交給 lib/contentBlocks.js —— null 代表「沒編過」，
// 首頁據此走既有預設版面（轉址到 /products），不是顯示空白頁。
export const getStoreHomeBlocks = cache(async (storeId) => {
  if (!supabase || storeId == null) return null
  return unstable_cache(
    async () => {
      const { data } = await supabase
        .from('stores').select('home_blocks')
        .eq('id', storeId).maybeSingle()
      return data?.home_blocks ?? null
    },
    ['store-home-blocks', String(storeId)],
    { tags: [`store-${storeId}`], revalidate: TTL },
  )()
})

// ── 商品精選區塊用的商品（沿用既有的列表查詢，不新增 DB round-trip）──
// getProductList 已經被列表頁快取住，這裡只是在記憶體裡挑出要的幾筆，
// 且吐出的形狀與列表頁完全一致，商品卡片可以直接共用。
// 挑選規則本身在 lib/blockProducts.js（純函式），後台即時預覽在瀏覽器端用同一份，
// 兩邊才不會挑出不同結果。這裡只負責把快取好的商品清單餵進去。
export const getBlockProducts = cache(async (storeId, block) => {
  const { products, categories } = await getProductList(storeId)
  return pickBlockProducts(products, categories, block)
})
