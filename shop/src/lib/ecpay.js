// ════════════════════════════════════════════════════════════════
// 綠界 ECPay 金流＋物流 共用工具
// - CheckMacValue：金流用 SHA256、物流整合 API 用 MD5（流程相同，只差雜湊）
// - 多租戶：金鑰不再讀環境變數，改由呼叫端傳入某店的 store_ecpay_secrets
//   一列，用 makeEcpayConfig(secrets) 組出該店專屬的設定物件；
//   stage 時 secrets 為 null／欄位缺漏會 fallback 到綠界公開測試金鑰（特店 2000132），
//   production 則絕不 fallback——金流欄位缺就 throw，物流欄位缺則延後檢查
//   （cfg.logisticsReady=false，見 makeEcpayConfig 與 logisticsUnavailableMessage 註解）。
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

// 正式環境的金流必填欄位——這是 config 的核心，缺一不可、絕不 fallback，缺就 throw。
const REQUIRED_PAYMENT_FIELDS = [
  ['merchant_id', '金流特店編號'],
  ['hash_key', '金流 HashKey'],
  ['hash_iv', '金流 HashIV'],
]

// 正式環境的物流必填欄位——金流與物流在綠界是**分開申請**的，
// 「只申請了金流、還沒申請物流」是完全合理的狀態，所以缺這三欄不 throw（否則連刷卡都被擋），
// 改成延後檢查：config 照樣建出來，物流欄位留 null 並標記 logisticsReady=false，
// 由物流路由進入時自己擋（見 logisticsUnavailableMessage）。
const REQUIRED_LOGISTICS_FIELDS = [
  ['logistics_merchant_id', '物流特店編號'],
  ['logistics_hash_key', '物流 HashKey'],
  ['logistics_hash_iv', '物流 HashIV'],
]

/**
 * 依某店的金鑰列組出綠界設定。
 * secrets 為 store_ecpay_secrets 的一列。
 *
 * env='stage'（含未設定、未知值）：欄位留白時 fallback 到綠界**公開**測試金鑰
 * （特店 2000132 / 物流 2000933）——那正是測試金鑰的用途，logisticsReady 恆為 true。
 *
 * env='production'：**不做任何 fallback**。
 *   - 金流三欄缺任一 → 直接 throw（這個 config 的核心用途就是金流）。
 *   - 物流三欄缺任一 → 不 throw，物流欄位一律留 null、logisticsReady=false、
 *     logisticsMissing 列出缺哪幾欄，讓只申請金流的店家照樣能刷卡。
 *
 * 為什麼 production 絕不 fallback：那組測試金鑰是綠界公開文件上的值，正式環境若用它驗章，
 * 任何人都能自算 CheckMacValue 偽造一封「付款成功」通知白拿商品（物流那半邊則可偽造取件成功）。
 * 寧可整支路由失敗，也不要用公開金鑰在收真錢。
 */
export function makeEcpayConfig(secrets) {
  const env = secrets?.env === 'production' ? 'production' : 'stage'

  if (env === 'production') {
    const missingPayment = REQUIRED_PAYMENT_FIELDS
      .filter(([col]) => !secrets?.[col])
      .map(([, label]) => label)
    if (missingPayment.length) {
      throw new Error(
        `此店家的綠界正式環境金流金鑰不完整，缺少：${missingPayment.join('、')}。` +
        '正式環境不會退回綠界公開測試金鑰，請補齊後再試。'
      )
    }

    const logisticsMissing = REQUIRED_LOGISTICS_FIELDS
      .filter(([col]) => !secrets?.[col])
      .map(([, label]) => label)
    const logisticsReady = logisticsMissing.length === 0

    return {
      env,
      merchantId: secrets.merchant_id,
      hashKey: secrets.hash_key,
      hashIV: secrets.hash_iv,
      // 物流沒申請齊就一律 null——寧可讓用到的地方立刻壞掉，也不要半套金鑰算出錯的 CheckMacValue
      logisticsMerchantId: logisticsReady ? secrets.logistics_merchant_id : null,
      logisticsHashKey: logisticsReady ? secrets.logistics_hash_key : null,
      logisticsHashIV: logisticsReady ? secrets.logistics_hash_iv : null,
      logisticsReady,
      logisticsMissing,
      senderName: secrets.sender_name || '',
      senderPhone: secrets.sender_phone || '',
      codMax: Number(secrets.cod_max) || COD_MAX_DEFAULT,
      urls: URLS[env],
    }
  }

  return {
    env,
    merchantId: secrets?.merchant_id || STAGE_MERCHANT_ID,
    hashKey: secrets?.hash_key || STAGE_HASH_KEY,
    hashIV: secrets?.hash_iv || STAGE_HASH_IV,
    logisticsMerchantId: secrets?.logistics_merchant_id || STAGE_LOGISTICS_MERCHANT_ID,
    logisticsHashKey: secrets?.logistics_hash_key || STAGE_LOGISTICS_HASH_KEY,
    logisticsHashIV: secrets?.logistics_hash_iv || STAGE_LOGISTICS_HASH_IV,
    logisticsReady: true, // stage 有公開測試金鑰可用，物流永遠可測
    logisticsMissing: [],
    senderName: secrets?.sender_name || '',
    senderPhone: secrets?.sender_phone || '',
    codMax: Number(secrets?.cod_max) || COD_MAX_DEFAULT,
    urls: URLS[env],
  }
}

/**
 * 物流不可用時回一句可讀的錯誤訊息，可用時回 null。
 * 物流相關路由（logistics/create、logistics/print、logistics/notify）進來的第一件事就是問它，
 * 不要等到 genLogisticsCheckMac 拿 null 金鑰 throw 才發現。
 */
export function logisticsUnavailableMessage(cfg) {
  if (!cfg) return '此店家尚未設定綠界金鑰'
  if (cfg.logisticsReady) return null
  const missing = cfg.logisticsMissing?.length ? `（缺少：${cfg.logisticsMissing.join('、')}）` : ''
  return `此店家尚未設定綠界物流金鑰${missing}，無法使用超商取貨相關功能。` +
    '綠界金流與物流是分開申請的，請先完成物流特店申請再設定。'
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

// 超商取貨 C2C 物流里程碑代碼。
//
// ⚠️ 這張表只涵蓋兩家，而且 picked 會直接觸發貨到付款記帳（apply_cod_payment
//    把 paid_amount 補滿），判錯＝帳上多出一筆不存在的錢。改動前先看清楚哪些是查證過的：
//
//   【官方確認值】綠界「物流狀態代碼一覽表」查得到，可信：
//     2067 / 2073 / 2074 → 7-11（UNIMARTC2C）
//     3018 / 3020 / 3022 → 全家（FAMIC2C）
//
//   【未查證：關鍵字猜測】萊爾富（HILIFEC2C）與 OK（OKMARTC2C）的代碼我們手上沒有，
//     目前完全靠下面 logisticsMilestone() 的 RtnMsg 中文關鍵字後援猜。這是猜的，不是規格：
//     - 退貨流程的訊息若含「取件成功」（例如退回門市後由寄件人取件），會被誤判成 picked
//       → 一張貨退回來、一毛錢沒收到的 COD 訂單變成「完成＋已付清」。
//     - 綠界改了訊息用字，猜測就整組失效，客人取了貨系統卻沒記到錢。
//
//   【現況處置】既然關鍵字是猜的，就讓呼叫端知道它是猜的：logisticsMilestoneDetail()
//     除了里程碑之外還回 source（'code' 官方代碼／'keyword' 關鍵字猜測），
//     api/ecpay/logistics/notify 只在 source==='code' 時才呼叫 apply_cod_payment 自動記帳，
//     source==='keyword' 與判不出里程碑一律改寫 payment_alert 請店家自行確認代收。
//
//   【待辦】拿到綠界的物流狀態代碼一覽表（含萊爾富／OK）後，把四家代碼都補進這張表，
//     那時 source 自然全部變成 'code'，關鍵字後援就能整段刪掉。
const LOGISTICS_MILESTONE_CODES = {
  arrived: ['2073', '3018'],  // 商品送達門市（可取貨）— 官方確認值
  picked: ['2067', '3022'],   // 消費者取件成功 — 官方確認值
  returned: ['2074', '3020'], // 七天未取／退回門市 — 官方確認值
}

/**
 * 判斷物流狀態通知屬於哪個里程碑，並說明這個判斷是怎麼來的。
 * 回 { milestone, source }：
 *   milestone: 'arrived' | 'picked' | 'returned' | null
 *   source: 'code'（比中上面的官方確認代碼，可信）
 *         | 'keyword'（只比中 RtnMsg 中文關鍵字，是猜的——萊爾富／OK 只能靠這個）
 *         | null（判不出來）
 *
 * 為什麼要回 source：一則「退貨」通知的訊息裡若含「取件成功」字樣，關鍵字會判成 picked，
 * 貨到付款訂單就會被自動記成已付清——貨退回來了、系統卻認為錢收到了。
 * 呼叫端拿到 source 才能決定「猜的就不要自動動錢」。
 *
 * 判不出來時回 { milestone: null, source: null }——呼叫端仍會把原始 RtnCode／RtnMsg
 * 完整寫進 logistics_status／logistics_status_msg，資訊不會遺失。
 */
export function logisticsMilestoneDetail(code, msg = '') {
  const c = code != null ? String(code) : ''
  for (const [milestone, codes] of Object.entries(LOGISTICS_MILESTONE_CODES)) {
    if (codes.includes(c)) return { milestone, source: 'code' }
  }
  // ↓↓↓ 以下三行是關鍵字猜測，不是綠界規格 ↓↓↓
  const m = String(msg || '')
  if (/取件成功|取貨成功|已取貨/.test(m)) return { milestone: 'picked', source: 'keyword' }
  if (/送達門市|到店|可取貨/.test(m)) return { milestone: 'arrived', source: 'keyword' }
  if (/未取|退回|退貨|逾期/.test(m)) return { milestone: 'returned', source: 'keyword' }
  return { milestone: null, source: null }
}

/**
 * 只要里程碑、不管來源的簡便版（保留原簽名，既有呼叫端與測試不受影響）。
 * 會依判斷結果動到錢的地方請改用 logisticsMilestoneDetail() 並檢查 source。
 */
export function logisticsMilestone(code, msg = '') {
  return logisticsMilestoneDetail(code, msg).milestone
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
