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

// 將 Shopline 客戶報表 CSV 文字 → 乾淨的 import_members rows
// 依表頭名稱對應欄位（容忍欄位順序變動）；只保留「會員 = Y」且有 email 者。
export function mapShoplineRows(text) {
  const grid = parseCSV(text)
  if (grid.length === 0) return { rows: [], total: 0, imported: 0, skipped: 0 }

  const header = grid[0].map(h => h.trim())
  const at = (name) => header.indexOf(name)
  const col = {
    id: at('顧客 ID'),
    name: at('全名'),
    email: at('電郵'),
    join: at('加入日期'),
    orders: at('訂單數'),
    amount: at('累積金額'),
    member: at('會員'),
    mkt: at('接受電郵優惠宣傳'),
    phone: at('會員綁定手機號碼'),
  }

  const rows = []
  let skipped = 0
  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r]
    const get = (i) => (i >= 0 && i < cells.length ? cells[i].trim() : '')
    const email = normalizeEmail(get(col.email))
    const isMember = parseYN(get(col.member))
    // 會員=N（訪客）或無 email → 略過（決策：只匯入已註冊會員）
    if (isMember !== true || !email) { skipped++; continue }
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
