import { Link } from 'react-router-dom'
import { PLATFORM_NAME } from './MarketingLayout'

const FEATURES = [
  {
    icon: '🏪',
    title: '專屬品牌商城',
    desc: '每位商家擁有獨立網域的線上商城，消費者直接瀏覽、下單、追蹤物流。',
    points: ['獨立網域 yourstore.com', '中英雙語自動切換', 'SEO 友善＋社群分享預覽'],
  },
  {
    icon: '📦',
    title: '商品與庫存管理',
    desc: '從建檔到上架一氣呵成，庫存異動自動記錄、低庫存即時提醒。',
    points: ['多幣別成本換算（台幣、日韓泰越印尼等亞洲幣別＋美元歐元）', '規格變體自動產生', '多圖上傳自動壓縮'],
  },
  {
    icon: '⏱️',
    title: '兩種銷售模式',
    desc: '現貨即時扣庫存；限時收單開放預購，截止後統一採購——代購業者的核心賣法。',
    points: ['現貨模式：售完自動下架', '限時收單：設截止時間預購', '先收單、再採購、回來出貨'],
  },
  {
    icon: '📋',
    title: '訂單管理',
    desc: '商城訂單即時進後台，LINE／電話接的單也能手動建立，集中處理不漏單。',
    points: ['狀態流：待確認→已出貨→完成', '各環節自動 Email 通知', '一鍵列印出貨單'],
  },
  {
    icon: '✈️',
    title: '採購批次與行程',
    desc: '追蹤每趟採購的下單 vs 實收，跨批次自動算代墊，出差費用精準拆分到每件商品。',
    points: ['多幣別採購成本換算', '成員代墊自動對帳', '行程費用拆分至商品成本'],
  },
  {
    icon: '💳',
    title: '金流 · 會員 · 優惠券',
    desc: '串接綠界金流物流，搭配會員分級與優惠券，刺激消費、回饋 VIP。',
    points: ['信用卡／超商／貨到付款', '會員等級獨立經營', '通用碼與一次性專屬碼'],
  },
]

export default function LandingPage() {
  return (
    <>
      {/* Hero */}
      <section className="mkt-section mkt-hero">
        <div className="mkt-container">
          <span className="mkt-eyebrow">給代購業者的一站式開店平台</span>
          <h1 className="mkt-h1">
            開店、管貨、接單、出貨，<br /><span className="accent">一個平台搞定</span>
          </h1>
          <p className="mkt-lead">
            不用再用 Excel 記庫存、LINE 接單、手動算帳。
            {PLATFORM_NAME} 幫你把整條代購生意串在一起，你只要專注選品和賣貨。
          </p>
          <div className="mkt-cta-row">
            <Link to="/login" className="mkt-btn-primary">廠商登入</Link>
            <a href="#features" className="mkt-btn-ghost">了解功能</a>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="mkt-section" id="features">
        <div className="mkt-container">
          <div className="mkt-section-head">
            <h2 className="mkt-section-title">一站搞定代購生意的每個環節</h2>
            <p className="mkt-section-sub">
              從商城前台到後台管理，從採購批次到金流會員——你需要的工具都在這裡。
            </p>
          </div>
          <div className="mkt-features">
            {FEATURES.map(f => (
              <div className="mkt-card" key={f.title}>
                <div className="mkt-card-icon">{f.icon}</div>
                <h3 className="mkt-card-title">{f.title}</h3>
                <p className="mkt-card-desc">{f.desc}</p>
                <ul className="mkt-card-list">
                  {f.points.map(p => <li key={p}>{p}</li>)}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 底部 CTA */}
      <section className="mkt-section" style={{ paddingTop: 0 }}>
        <div className="mkt-container">
          <div className="mkt-cta-band">
            <h2>準備好開始你的代購事業了嗎？</h2>
            <p>登入後台即可開始管理你的商店；想了解方案請看定價或與我們聯絡。</p>
            <Link to="/login" className="mkt-btn-light">廠商登入</Link>
          </div>
        </div>
      </section>
    </>
  )
}
