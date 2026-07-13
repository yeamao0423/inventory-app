import { Link } from 'react-router-dom'
import { PLATFORM_NAME } from './MarketingLayout'

// 依台灣現行法規（2026）整理，分三層呈現。資料經多來源官方查證，
// 來源見頁尾。若法規調整，更新此陣列即可。
const TIERS = [
  {
    key: 'banned',
    tone: 'red',
    badge: '絕對禁止',
    title: '一律無法代購',
    desc: '不論金額、數量或用途，這些商品在台灣完全禁止輸入，代購沒有任何例外。',
    items: [
      {
        icon: '🥩',
        name: '肉類製品',
        note: '任何肉類一律禁止郵寄輸入，含肉鬆、肉乾、香腸、含肉零食。非洲豬瘟疫區豬肉製品最重可處 7 年徒刑併科 300 萬罰金，旅客攜帶最高罰 100 萬。',
        law: '動物傳染病防治條例 §34、§41',
      },
      {
        icon: '👜',
        name: '仿冒品、盜版品',
        note: '侵害商標、專利、著作權之物品（仿冒精品、盜版光碟／軟體）禁止輸入，無任何例外。',
        law: '關稅法 §15',
      },
      {
        icon: '💊',
        name: '毒品、管制藥品',
        note: '毒品危害防制條例所列毒品，含大麻、大麻籽，以及 THC 含量大於 10ppm 的大麻製品（部分國外 CBD 產品會踩線）。',
        law: '毒品危害防制條例 §2',
      },
      {
        icon: '🔫',
        name: '槍砲彈藥刀械',
        note: '含空氣槍、瓦斯槍、魚槍、已開鋒刀械。一般代購無主管機關許可，不得經手。',
        law: '槍砲彈藥刀械管制條例 §4',
      },
      {
        icon: '💵',
        name: '偽造變造貨幣、有價證券',
        note: '偽變造之貨幣、有價證券及印製偽幣之印模一律禁止進口。',
        law: '關稅法 §15',
      },
      {
        icon: '🌱',
        name: '植物、種子、水果',
        note: '檢疫物原則上不得以郵寄方式輸入，除非收件人事先取得檢疫機關核准。違者退運或銷燬。',
        law: '植物防疫檢疫法 §17',
      },
    ],
  },
  {
    key: 'permit',
    tone: 'amber',
    badge: '須主管機關許可',
    title: '本平台恕不代購',
    desc: '這些商品須事先取得許可證或查驗才能合法輸入，沒有許可即屬違法，其中部分還會觸發走私罰則。本平台一律不代購。',
    items: [
      {
        icon: '💊',
        name: '藥品、醫療器材',
        note: '人用藥品、管制藥品、醫療器材（含隱形眼鏡、血壓計、體溫計）須食藥署查驗。未經許可輸入偽禁藥、醫材另依海關緝私條例以走私論處。',
        law: '藥事法／海關緝私條例',
      },
      {
        icon: '📡',
        name: '含藍牙／WiFi 電子產品',
        note: '電信管制射頻器材須經 NCC 審驗，含藍牙耳機、智慧手錶、路由器等具無線傳輸功能的產品。',
        law: 'NCC 電信管理法',
      },
      {
        icon: '🚬',
        name: '菸品、酒類',
        note: '私菸、私酒視同走私品，除違反菸酒管理法外另依海關緝私條例處罰。',
        law: '菸酒管理法／海關緝私條例',
      },
      {
        icon: '🐘',
        name: '保育類野生動植物',
        note: 'CITES 物種及其產製品，如象牙、皮草、沉香、燕窩、魚子醬，須輸出國許可證，商業輸入限制嚴格。',
        law: '野生動物保育法／CITES',
      },
      {
        icon: '🧪',
        name: '農藥、動物用藥、毒化物',
        note: '農藥、動物用藥品、毒性化學物質須對應主管機關許可，未經許可輸入依法退運或沒入銷燬。',
        law: '農藥管理法等',
      },
    ],
  },
  {
    key: 'conditional',
    tone: 'blue',
    badge: '有條件',
    title: '下單前請先詢問',
    desc: '這些商品在符合自用限量或取得查驗下可能可以輸入，但規定複雜、數量有上限。想代購請先與我們確認。',
    items: [
      {
        icon: '💊',
        name: '錠狀／膠囊食品、健康食品',
        note: '自用有數量上限（如錠狀膠囊食品每種 12 瓶、合計 36 瓶），超量須申請查驗。',
        law: '食品安全衛生管理法',
      },
      {
        icon: '💄',
        name: '特定用途化粧品',
        note: '含防曬、美白、染髮等特定用途成分之化粧品須符合食藥署輸入規定。',
        law: '化粧品衛生安全管理法',
      },
      {
        icon: '🇨🇳',
        name: '中國大陸商品',
        note: '部分大陸物品列為不准輸入或有條件輸入，須另查大陸物品輸入規定。',
        law: '大陸物品輸入規定',
      },
    ],
  },
]

export default function ProhibitedItemsPage() {
  return (
    <>
      {/* Hero */}
      <section className="mkt-section mkt-hero" style={{ paddingBottom: 'clamp(24px, 4vw, 40px)' }}>
        <div className="mkt-container">
          <span className="mkt-eyebrow">代購前必看</span>
          <h1 className="mkt-h1" style={{ maxWidth: '20ch' }}>
            哪些商品<span className="accent">無法代購</span>？
          </h1>
          <p className="mkt-lead" style={{ maxWidth: '46ch' }}>
            財政部關務署明訂：透過代購的商品同樣受輸入規定限制，並非什麼都能寄進台灣。
            為保障你我雙方，{PLATFORM_NAME} 不經手以下商品。
          </p>
        </div>
      </section>

      {/* 三層分級 */}
      <section className="mkt-section" style={{ paddingTop: 0 }}>
        <div className="mkt-container">
          {TIERS.map(tier => (
            <div className={`pi-tier pi-${tier.tone}`} key={tier.key}>
              <div className="pi-tier-head">
                <span className="pi-tier-badge">{tier.badge}</span>
                <h2 className="pi-tier-title">{tier.title}</h2>
                <p className="pi-tier-desc">{tier.desc}</p>
              </div>
              <div className="pi-grid">
                {tier.items.map(item => (
                  <div className="pi-card" key={item.name}>
                    <div className="pi-card-top">
                      <span className="pi-card-icon">{item.icon}</span>
                      <span className="pi-card-name">{item.name}</span>
                    </div>
                    <p className="pi-card-note">{item.note}</p>
                    <span className="pi-card-law">{item.law}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 免責與來源 */}
      <section className="mkt-section" style={{ paddingTop: 0 }}>
        <div className="mkt-container">
          <div className="pi-disclaimer">
            <h3>提醒與資料來源</h3>
            <ul>
              <li>本頁依台灣現行法規（2026）整理，僅供參考；實際輸入規定以各主管機關公告為準。</li>
              <li>以拆單方式壓低單票金額規避稅負屬違規行為，海關得合併計算完稅價格並依海關緝私條例處罰。</li>
              <li>非洲豬瘟疫區國家清單持續調整，最新名單請查
                <a href="https://asf.aphia.gov.tw/" target="_blank" rel="noopener noreferrer">農業部防檢署專區</a>。
              </li>
              <li>主要來源：
                <a href="https://web.customs.gov.tw/" target="_blank" rel="noopener noreferrer">財政部關務署</a>、
                <a href="https://law.moj.gov.tw/" target="_blank" rel="noopener noreferrer">全國法規資料庫</a>、
                農業部動植物防疫檢疫署、衛福部食藥署、NCC。
              </li>
            </ul>
            <p className="pi-help">不確定想代購的商品是否可行？<Link to="/contact">與我們聯絡</Link>，我們會協助你確認。</p>
          </div>
        </div>
      </section>
    </>
  )
}
