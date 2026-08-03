import { useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { useProductRefresh } from '../hooks/useProductRefresh'
import { revalidateShop } from '../lib/revalidateShop'
import QuickListSheet from './QuickListSheet'
import BulkListSheet from './BulkListSheet'
import ShopSyncNotice from './ShopSyncNotice'

// 全域置頂欄：跨頁常駐的動作（快速上架 / 批量上架 / 登出），不論停在哪個分頁都能用。
// 左側在手機補顯示店名（側欄的 .side-brand 只在桌機出現），桌機留白避免與側欄品牌重複。
export default function TopBar() {
  const { store, storeId, can, signOut } = useAuth()
  const { bump } = useProductRefresh()
  const [quickList, setQuickList] = useState(false)
  const [bulkList, setBulkList] = useState(false)

  // 上架成功：通知商品頁重抓 + 清商城快取（與原庫存頁的 handleSaved 同語意）
  function handleSaved() {
    bump()
    revalidateShop({ storeId })
  }

  const brandDisplay = store?.settings?.brand_display ?? 'both'

  return (
    <>
      <header className="topbar">
        <div className="topbar-brand">
          {brandDisplay !== 'name' && store?.settings?.logo_url && (
            <img src={store.settings.logo_url} alt="" />
          )}
          {brandDisplay !== 'logo' && <span>{store?.name ?? '平台'}</span>}
        </div>

        {can('add') && (
          <>
            <button className="topbar-btn topbar-btn-primary" onClick={() => setQuickList(true)}>
              快速上架
            </button>
            <div style={{ position: 'relative', display: 'inline-flex' }}>
              <button className="topbar-btn" onClick={() => setBulkList(true)}>
                批量上架
              </button>
              <span className="topbar-badge">試用</span>
            </div>
          </>
        )}
        <button className="topbar-signout" onClick={signOut}>登出</button>
      </header>

      {quickList && (
        <QuickListSheet onClose={() => setQuickList(false)} onSaved={handleSaved} />
      )}
      {bulkList && (
        <BulkListSheet onClose={() => setBulkList(false)} onSaved={handleSaved} />
      )}
      {/* 掛在全域置頂欄裡，任何一頁清商城快取失敗都看得到 */}
      <ShopSyncNotice />
    </>
  )
}
