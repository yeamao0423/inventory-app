import { Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from './hooks/useAuth'
import LoginPage from './pages/LoginPage'
import InventoryPage from './pages/InventoryPage'
import OrdersPage from './pages/OrdersPage'
import PaymentsPage from './pages/PaymentsPage'
import RatePage from './pages/RatePage'
import StorefrontPage from './pages/StorefrontPage'
import UsersPage from './pages/UsersPage'
import InvitePage from './pages/InvitePage'

const allTabs = [
  { path: '/',           label: '庫存',  icon: BoxIcon },
  { path: '/orders',     label: '訂單',  icon: ReceiptIcon },
  { path: '/payments',   label: '尾款',  icon: CashIcon },
  { path: '/storefront', label: '商城',  icon: ShopIcon },
  { path: '/rate',       label: '匯率',  icon: RateIcon },
  { path: '/users',      label: '成員',  icon: UsersIcon, adminOnly: true },
]

export default function App() {
  const { user, profile, loading } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  if (loading) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh', fontSize:28 }}>📦</div>
  )
  if (location.pathname === '/invite') return <InvitePage />
  if (!user) return <LoginPage />

  const tabs = allTabs.filter(t => !t.adminOnly || profile?.role === 'super_admin' || profile?.role === 'admin')

  return (
    <div className="app">
      <Routes>
        <Route path="/"           element={<InventoryPage />} />
        <Route path="/orders"     element={<OrdersPage />} />
        <Route path="/payments"   element={<PaymentsPage />} />
        <Route path="/storefront" element={<StorefrontPage />} />
        <Route path="/rate"       element={<RatePage />} />
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
function CashIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M12 12m-2 0a2 2 0 104 0 2 2 0 10-4 0M6 12h.01M18 12h.01"/></svg>
}
function ShopIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l1-5h16l1 5"/><path d="M3 9a2 2 0 004 0 2 2 0 004 0 2 2 0 004 0 2 2 0 004 0M5 20h14a1 1 0 001-1v-7H4v7a1 1 0 001 1z"/></svg>
}
function RateIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/><circle cx="12" cy="12" r="4"/></svg>
}
function UsersIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>
}
