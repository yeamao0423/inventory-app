import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { revalidateShop } from '../lib/revalidateShop'
import TaxonomyManager from '../components/TaxonomyManager'
import InventoryTab from './products/InventoryTab'
import StorefrontTab from './products/StorefrontTab'

// 商品：庫存、商城、分類管理三個面向共用一個入口。
// 三者吃的是同一批 products / storefront_products，拆成三個側欄項目只是讓人多繞路。
const TABS = [
  { key: 'inventory', label: '庫存',     sub: '庫存與成本' },
  { key: 'listings',  label: '商城',     sub: '前台上架設定' },
  { key: 'taxonomy',  label: '分類管理', sub: '分類、標籤、規格' },
]

export default function ProductsPage() {
  const { can, storeId, store } = useAuth()
  // tab 放 URL query，重整或分享連結都會回到同一個分頁。
  // 預設＝商城：進商品頁最常做的是看/改前台上架，不是盤庫存。
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const tab = TABS.some(t => t.key === raw) ? raw : 'listings'
  const setTab = key => setParams(key === 'listings' ? {} : { tab: key }, { replace: true })

  const syncShop = () => revalidateShop({ storeId, slug: store?.slug })
  const current = TABS.find(t => t.key === tab)

  return (
    <div className="page">
      <div className="ph">
        <div>
          <div className="ph-title">商品</div>
          <div className="ph-sub">{current.sub}</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              flex: 1, padding: '9px 0', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600,
              background: tab === t.key ? 'var(--text)' : 'var(--card)',
              color: tab === t.key ? '#fff' : 'var(--text-2)',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'inventory' && <InventoryTab />}
      {tab === 'listings' && <StorefrontTab />}
      {tab === 'taxonomy' && <TaxonomyManager storeId={storeId} can={can} syncShop={syncShop} />}
    </div>
  )
}
