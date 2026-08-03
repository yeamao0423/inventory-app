// 組合商品：瀏覽器端（購物車／結帳）用的查詢。
// 一律 anon 讀取，RLS 只露出 is_published = true 的組合 —— 草稿在商城完全不存在。
// 純計算在 bundleCart.js，這裡只負責把資料撈成它要的形狀。
import { supabase } from './supabase'

/**
 * 依 id 取回組合定義。回傳形狀直接餵給 bundleCart 的 evaluateBundle：
 * { id, name, bundle_price, productIds }
 * 查不到（已下架／已刪除）的組合就不會出現在結果裡 —— 呼叫端據此退回原價。
 */
export async function fetchBundlesByIds(ids) {
  const wanted = (Array.isArray(ids) ? ids : []).filter(id => id != null && id !== '')
  if (!supabase || wanted.length === 0) return []

  const { data } = await supabase
    .from('bundles')
    .select('id, name, bundle_price, bundle_items(product_id)')
    .in('id', wanted)
    .eq('is_published', true)

  return (data || []).map(b => ({
    id: b.id,
    name: b.name || '',
    bundle_price: Number(b.bundle_price) || 0,
    productIds: (b.bundle_items || []).map(bi => bi.product_id),
  }))
}
