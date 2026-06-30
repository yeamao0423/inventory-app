import { Link, NavLink, Outlet } from 'react-router-dom'
import './marketing.css'

// 平台品牌（要改名改這一行即可）
export const PLATFORM_NAME = 'LikeDaigo'
export const PLATFORM_TAGLINE = '代購電商管理平台'

export default function MarketingLayout() {
  const year = new Date().getFullYear()
  return (
    <div className="mkt">
      <header className="mkt-nav">
        <Link to="/" className="mkt-brand">
          <span className="mkt-brand-mark">📦</span>{PLATFORM_NAME}
        </Link>
        <nav className="mkt-nav-links">
          <NavLink to="/" end className="mkt-link">首頁</NavLink>
          <a href="/#features" className="mkt-link">功能</a>
          <NavLink to="/pricing" className="mkt-link">定價</NavLink>
          <NavLink to="/contact" className="mkt-link">聯絡我們</NavLink>
        </nav>
        <Link to="/login" className="mkt-login-btn">廠商登入</Link>
      </header>

      <main className="mkt-main">
        <Outlet />
      </main>

      <footer className="mkt-footer">
        <div>© {year} {PLATFORM_NAME}．{PLATFORM_TAGLINE}</div>
        <div className="mkt-footer-links">
          <Link to="/pricing">定價</Link>
          <Link to="/contact">聯絡我們</Link>
          <Link to="/login">廠商登入</Link>
        </div>
      </footer>
    </div>
  )
}
