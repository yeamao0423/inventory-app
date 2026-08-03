import { useEffect, useState } from 'react'
import { onShopSyncFailed } from '../lib/revalidateShop'

// 商城快取沒清成功時的提示。
//
// 刻意做成右下角的浮動卡片而不是插在版面裡：這不是阻斷性錯誤（資料已經存好了），
// 不該把頁面內容往下推。但也不能像以前那樣完全不講 —— 使用者會對著沒更新的商城
// 懷疑自己是不是沒按到儲存。
export default function ShopSyncNotice() {
  const [reason, setReason] = useState(null)

  useEffect(() => onShopSyncFailed(e => setReason(e.detail?.reason || '原因不明')), [])

  if (!reason) return null

  return (
    <div className="shop-sync-notice notice notice-warn" role="status">
      <div style={{ fontWeight: 600, marginBottom: 3 }}>已儲存，但商城還沒更新</div>
      <div style={{ fontSize: 12, lineHeight: 1.6 }}>
        資料已經存進資料庫，只是沒能通知商城清除快取，商城上看到的可能仍是舊版。
        稍後再存一次即可。
      </div>
      <div style={{ fontSize: 11.5, marginTop: 6, opacity: .75 }}>{reason}</div>
      <button className="shop-sync-close" onClick={() => setReason(null)} aria-label="關閉">知道了</button>
    </div>
  )
}
