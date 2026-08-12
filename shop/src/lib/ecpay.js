// ════════════════════════════════════════════════════════════════
// 綠界 ECPay 金流＋物流 共用工具
// - CheckMacValue：金流用 SHA256、物流整合 API 用 MD5（流程相同，只差雜湊）
// - 多租戶：金鑰不再讀環境變數，改由呼叫端傳入某店的 store_ecpay_secrets
//   一列，用 makeEcpayConfig(secrets) 組出該店專屬的設定物件；
//   secrets 為 null／欄位缺漏時 fallback 到綠界公開測試金鑰（特店 2000132）。
// ════════════════════════════════════════════════════════════════
import crypto from 'crypto'

// 綠界公開測試金鑰（金流）
const STAGE_MERCHANT_ID = '2000132'
const STAGE_HASH_KEY = '5294y06JbISpM5x9'
const STAGE_HASH_IV = 'v77hoKGq4kWxNNIS'

// 綠界公開測試金鑰（物流 C2C 超商取貨專屬測試特店，與金流/B2C 不同）
const STAGE_LOGISTICS_MERCHANT_ID = '2000933'
const STAGE_LOGISTICS_HASH_KEY = 'XBERn1YOvpM9nfZc'
const STAGE_LOGISTICS_HASH_IV = 'h1ONHk4P4yqbl5LK'

const LOGI_STAGE = 'https://logistics-stage.ecpay.com.tw'
const LOGI_PROD = 'https://logistics.ecpay.com.tw'

const URLS = {
  stage: {
    aio: 'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5',
    queryTrade: 'https://payment-stage.ecpay.com.tw/Cashier/QueryTradeInfo/V5',
    logisticsMap: `${LOGI_STAGE}/Express/map`,
    logisticsCreate: `${LOGI_STAGE}/Express/Create`,
    printBase: LOGI_STAGE,
  },
  production: {
    aio: 'https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5',
    queryTrade: 'https://payment.ecpay.com.tw/Cashier/QueryTradeInfo/V5',
    logisticsMap: `${LOGI_PROD}/Express/map`,
    logisticsCreate: `${LOGI_PROD}/Express/Create`,
    printBase: LOGI_PROD,
  },
}

// 各 C2C 超商列印託運單/繳款單的 API 路徑
const PRINT_PATHS = {
  UNIMARTC2C: '/Express/PrintUniMartC2COrderInfo',
  FAMIC2C: '/Express/PrintFAMIC2COrderInfo',
  HILIFEC2C: '/Express/PrintHILIFEC2COrderInfo',
  OKMARTC2C: '/Express/PrintOKMARTC2COrderInfo',
}

/** 取得指定超商子類型的列印 API 網址 */
export function getPrintUrl(subtype, cfg) {
  const path = PRINT_PATHS[subtype]
  if (!path) return null
  return `${cfg.urls.printBase}${path}`
}

/**
 * 依某店的金鑰列組出綠界設定。
 * secrets 為 store_ecpay_secrets 的一列；null/未設定時 fallback 到綠界公開測試金鑰。
 */
export function makeEcpayConfig(secrets) {
  const env = secrets?.env === 'production' ? 'production' : 'stage'
  return {
    env,
    merchantId: secrets?.merchant_id || STAGE_MERCHANT_ID,
    hashKey: secrets?.hash_key || STAGE_HASH_KEY,
    hashIV: secrets?.hash_iv || STAGE_HASH_IV,
    logisticsMerchantId: secrets?.logistics_merchant_id || STAGE_LOGISTICS_MERCHANT_ID,
    logisticsHashKey: secrets?.logistics_hash_key || STAGE_LOGISTICS_HASH_KEY,
    logisticsHashIV: secrets?.logistics_hash_iv || STAGE_LOGISTICS_HASH_IV,
    senderName: secrets?.sender_name || '',
    senderPhone: secrets?.sender_phone || '',
    codMax: Number(secrets?.cod_max) || COD_MAX_DEFAULT,
    urls: URLS[env],
  }
}

export const CVS_SUBTYPES = ['UNIMARTC2C', 'FAMIC2C', 'HILIFEC2C', 'OKMARTC2C']
export const COD_MAX_DEFAULT = 20000

// 綠界專用 URLEncode（.NET HttpUtility.UrlEncode 相容）
// .NET HttpUtility.UrlEncode 的安全字元集是 A-Za-z0-9 - _ . ! * ( )，空白轉 +，
// 其餘一律 percent-encode 成小寫十六進位。
// encodeURIComponent 已把 - _ . ! * ( ) 留為原樣，故僅需處理空白與小寫；
// 其餘還原規則保留以對齊官方 URLEncode 轉換表。
// 但 encodeURIComponent 的安全字元集比 .NET 多了 ~ 與 '，這兩個字元不會被
// encodeURIComponent 編碼，卻會被綠界端的 .NET UrlEncode 編碼——兩邊算出的
// CheckMacValue 因此不同，商品名/收件人姓名帶撇號或波浪號就會導致驗證失敗，
// 所以要手動補這兩個字元的編碼（小寫十六進位，對齊 .toLowerCase() 後的結果）。
function ecpayUrlEncode(str) {
  return encodeURIComponent(str)
    .toLowerCase()
    .replace(/%20/g, '+')
    .replace(/%2d/g, '-')
    .replace(/%5f/g, '_')
    .replace(/%2e/g, '.')
    .replace(/%21/g, '!')
    .replace(/%2a/g, '*')
    .replace(/%28/g, '(')
    .replace(/%29/g, ')')
    .replace(/~/g, '%7e')
    .replace(/'/g, '%27')
}

/**
 * 產生 CheckMacValue
 * @param {Object} params 要送出的參數（不含 CheckMacValue）
 * @param {Object} opts
 * @param {string} opts.hashKey 該店的 HashKey（必填）
 * @param {string} opts.hashIV  該店的 HashIV（必填）
 * @param {'sha256'|'md5'} opts.algo 金流 sha256 / 物流 md5
 */
export function genCheckMacValue(params, opts = {}) {
  const { hashKey, hashIV, algo = 'sha256' } = opts
  if (!hashKey || !hashIV) throw new Error('genCheckMacValue 需要 hashKey 與 hashIV')

  const sorted = Object.keys(params)
    .filter((k) => k !== 'CheckMacValue' && params[k] !== undefined && params[k] !== null)
    .sort((a, b) => {
      const la = a.toLowerCase()
      const lb = b.toLowerCase()
      return la < lb ? -1 : la > lb ? 1 : 0
    })
    .map((k) => `${k}=${params[k]}`)
    .join('&')

  const raw = `HashKey=${hashKey}&${sorted}&HashIV=${hashIV}`
  const encoded = ecpayUrlEncode(raw)
  return crypto.createHash(algo).update(encoded).digest('hex').toUpperCase()
}

/** 驗證綠界回傳通知的 CheckMacValue（重算後比對，不分大小寫） */
export function verifyCheckMacValue(params, opts = {}) {
  const received = params.CheckMacValue
  if (!received) return false
  const calc = genCheckMacValue(params, opts)
  return String(received).toUpperCase() === calc
}

/** 金流用：sha256 */
export function genPaymentCheckMac(params, cfg) {
  return genCheckMacValue(params, { hashKey: cfg.hashKey, hashIV: cfg.hashIV, algo: 'sha256' })
}

/** 物流用：md5（物流金鑰與金流不同，是綠界另外申請的一組） */
export function genLogisticsCheckMac(params, cfg) {
  return genCheckMacValue(params, { hashKey: cfg.logisticsHashKey, hashIV: cfg.logisticsHashIV, algo: 'md5' })
}

/** 綠界要求的日期格式 yyyy/MM/dd HH:mm:ss */
export function formatEcpayDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  )
}

// 兩碼 base36 隨機，避免同一訂單同一秒重複發起付款時撞號
function rand2() {
  return Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0')
}

/**
 * 產生唯一的綠界交易編號 MerchantTradeNo（<=20、英數）
 * 規則：DG + base36(orderId) + base36(seconds) + 兩碼隨機 → 不重複、可回查
 */
export function genMerchantTradeNo(orderId, now = Date.now(), rand = rand2()) {
  const oid = Number(orderId).toString(36).toUpperCase()
  const ts = Math.floor(now / 1000).toString(36).toUpperCase()
  return `DG${oid}T${ts}${rand}`.slice(0, 20)
}

/** 物流單號（與金流交易編號分開命名空間，<=20、英數） */
export function genLogisticsTradeNo(orderId, now = Date.now(), rand = rand2()) {
  const oid = Number(orderId).toString(36).toUpperCase()
  const ts = Math.floor(now / 1000).toString(36).toUpperCase()
  return `L${oid}T${ts}${rand}`.slice(0, 20)
}

// 超商取貨 C2C 物流里程碑代碼（綠界物流狀態代碼一覽表）
// 7-11 / 全家 為官方文件確認值；萊爾富(HILIFE)/OK 代碼以 RtnMsg 關鍵字後援判斷。
const LOGISTICS_MILESTONE_CODES = {
  arrived: ['2073', '3018'],  // 商品送達門市（可取貨）
  picked: ['2067', '3022'],   // 消費者取件成功
  returned: ['2074', '3020'], // 七天未取／退回門市
}

/**
 * 判斷物流狀態通知屬於哪個里程碑：'arrived' | 'picked' | 'returned' | null
 * 先比對已知代碼，未知者再以 RtnMsg 關鍵字後援（涵蓋萊爾富/OK 等）。
 */
export function logisticsMilestone(code, msg = '') {
  const c = code != null ? String(code) : ''
  for (const [milestone, codes] of Object.entries(LOGISTICS_MILESTONE_CODES)) {
    if (codes.includes(c)) return milestone
  }
  const m = String(msg || '')
  if (/取件成功|取貨成功|已取貨/.test(m)) return 'picked'
  if (/送達門市|到店|可取貨/.test(m)) return 'arrived'
  if (/未取|退回|退貨|逾期/.test(m)) return 'returned'
  return null
}

/** 解析綠界物流幕後回應："1|key=val&..." 或 "0|ErrorMessage" */
export function parseLogisticsResponse(textBody) {
  const idx = textBody.indexOf('|')
  const code = idx >= 0 ? textBody.slice(0, idx) : ''
  const body = idx >= 0 ? textBody.slice(idx + 1) : textBody
  if (code !== '1') {
    return { ok: false, error: (body || textBody).trim() }
  }
  const params = Object.fromEntries(new URLSearchParams(body))
  return { ok: true, params }
}

/** HTML escape，避免參數值破壞表單 */
function escapeHtml(v) {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * 產生「自動送出」的 HTML form（金流付款頁、電子地圖皆用 form POST 導轉）
 * @param {string} action 目標網址
 * @param {Object} params 參數（已含 CheckMacValue）
 */
export function buildAutoSubmitForm(action, params, { title = 'redirecting...' } = {}) {
  const inputs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join('')
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body onload="document.forms[0].submit()">
<form method="post" action="${escapeHtml(action)}">${inputs}</form>
</body></html>`
}
