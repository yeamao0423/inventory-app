// 會員匯入解析層（純函式，供 vitest 測試）
// 不依賴第三方 CSV 套件：自帶可處理「引號內逗號」的解析器。
// 對應 docs/member-tiers-plan.md §2 / §13。

// email 正規化：與 DB 的 normalize_email = lower(trim()) 一致
export function normalizeEmail(s) {
  return String(s ?? '').trim().toLowerCase()
}

// 金額：去除 "NT$"、千分位逗號與空白；空值 → 0
export function parseAmount(s) {
  if (s === null || s === undefined) return 0
  const cleaned = String(s).replace(/[^0-9.\-]/g, '')
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return 0
  const n = parseFloat(cleaned)
  return Number.isFinite(n) ? n : 0
}

// 整數（訂單數）：空/非數 → 0
export function parseCount(s) {
  const n = parseInt(String(s ?? '').replace(/[^0-9\-]/g, ''), 10)
  return Number.isFinite(n) ? n : 0
}

// Y/N → boolean；其他 → null
export function parseYN(s) {
  const v = String(s ?? '').trim().toUpperCase()
  if (v === 'Y') return true
  if (v === 'N') return false
  return null
}

// "2026-06-05 11:37:39" → "2026-06-05T11:37:39"（timestamptz 可解析）；空 → null
export function parseDate(s) {
  const v = String(s ?? '').trim()
  if (!v) return null
  return v.replace(' ', 'T')
}

// 最小 CSV 解析器：支援引號欄位、引號內逗號、"" 轉義、\r\n
// 回傳 string[][]（每列為 cell 陣列）
export function parseCSV(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  const src = String(text ?? '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field); field = ''
    } else if (ch === '\n') {
      row.push(field); rows.push(row); row = []; field = ''
    } else if (ch === '\r') {
      // 略過，交由 \n 收尾
    } else {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  // 去掉全空白列
  return rows.filter(r => r.some(c => c.trim() !== ''))
}

// 各欄位的候選表頭名稱（中／英、不分大小寫）。
// Shopline 切換介面語言時表頭會跟著變，故每個邏輯欄都列多個別名。
const HEADER_ALIASES = {
  id:     ['顧客 ID', '顧客id', 'customer id', 'customer_id', 'id'],
  name:   ['全名', '姓名', 'name', 'full name', 'customer name'],
  email:  ['電郵', '電子郵件', 'email', 'e-mail'],
  join:   ['加入日期', '註冊日期', 'created at', 'registration date', 'subscription date', 'member since', 'join date'],
  orders: ['訂單數', '訂單數量', 'order count', 'orders', 'number of orders', 'total orders'],
  amount: ['累積金額', '累計消費', 'total spending', 'total spent', 'accumulated amount', 'total amount'],
  member: ['會員', 'member', 'is member'],
  mkt:    ['接受電郵優惠宣傳', '接受行銷', 'accepts marketing', 'subscribed', 'email marketing'],
  phone:  ['會員綁定手機號碼', '手機號碼', '電話', 'phone', 'mobile', 'phone number'],
}

// 值看起來像 email（含 @ 與點）→ 用來在表頭比對失敗時偵測 email 欄。
const looksLikeEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s ?? '').trim())

// 將 Shopline 客戶報表 CSV 文字 → 乾淨的 import_members rows
// 依表頭名稱對應欄位（容忍欄位順序變動、中英表頭、大小寫）；只保留「會員 = Y」且有 email 者。
export function mapShoplineRows(text) {
  const grid = parseCSV(text)
  if (grid.length === 0) return { rows: [], total: 0, imported: 0, skipped: 0 }

  const header = grid[0].map(h => h.trim().toLowerCase())
  // 在表頭中找出第一個命中任一別名的欄位 index；找不到回 -1
  const at = (key) => {
    for (const alias of HEADER_ALIASES[key]) {
      const i = header.indexOf(alias.toLowerCase())
      if (i >= 0) return i
    }
    return -1
  }
  const col = {
    id: at('id'),
    name: at('name'),
    email: at('email'),
    join: at('join'),
    orders: at('orders'),
    amount: at('amount'),
    member: at('member'),
    mkt: at('mkt'),
    phone: at('phone'),
  }

  // 保險：表頭沒對到 email 欄時，掃描資料列，挑「像 email 的值」比例最高的欄。
  if (col.email < 0) {
    const sample = grid.slice(1, 51)        // 取前 50 列估算即可
    let best = -1, bestHits = 0
    const width = Math.max(...grid.map(r => r.length))
    for (let c = 0; c < width; c++) {
      const hits = sample.reduce((n, r) => n + (looksLikeEmail(r[c]) ? 1 : 0), 0)
      if (hits > bestHits) { bestHits = hits; best = c }
    }
    if (bestHits > 0) col.email = best
  }

  const hasMemberCol = col.member >= 0
  const rows = []
  let skipped = 0
  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r]
    const get = (i) => (i >= 0 && i < cells.length ? cells[i].trim() : '')
    const email = normalizeEmail(get(col.email))
    // 有「會員」欄時只收 會員=Y（決策：只匯入已註冊會員）；
    // 表頭沒有會員欄時不做此過濾（仍需有 email），避免整批被略過。
    const memberOk = !hasMemberCol || parseYN(get(col.member)) === true
    if (!memberOk || !email) { skipped++; continue }
    rows.push({
      source: 'shopline',
      external_id: get(col.id) || null,
      email,
      name: get(col.name) || null,
      phone: get(col.phone) || null,
      registered_at: parseDate(get(col.join)),
      imported_amount: parseAmount(get(col.amount)),
      imported_orders: parseCount(get(col.orders)),
      accepts_marketing: parseYN(get(col.mkt)),
    })
  }
  return { rows, total: grid.length - 1, imported: rows.length, skipped }
}
