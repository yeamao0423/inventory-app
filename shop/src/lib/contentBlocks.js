// 區塊內容（blocks）的 schema、驗證與正規化。純函式、零依賴。
//
// 內容的形狀固定是 { version: 1, blocks: [...] }，存在各自主體那張表的 jsonb 欄位
// （stores.home_blocks / storefront_products.intro_blocks，見 docs/adr/0005）。
//
// jsonb 沒有 schema 保護，所以「壞資料一定會出現」是前提而不是例外：
// 未知型別、缺欄位、型別不對、超長字串、惡意連結，全部要有明確且不丟例外的行為。
// 商城端的渲染器只吃 normalizeContent() 的輸出，不直接碰原始 jsonb。
//
// ⚠️ 這份檔案在商城有一份對應的副本 shop/src/lib/contentBlocks.js（Next.js 專案獨立，
//    無法跨 package 匯入）。兩份必須同步維護，就像 pricing.js 與 salePrice.js 的關係。

export const CONTENT_VERSION = 1

// 靜態區塊：內容全部來自店主輸入，首頁與商品頁都能用
// （第一版就這四種，見 docs/archive/content-blocks-plan.md）
export const BLOCK_TYPES = ['hero', 'media_text', 'text', 'products']

// 動態區塊：內容綁當前商品，只有商品頁範本能用（見 docs/archive/product-page-builder-plan.md）。
// 刻意不併進 BLOCK_TYPES —— 首頁沒有「當前商品」，讓這些型別進得了 home_blocks
// 只會得到一堆畫不出來的空殼。要放行必須明講（normalizeContent 的 allow 參數）。
export const PRODUCT_BLOCK_TYPES = [
  'product_gallery', 'product_title', 'product_price', 'product_desc',
  'product_options', 'product_status', 'product_qty', 'product_note', 'product_cta',
]

export const ALL_BLOCK_TYPES = [...BLOCK_TYPES, ...PRODUCT_BLOCK_TYPES]

export const BLOCK_LABELS = {
  hero: '主視覺',
  media_text: '圖文並排',
  text: '文字段落',
  products: '商品精選',
  product_gallery: '商品圖庫',
  product_title: '商品名稱',
  product_price: '價格',
  product_desc: '商品描述',
  product_options: '規格選擇',
  product_status: '收單／缺貨提示',
  product_qty: '數量',
  product_note: '客製備註',
  product_cta: '加入購物車',
}

// 十二欄格線的欄寬（.blk-grid，globals.css:650）。手機一律吃滿 12 欄，
// 比例只在桌機有意義 —— 與 media_text 的 imageRatio 同一個道理。
export const SPANS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
export const DEFAULT_SPAN = 12

export const GALLERY_RATIOS = ['4/5', '1/1', '3/4']
export const PRICE_SIZES = ['lg', 'md']
export const CHIP_STYLES = ['auto', 'text']

// 圖片佔的百分比。手機一律上下堆疊，比例只在桌機生效。
export const IMAGE_RATIOS = [25, 33, 50, 67, 75]
export const IMAGE_SIDES = ['left', 'right']
export const PRODUCT_MODES = ['manual', 'category']

// 上限：壞資料或手滑不該讓商城頁面被撐爆
const MAX_BLOCKS = 60
const MAX_TEXT = 5000
const MAX_PRODUCT_IDS = 24
const MAX_LIMIT = 24
const MIN_LIMIT = 1
const DEFAULT_LIMIT = 8

// ── 小工具 ────────────────────────────────

function toText(value, max = MAX_TEXT) {
  // 物件／陣列轉字串只會得到 [object Object] 這種垃圾，直接視為沒填
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value !== 'string') return ''
  return value.slice(0, max)
}

function toInt(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Math.trunc(Number(value))
  }
  return null
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback
}

// 連結白名單。區塊的 buttonHref 由店主自由輸入，直接塞進 <a href> 就是 XSS 入口。
// 只放行相對路徑、錨點與明確安全的 scheme；其餘（javascript:、data:、vbscript:、
// 協定相對的 //evil.com）一律變成空字串，渲染層看到空字串就不畫按鈕。
const SAFE_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:']
export function safeHref(value) {
  if (typeof value !== 'string') return ''
  const raw = value.trim()
  if (!raw) return ''
  // 協定相對網址（//evil.com）會繼承當前 scheme，等同外連但看起來像相對路徑 → 擋掉
  if (raw.startsWith('//')) return ''
  if (raw.startsWith('/') || raw.startsWith('#') || raw.startsWith('?')) return raw
  // scheme 判斷前先把控制字元與空白清掉：`java\tscript:` 在瀏覽器眼中仍是 javascript:
  const stripped = raw.replace(/[\u0000-\u0020\u00a0\u1680\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\ufeff]/g, '')
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(stripped)
  if (!m) return raw // 沒有 scheme 的相對路徑（如 products/1）
  return SAFE_SCHEMES.includes(m[1].toLowerCase() + ':') ? raw : ''
}

// 圖片網址：只收 http(s) 與相對路徑，避免 data: URI 之類的東西進到 <img src>
export function safeImageUrl(value) {
  const href = safeHref(value)
  if (!href) return ''
  if (/^(mailto|tel):/i.test(href)) return ''
  return href
}

// body 允許換行，但不解析 Markdown、不接受 HTML。
// 這裡只負責切段，標記字元原樣保留交給渲染層逸出（React 的 {} 內插自動逸出）。
export function splitParagraphs(body) {
  if (typeof body !== 'string') return []
  return body.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
}

// ── 各型別的正規化 ──────────────────────────
// 白名單制：只留下這裡列出的欄位，其餘（onClick、style、dangerouslySetInnerHTML…）一律丟棄。

const NORMALIZERS = {
  hero: (b) => ({
    image: safeImageUrl(b.image),
    title: toText(b.title, 200),
    subtitle: toText(b.subtitle, 400),
    buttonText: toText(b.buttonText, 60),
    buttonHref: safeHref(b.buttonHref),
  }),

  media_text: (b) => ({
    image: safeImageUrl(b.image),
    imageSide: oneOf(b.imageSide, IMAGE_SIDES, 'left'),
    imageRatio: oneOf(toInt(b.imageRatio), IMAGE_RATIOS, 50),
    title: toText(b.title, 200),
    body: toText(b.body),
  }),

  text: (b) => ({
    title: toText(b.title, 200),
    body: toText(b.body),
  }),

  products: (b) => {
    const ids = Array.isArray(b.productIds)
      ? b.productIds.map(toInt).filter(n => n != null && n > 0).slice(0, MAX_PRODUCT_IDS)
      : []
    const limit = toInt(b.limit)
    return {
      title: toText(b.title, 200),
      mode: oneOf(b.mode, PRODUCT_MODES, 'manual'),
      productIds: ids,
      categoryId: toInt(b.categoryId),
      limit: limit == null ? DEFAULT_LIMIT : Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, limit)),
    }
  },

  // 動態區塊：資料全部來自當前商品，店主只能調呈現方式。
  // 沒有任何一個欄位裝內容 —— 內容是商品本身，不是這裡。
  product_gallery: (b) => ({
    ratio: oneOf(b.ratio, GALLERY_RATIOS, '4/5'),
    thumbs: b.thumbs !== false,
  }),
  product_title: (b) => ({ showTags: b.showTags !== false }),
  product_price: (b) => ({ size: oneOf(b.size, PRICE_SIZES, 'lg') }),
  product_desc: () => ({}),
  product_options: (b) => ({ chipStyle: oneOf(b.chipStyle, CHIP_STYLES, 'auto') }),
  product_status: () => ({}),
  product_qty: (b) => ({ showStock: b.showStock !== false }),
  product_note: () => ({}),
  product_cta: (b) => ({ fullWidth: b.fullWidth !== false }),
}

// 單一區塊：型別不在放行清單就回 null（呼叫端丟掉），認識就補齊所有欄位。
function normalizeBlock(raw, index, allow) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const type = raw.type
  if (typeof type !== 'string' || !allow.includes(type)) return null
  const id = typeof raw.id === 'string' && raw.id ? raw.id : `${type}-${index}`
  // span 對每種區塊都一樣，所以在這裡補而不是散在九個 NORMALIZERS 裡。
  // 舊資料沒有這個欄位 → 落到 DEFAULT_SPAN=12 → 與加這個欄位之前的全寬行為相同。
  const span = oneOf(toInt(raw.span), SPANS, DEFAULT_SPAN)
  return { id, type, span, ...NORMALIZERS[type](raw) }
}

/**
 * 任意 jsonb → 可安全渲染的 { version, blocks } 或 null。
 * null 代表「沒編過」，商城據此走既有預設版面 —— 這與「編過但空的」是兩件事。
 * 版本號不是目前版本時（含未來版本）仍盡力正規化：未知欄位本來就會被白名單濾掉，
 * 硬擋反而讓舊版程式對新資料整頁空白。
 *
 * `allow` 預設只放行靜態區塊，首頁（home_blocks）呼叫時不必傳、行為與過去完全一致。
 * 商品頁範本要傳 ALL_BLOCK_TYPES 才拿得到 product_* 區塊。
 */
export function normalizeContent(raw, { allow = BLOCK_TYPES } = {}) {
  if (raw == null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) return null
  const list = Array.isArray(raw.blocks) ? raw.blocks : []
  const blocks = []
  for (let i = 0; i < list.length && blocks.length < MAX_BLOCKS; i++) {
    const block = normalizeBlock(list[i], i, allow)
    if (block) blocks.push(block)
  }
  return { version: CONTENT_VERSION, blocks }
}

/** 商品頁範本專用：放行動態區塊。 */
export function normalizeProductContent(raw) {
  return normalizeContent(raw, { allow: ALL_BLOCK_TYPES })
}

export function blockCount(raw, options) {
  const content = normalizeContent(raw, options)
  return content ? content.blocks.length : 0
}

export function isEmptyContent(raw, options) {
  return blockCount(raw, options) === 0
}

// ── 編輯操作（後台用，一律回新陣列，不就地改動）──────────

let idSeq = 0
function makeId(type) {
  idSeq += 1
  return `${type}-${Date.now().toString(36)}-${idSeq}`
}

const BLOCK_DEFAULTS = {
  hero: { image: '', title: '', subtitle: '', buttonText: '', buttonHref: '' },
  media_text: { image: '', imageSide: 'left', imageRatio: 50, title: '', body: '' },
  text: { title: '', body: '' },
  products: { title: '', mode: 'manual', productIds: [], categoryId: null, limit: DEFAULT_LIMIT },
  product_gallery: { ratio: '4/5', thumbs: true },
  product_title: { showTags: true },
  product_price: { size: 'lg' },
  product_desc: {},
  product_options: { chipStyle: 'auto' },
  product_status: {},
  product_qty: { showStock: true },
  product_note: {},
  product_cta: { fullWidth: true },
}

export function createBlock(type, span = DEFAULT_SPAN) {
  if (!ALL_BLOCK_TYPES.includes(type)) return null
  return {
    id: makeId(type),
    type,
    span: oneOf(toInt(span), SPANS, DEFAULT_SPAN),
    ...structuredCloneish(BLOCK_DEFAULTS[type]),
  }
}

// 不新增依賴、也不假設 structuredClone 一定存在（Node 16 / 舊 webview）
function structuredCloneish(obj) {
  return JSON.parse(JSON.stringify(obj))
}

export function moveBlock(blocks, index, dir) {
  const target = index + dir
  if (!Array.isArray(blocks) || index < 0 || index >= blocks.length) return blocks
  if (target < 0 || target >= blocks.length) return blocks
  const out = blocks.slice()
  const [item] = out.splice(index, 1)
  out.splice(target, 0, item)
  return out
}

export function duplicateBlock(blocks, index) {
  if (!Array.isArray(blocks) || !blocks[index]) return blocks
  const copy = { ...structuredCloneish(blocks[index]), id: makeId(blocks[index].type || 'block') }
  const out = blocks.slice()
  out.splice(index + 1, 0, copy)
  return out
}

export function removeBlock(blocks, index) {
  if (!Array.isArray(blocks) || !blocks[index]) return blocks
  return blocks.filter((_, i) => i !== index)
}

export function replaceBlock(blocks, index, next) {
  if (!Array.isArray(blocks) || !blocks[index]) return blocks
  return blocks.map((b, i) => (i === index ? next : b))
}

// ── 起始模板 ──────────────────────────────
// 新店首次進來是空白畫布會不知所措，給兩套一鍵填入的起點，填完店主自己改內容。

export const TEMPLATES = {
  brand: {
    label: '品牌形象型',
    hint: '主視覺 → 品牌故事 → 商品精選。適合先讓客人認識你是誰。',
    build: () => [
      { type: 'hero', title: '歡迎光臨', subtitle: '一句話說明你的店在賣什麼、為什麼值得信任', buttonText: '看看商品', buttonHref: '/products' },
      { type: 'media_text', title: '我們的故事', body: '在這裡寫下開店的緣由、選品的堅持。\n可以分成好幾行，每一行會是一段。', imageSide: 'left', imageRatio: 50 },
      { type: 'products', title: '精選商品', mode: 'manual', limit: 8 },
    ],
  },
  selling: {
    label: '賣貨型',
    hint: '主視覺 → 商品精選 → 選品理由 → 購買須知。適合直接把商品推到客人面前。',
    build: () => [
      { type: 'hero', title: '本檔主打', subtitle: '寫上這一檔的主題與截止時間', buttonText: '立即選購', buttonHref: '/products' },
      { type: 'products', title: '熱賣中', mode: 'manual', limit: 8 },
      { type: 'media_text', title: '為什麼選這些', body: '說明選品理由：價格、通路、真偽保證。', imageSide: 'right', imageRatio: 33 },
      { type: 'text', title: '購買須知', body: '出貨時間、退換貨方式、聯絡方式。\n一行一段，不需要任何排版語法。' },
    ],
  },
}

export function buildTemplate(key) {
  const tpl = TEMPLATES[key]
  if (!tpl) return null
  return { version: CONTENT_VERSION, blocks: seedBlocks(tpl.build()) }
}

// 種子物件（只寫有意義的欄位）→ 完整區塊。createBlock 補 id 與預設值，
// NORMALIZERS 把種子的值過一次白名單 —— 模板不能繞過正規化。
function seedBlocks(seeds) {
  return seeds.map((seed) => ({
    ...createBlock(seed.type, seed.span),
    ...NORMALIZERS[seed.type](seed),
  }))
}

// ── 商品頁範本 ────────────────────────────────
// 忠實重建目前寫死的商品頁版面（shop/.../ProductDetail.jsx）：
// 桌機左右各半，圖庫在左、購買動線在右。手機一律堆疊（span 在 900px 以下失效）。
//
// 現況 .detail-wrap 是 1.08fr / 1fr，十二欄的 6/6 會讓左欄窄約 4%。
// 只有主動選擇編排的店主會看到這個差異，而他們正在改版面。

const PRODUCT_TEMPLATE_SEEDS = [
  { type: 'product_gallery', span: 6 },
  { type: 'product_title', span: 6 },
  { type: 'product_price', span: 6 },
  { type: 'product_desc', span: 6 },
  { type: 'product_options', span: 6 },
  { type: 'product_status', span: 6 },
  { type: 'product_qty', span: 6 },
  { type: 'product_note', span: 6 },
  { type: 'product_cta', span: 6 },
]

/** 店主第一次進商品頁編排器時的起點。 */
export function buildProductTemplate() {
  return { version: CONTENT_VERSION, blocks: seedBlocks(PRODUCT_TEMPLATE_SEEDS) }
}

/**
 * 既有的 intro_blocks 接進範本。
 *
 * intro_blocks 今天顯示在商品詳情頁「下方」，所以接在最後、各佔滿版一列 ——
 * 這樣遷移後的視覺位置與遷移前一致。
 * 來源可能是任意 jsonb，一律先正規化（只放行靜態區塊，intro 本來就只有那四種）。
 */
export function mergeIntroIntoTemplate(template, introRaw) {
  const base = normalizeProductContent(template) ?? buildProductTemplate()
  const intro = normalizeContent(introRaw)
  if (!intro || intro.blocks.length === 0) return base
  const appended = intro.blocks.map(b => ({ ...b, id: makeId(b.type), span: DEFAULT_SPAN }))
  return {
    version: CONTENT_VERSION,
    blocks: [...base.blocks, ...appended].slice(0, MAX_BLOCKS),
  }
}

/**
 * 商品頁要畫哪一份內容。
 *
 * 覆寫 → 範本 → null（走現有的 ProductDetail，原封不動）。
 * 「編過但清空」（空陣列）與「沒編過」（null）是兩件事：前者是店主刻意要空版面，
 * 不該偷偷 fallback 回範本。所以這裡比對的是 normalize 後是不是 null，而非長度。
 */
export function resolveProductContent({ override, template }) {
  const fromOverride = normalizeProductContent(override)
  if (fromOverride) return fromOverride
  return normalizeProductContent(template)
}
