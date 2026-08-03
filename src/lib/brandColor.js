// 品牌主色：hex 驗證、WCAG 對比度、前景色自動決定。純函式、零依賴。
//
// 店主只能選一個主色（見 docs/adr/0006：字體與完整主題都不開放）。
// 主色存在 stores.settings.brand_color，套用範圍刻意只有：
// 主要按鈕背景、連結文字、標籤／徽章、選中狀態的邊框、價格強調 —— 導覽列、背景、卡片底色一律不動。
//
// 為什麼要算對比度：店主選了淺黃色當主色時，白字按鈕會整個看不見。
// 前景色不能寫死成白色，要依主色亮度自動在黑白之間挑對比高的那個。
//
// ⚠️ 商城有一份對應副本 shop/src/lib/brandColor.js，兩份必須同步維護。

export const DEFAULT_BRAND_COLOR = '#1a1a1a'

// 白底上的文字（連結、價格強調）至少要有這個對比才看得清楚（WCAG AA 內文標準）
const AA_CONTRAST = 4.5
const FG_LIGHT = '#ffffff'
const FG_DARK = '#111111'

// 8–10 個預設色 + 自訂 hex。刻意挑深度足夠的顏色，讓多數店主不需要自己調就有合格對比。
export const BRAND_PRESETS = [
  { name: '墨黑', hex: '#1a1a1a' },
  { name: '靛藍', hex: '#0b5cd5' },
  { name: '湖水綠', hex: '#0f7b6c' },
  { name: '森林綠', hex: '#2f6b2f' },
  { name: '磚紅', hex: '#c0392b' },
  { name: '珊瑚粉', hex: '#c2185b' },
  { name: '葡萄紫', hex: '#6a3fa0' },
  { name: '琥珀棕', hex: '#8a5c00' },
  { name: '海軍藍', hex: '#1f3a63' },
]

/** 任意輸入 → '#rrggbb'（小寫）或 null。null 代表「沒設定／不合法」，呼叫端據此完全不注入樣式。 */
export function normalizeHex(value) {
  if (typeof value !== 'string') return null
  const raw = value.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return '#' + raw.toLowerCase().split('').map(c => c + c).join('')
  }
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return '#' + raw.toLowerCase()
  return null
}

function toRgb(hex) {
  const norm = normalizeHex(hex)
  if (!norm) return null
  return [
    parseInt(norm.slice(1, 3), 16),
    parseInt(norm.slice(3, 5), 16),
    parseInt(norm.slice(5, 7), 16),
  ]
}

function toHex([r, g, b]) {
  const clamp = n => Math.max(0, Math.min(255, Math.round(n)))
  return '#' + [r, g, b].map(n => clamp(n).toString(16).padStart(2, '0')).join('')
}

/** WCAG 相對亮度（0 = 黑、1 = 白） */
export function relativeLuminance(hex) {
  const rgb = toRgb(hex)
  if (!rgb) return 0
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 對比度，1（完全相同）～ 21（純黑對純白） */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

/** 主色當按鈕底色時，字要用白的還是黑的 —— 挑對比高的那個。 */
export function foregroundFor(hex) {
  if (!normalizeHex(hex)) return FG_LIGHT
  return contrastRatio(hex, FG_LIGHT) >= contrastRatio(hex, FG_DARK) ? FG_LIGHT : FG_DARK
}

/** 與白色混色，用來做徽章的淡底色。ratio = 原色佔比（0～1）。 */
export function mixWithWhite(hex, ratio) {
  const rgb = toRgb(hex)
  if (!rgb) return null
  const r = Math.max(0, Math.min(1, ratio))
  return toHex(rgb.map(v => 255 + (v - 255) * r))
}

// 白底上的文字色：主色太淺時整個壓暗，直到對白底達 AA。
// 逐步往黑色靠（每次 12%），最多 12 次；理論上最壞情況會收斂到接近黑色。
function textColorOn(hexOnWhite) {
  let rgb = toRgb(hexOnWhite)
  if (!rgb) return FG_DARK
  let current = toHex(rgb)
  for (let i = 0; i < 12 && contrastRatio(current, '#ffffff') < AA_CONTRAST; i++) {
    rgb = rgb.map(v => v * 0.88)
    current = toHex(rgb)
  }
  return contrastRatio(current, '#ffffff') >= AA_CONTRAST ? current : FG_DARK
}

/**
 * 主色 → CSS 變數組。回 null 代表沒設定，商城就一個位元組都不注入、維持既有外觀。
 *
 * --brand       主色本身：按鈕／選中邊框底色
 * --brand-fg    畫在主色上的文字色（自動黑或白）
 * --brand-text  畫在白底上的主色文字（連結、價格強調）—— 淺色主色會被壓暗到 AA
 * --brand-soft  徽章的淡底色
 */
export function brandVars(value) {
  const hex = normalizeHex(value)
  if (!hex) return null
  return {
    '--brand': hex,
    '--brand-fg': foregroundFor(hex),
    '--brand-text': textColorOn(hex),
    '--brand-soft': mixWithWhite(hex, 0.12),
  }
}

/** 變數組 → CSS 宣告字串（給 <style> 用）。沒設定時回空字串。 */
export function brandCss(value, selector = ':root') {
  const vars = brandVars(value)
  if (!vars) return ''
  const body = Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';')
  return `${selector}{${body}}`
}
