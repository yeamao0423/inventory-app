// 通知商城清除快取（後台改商品/設定後呼叫）。
// 帶當前使用者的 Supabase JWT 給商城 /api/revalidate 驗證身分，不需靜態密鑰。
// 靜默失敗：清快取失敗不應該擋住後台本身的操作。
import { supabase } from './supabase'

const SHOP_URL = import.meta.env.VITE_SHOP_URL

export async function revalidateShop({ storeId, slug, productIds = [] } = {}) {
  if (!SHOP_URL || storeId == null) return
  try {
    const { data: { session } } = await supabase.auth.getSession()
    const token = session?.access_token
    if (!token) return
    await fetch(`${SHOP_URL.replace(/\/$/, '')}/api/revalidate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ storeId, slug, productIds }),
    })
  } catch {
    // 忽略：商城未啟動/網路問題時，不影響後台操作
  }
}
