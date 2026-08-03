// 通知商城清除快取（後台改商品／設定／首頁後呼叫）。
// 帶當前使用者的 Supabase JWT 給商城 /api/revalidate 驗證身分，不需靜態密鑰。
//
// 這支「不拋錯、不阻斷」：清快取失敗不該讓人以為儲存失敗，資料確實已經進資料庫了。
// 但也不能靜默 —— 失敗時商城會繼續顯示舊內容，後台卻一切正常，
// 這個落差曾讓人以為首頁功能壞掉（真正的原因只是 VITE_SHOP_URL 指到了錯的 port）。
//
// 折衷：回傳結果 + 廣播事件，由 ShopSyncNotice 顯示一則可關閉的提示。
// 呼叫端可以完全不理會回傳值（多數是 fire-and-forget），使用者仍然會被告知。
import { supabase } from './supabase'

const SHOP_URL = import.meta.env.VITE_SHOP_URL

export const SHOP_SYNC_FAILED = 'shop-sync-failed'

function fail(reason) {
  console.warn('[revalidateShop] 清商城快取失敗：', reason)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SHOP_SYNC_FAILED, { detail: { reason } }))
  }
  return { ok: false, reason }
}

export async function revalidateShop({ storeId, slug, productIds = [] } = {}) {
  // 還沒載入完成時會沒有 storeId，那是時序問題不是使用者能處理的事，不打擾他
  if (storeId == null) return { ok: false, reason: 'no-store-id' }
  if (!SHOP_URL) return fail('後台沒有設定商城網址（VITE_SHOP_URL）')

  try {
    const { data: { session } } = await supabase.auth.getSession()
    const token = session?.access_token
    if (!token) return fail('登入狀態已失效，請重新登入後再存一次')

    const res = await fetch(`${SHOP_URL.replace(/\/$/, '')}/api/revalidate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ storeId, slug, productIds }),
    })

    // 舊版只 await fetch 不看結果 —— 商城回 401／500 一樣被當成成功。
    // 這比 catch 吞錯更隱蔽，因為連 console 都不會留下痕跡。
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return fail(`商城回應 ${res.status}${body ? `（${body.slice(0, 100)}）` : ''}`)
    }
    return { ok: true }
  } catch {
    return fail(`連不上商城（${SHOP_URL}）`)
  }
}

// 給 UI 訂閱失敗事件，回傳解除訂閱的函式
export function onShopSyncFailed(handler) {
  window.addEventListener(SHOP_SYNC_FAILED, handler)
  return () => window.removeEventListener(SHOP_SYNC_FAILED, handler)
}
