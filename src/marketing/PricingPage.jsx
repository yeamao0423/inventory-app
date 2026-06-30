import { Link } from 'react-router-dom'

export default function PricingPage() {
  return (
    <section className="mkt-section">
      <div className="mkt-container mkt-center-wrap">
        <span className="mkt-soon-badge">COMING SOON</span>
        <h1 className="mkt-section-title">方案定價即將公布</h1>
        <p className="mkt-section-sub" style={{ marginBottom: 28 }}>
          我們正在規劃最適合代購業者的方案。在那之前，歡迎先與我們聯絡，
          或直接登入後台開始試用。
        </p>
        <div className="mkt-cta-row">
          <Link to="/contact" className="mkt-btn-primary">與我們聯絡</Link>
          <Link to="/login" className="mkt-btn-ghost">廠商登入</Link>
        </div>
      </div>
    </section>
  )
}
