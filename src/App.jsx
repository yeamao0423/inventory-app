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

const allTabs = [
  { path: '/',           label: '庫存',  icon: BoxIcon },
  { path: '/orders',     label: '訂單',  icon: ReceiptIcon },
  { path: '/storefront', label: '商城',  icon: ShopIcon },
  { path: '/coupons',    label: '優惠券', icon: CouponIcon },
  { path: '/trips',      label: '行程',  icon: TripIcon, superOnly: true },
  { path: '/users',      label: '成員',  icon: UsersIcon, adminOnly: true },
]

export default function App() {
  const { user, profile, loading, isBackendUser, signOut } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  if (loading) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh' }}><img src="/logo.png" alt="Daigogo" style={{ height: 48 }} /></div>
  )
  if (location.pathname === '/invite') return <InvitePage />
  if (!user) return <LoginPage />

  // consumer 或無角色 → 無權限頁面
  if (!isBackendUser) return (
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
    if (t.superOnly) return role === 'super_admin'
    if (t.adminOnly) return role === 'super_admin' || role === 'admin'
    return true
  })

  return (
    <div className="app">
      <Routes>
        <Route path="/"           element={<InventoryPage />} />
        <Route path="/orders"     element={<OrdersPage />} />
        <Route path="/storefront" element={<StorefrontPage />} />
        <Route path="/coupons"    element={<CouponsPage />} />
        <Route path="/trips"      element={<TripsPage />} />
        <Route path="/users"      element={<UsersPage />} />
        <Route path="/invite"     element={<InvitePage />} />
      </Routes>

      <nav className="tabbar">
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
function UsersIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>
}
