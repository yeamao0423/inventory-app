import { useEffect, useState } from 'react'
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from './hooks/useAuth'
import LoginPage from './pages/LoginPage'
import InventoryPage from './pages/InventoryPage'
import OrdersPage from './pages/OrdersPage'
import StorefrontPage from './pages/StorefrontPage'
import UsersPage from './pages/UsersPage'
import TripsPage from './pages/TripsPage'
import CouponsPage from './pages/CouponsPage'
import InvitePage from './pages/InvitePage'
import PlatformPage from './pages/PlatformPage'
import SettingsPage from './pages/SettingsPage'
import MembersPage from './pages/MembersPage'
import MemberLevelsPage from './pages/MemberLevelsPage'

const allTabs = [
  { path: '/',           label: '庫存',  icon: BoxIcon, storeOnly: true },
  { path: '/orders',     label: '訂單',  icon: ReceiptIcon, storeOnly: true },
  { path: '/storefront', label: '商城',  icon: ShopIcon, storeOnly: true },
  { path: '/coupons',    label: '優惠券', icon: CouponIcon, storeOnly: true },
  { path: '/members',    label: '會員',  icon: MemberIcon, adminOnly: true },
  { path: '/levels',     label: '等級',  icon: TierIcon, adminOnly: true },
  { path: '/trips',      label: '行程',  icon: TripIcon, superOnly: true },
  { path: '/users',      label: '成員',  icon: UsersIcon, adminOnly: true },
  { path: '/settings',   label: '設定',  icon: GearIcon, superOnly: true },
  { path: '/platform',   label: '平台',  icon: PlatformIcon, platformOnly: true },
]

export default function App() {
  const { user, profile, loading, isBackendUser, isPlatformAdmin, store, signOut } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  // 純平台管理員（無店身分）落地到平台頁
  useEffect(() => {
    if (!loading && user && !isBackendUser && isPlatformAdmin && location.pathname !== '/platform' && location.pathname !== '/invite') {
      navigate('/platform', { replace: true })
    }
  }, [loading, user, isBackendUser, isPlatformAdmin, location.pathname])

  // 新店主首次進入（settings 未設定）→ 顯示可關閉的歡迎卡（不再強制導向，改 just-in-time 引導）
  const isFirstSetup = isBackendUser && profile?.role === 'super_admin'
    && store && Object.keys(store.settings ?? {}).length === 0
  const welcomeKey = store ? `welcome_dismissed_${store.id}` : null
  const [welcomeDismissed, setWelcomeDismissed] = useState(false)
  useEffect(() => {
    if (welcomeKey) setWelcomeDismissed(localStorage.getItem(welcomeKey) === '1')
  }, [welcomeKey])
  function dismissWelcome() {
    if (welcomeKey) localStorage.setItem(welcomeKey, '1')
    setWelcomeDismissed(true)
  }

  if (loading) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh', color:'var(--text-3)' }}>
      <BagIcon size={40} />
    </div>
  )
  if (location.pathname === '/invite') return <InvitePage />
  if (!user) return <LoginPage />

  // consumer 或無角色 → 無權限頁面（平台管理員例外，可進平台頁）
  if (!isBackendUser && !isPlatformAdmin) return (
    <div className="login-wrap">
      <div style={{ textAlign:'center' }}>
        <div style={{ fontSize:36, marginBottom:12 }}>🔒</div>
        <div style={{ fontWeight:600, fontSize:18, marginBottom:8 }}>無後台存取權限</div>
        <div style={{ fontSize:13, color:'var(--text-3)', marginBottom:24, lineHeight:1.6 }}>
          此帳號為商城消費者帳號，無法存取後台管理系統。<br/>
          如需後台權限，請聯繫管理員。
        </div>
        <button className="btn" style={{ maxWidth:200, margin:'0 auto' }} onClick={signOut}>登出</button>
      </div>
    </div>
  )

  const role = profile?.role
  const tabs = allTabs.filter(t => {
    if (t.platformOnly) return isPlatformAdmin
    if (t.superOnly) return isBackendUser && role === 'super_admin'
    if (t.adminOnly) return isBackendUser && (role === 'super_admin' || role === 'admin')
    return isBackendUser
  })

  const showWelcome = isFirstSetup && !welcomeDismissed && location.pathname !== '/settings'

  return (
    <div className="app">
      {showWelcome && (
        <div style={{
          margin: '12px 16px 0', padding: '12px 14px', borderRadius: 12,
          background: 'var(--blue-bg)', display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <div style={{ flex: 1, lineHeight: 1.5 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--blue)' }}>🎉 歡迎開店！</div>
            <div style={{ fontSize: 12.5, color: 'var(--blue)' }}>
              可直接到「庫存」建立商品。出貨單寄件人等資訊待要匯出出貨單時再到「設定」填即可。
            </div>
          </div>
          <button className="btn" onClick={() => navigate('/settings')}
            style={{ width: 'auto', padding: '7px 14px', fontSize: 13, flexShrink: 0 }}>
            前往設定
          </button>
          <button onClick={dismissWelcome} aria-label="關閉"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--blue)', fontSize: 20, lineHeight: 1, flexShrink: 0 }}>
            ×
          </button>
        </div>
      )}

      <Routes>
        <Route path="/"           element={<InventoryPage />} />
        <Route path="/orders"     element={<OrdersPage />} />
        <Route path="/storefront" element={<StorefrontPage />} />
        <Route path="/coupons"    element={<CouponsPage />} />
        <Route path="/members"    element={<MembersPage />} />
        <Route path="/levels"     element={<MemberLevelsPage />} />
        <Route path="/trips"      element={<TripsPage />} />
        <Route path="/users"      element={<UsersPage />} />
        <Route path="/settings"   element={<SettingsPage />} />
        <Route path="/platform"   element={<PlatformPage />} />
        <Route path="/invite"     element={<InvitePage />} />
      </Routes>

      <nav className="tabbar">
        <div className="side-brand">
          {(store?.settings?.brand_display ?? 'both') !== 'name' && (
            store?.settings?.logo_url
              ? <img src={store.settings.logo_url} alt="" style={{ objectFit: 'cover' }} />
              : <BagIcon size={24} />
          )}
          {(store?.settings?.brand_display ?? 'both') !== 'logo' && (store?.name ?? '平台')}
        </div>
        {tabs.map(({ path, label, icon: Icon }) => (
          <button
            key={path}
            className={`tab-btn ${location.pathname === path ? 'active' : ''}`}
            onClick={() => navigate(path)}
          >
            <Icon />
            <span className="tab-lbl">{label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}

function BoxIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 8L12 3 3 8m18 0v8l-9 5m0-13L3 8m9 13V11m9-3l-9 5M3 8l9 5"/></svg>
}
function BagIcon({ size = 24 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>
}
function ReceiptIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 012-2h2a2 2 0 012 2M9 5h6m-3 4v6m-2-3h4"/></svg>
}
function ShopIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l1-5h16l1 5"/><path d="M3 9a2 2 0 004 0 2 2 0 004 0 2 2 0 004 0 2 2 0 004 0M5 20h14a1 1 0 001-1v-7H4v7a1 1 0 001 1z"/></svg>
}
function CouponIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M2 9V6a2 2 0 012-2h16a2 2 0 012 2v3"/><path d="M2 15v3a2 2 0 002 2h16a2 2 0 002-2v-3"/><path d="M22 9a3 3 0 01-3 3 3 3 0 013 3"/><path d="M2 9a3 3 0 003 3 3 3 0 00-3 3"/><line x1="9" y1="9" x2="9" y2="9.01"/><line x1="9" y1="12" x2="9" y2="12.01"/><line x1="9" y1="15" x2="9" y2="15.01"/></svg>
}
function TripIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>
}
function MemberIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 11l-3 3-1.5-1.5"/></svg>
}
function TierIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 7.7l5.4-.8z"/></svg>
}
function UsersIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>
}
function PlatformIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
}
function GearIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33h.01a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51h.01a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v.01a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
}
