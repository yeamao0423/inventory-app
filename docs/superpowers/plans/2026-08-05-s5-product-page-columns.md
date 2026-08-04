# S5 商品頁編排欄容器版面模型 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 店主排得出「左邊一根長圖、右邊一疊資訊」這種真正的多欄商品頁，預設範本就長那樣。

**Architecture:** 在區塊樹加一層 `columns` 容器（Gutenberg 的模型），巢狀限一層。正規化與編輯操作改成能走路徑，渲染改成遞迴。舊的扁平資料完全不受影響。

**Tech Stack:** React 18 + Vite（後台編輯器）、Next.js 14（商城渲染）、vitest（後台純函式）

**Spec:** `docs/superpowers/specs/2026-08-05-s5-product-page-columns-design.md`

## Global Constraints

- 分支 `feat/product-page-columns`，在自己的 git worktree 執行。與 S1-S4 完全獨立，可同時進行。
- **`src/lib/contentBlocks.js` 與 `shop/src/lib/contentBlocks.js` 是刻意維護的副本**（Next.js 專案獨立，無法跨 package import）。這次的改動兩份都要改，**內容必須一致，只有註解可以不同**。測試只放後台那份（`src/lib` 有 vitest）。
- **`resolveProductContent` 回 `null` 就走既有的 `ProductDetail`，這是整個功能的安全閥。** 沒編排過的店在這次改動後畫面必須一模一樣。
- **首頁編排（`home_blocks`）不開放欄容器。** `BLOCK_TYPES` 不變，`columns` 只進 `PRODUCT_BLOCK_TYPES` 那一側的放行清單。首頁的 `BlocksView` 根本不吃 `span`，放進去只會得到畫不出來的空殼。
- 巢狀**限一層**：`column.blocks` 不得再有 `columns`，從正規化層根絕。
- 欄數限 **2 或 3**。
- 第一階段**不做**預覽 iframe 內的直接拖放。清單樹能拖、iframe 負責點選與高亮。
- 不新增任何依賴。拖拉沿用 HTML5 原生 drag（既有做法），不裝套件。
- **商城 dev server 在跑時不要跑 `npm run build`**。
- 本機：後台 :5173、商城 :3000。後台帳號 `owner@daigogo.dev` / `localdev123`。
- commit message 用繁體中文、簡潔，不要加 Co-Authored-By。

---

## File Structure

| 檔案 | 責任 |
|---|---|
| `src/lib/contentBlocks.js`（改） | 區塊 schema、正規化、路徑版編輯操作、範本 |
| `src/lib/contentBlocks.test.js`（改） | 上述的測試（含回歸） |
| `shop/src/lib/contentBlocks.js`（改） | 上面那支的副本，商城端用 |
| `shop/src/app/products/[id]/ProductPageView.jsx`（改） | 遞迴渲染欄容器 |
| `shop/src/app/products/[id]/product-blocks.css`（改） | 欄的格線與堆疊規則 |
| `src/components/ProductPageEditor.jsx`（改） | 兩層樹狀清單、拖進欄、刪欄的內容保全 |
| `src/components/BlockInspector.jsx`（改） | `columns` 的欄數與比例設定 |

---

### Task 1: 正規化支援欄容器（TDD）

**Files:**
- Modify: `src/lib/contentBlocks.js`
- Test: `src/lib/contentBlocks.test.js`

**Interfaces:**
- Produces:
  - `LAYOUT_BLOCK_TYPES = ['columns']`
  - `ALL_BLOCK_TYPES` 含 `'columns'`
  - `COLUMN_PRESETS`、`MIN_COLUMNS = 2`、`MAX_COLUMNS = 3`
  - 正規化後的形狀：`{ id, type: 'columns', columns: [{ id, span, blocks: [] }] }`（**沒有 `span` 欄位**）
- Task 2、3、5、6、7 都吃這個形狀。

- [ ] **Step 1: 寫失敗的測試**

在 `src/lib/contentBlocks.test.js` 的 import 加 `normalizeProductContent, ALL_BLOCK_TYPES`（若尚未 import），並加：

```js
describe('欄容器 columns', () => {
  const col = (span, blocks) => ({ span, blocks })
  const wrap = (columns) => ({ version: 1, blocks: [{ type: 'columns', columns }] })

  it('正規化保留欄與子區塊，並補上 id', () => {
    const out = normalizeProductContent(wrap([
      col(6, [{ type: 'product_gallery' }]),
      col(6, [{ type: 'product_title' }, { type: 'product_price' }]),
    ]))
    expect(out.blocks).toHaveLength(1)
    const b = out.blocks[0]
    expect(b.type).toBe('columns')
    expect(b.id).toBeTruthy()
    expect(b.columns).toHaveLength(2)
    expect(b.columns[0].span).toBe(6)
    expect(b.columns[0].id).toBeTruthy()
    expect(b.columns[1].blocks.map(x => x.type)).toEqual(['product_title', 'product_price'])
  })

  it('欄容器沒有自己的 span（一律吃滿整列）', () => {
    const b = normalizeProductContent(wrap([col(6, []), col(6, [])])).blocks[0]
    expect(b.span).toBeUndefined()
  })

  it('欄裡再放欄會被丟棄', () => {
    const b = normalizeProductContent(wrap([
      col(6, [{ type: 'columns', columns: [col(6, []), col(6, [])] }, { type: 'text', title: 'ok' }]),
      col(6, []),
    ])).blocks[0]
    expect(b.columns[0].blocks.map(x => x.type)).toEqual(['text'])
  })

  it('欄數少於 2 補到 2、多於 3 截到 3', () => {
    expect(normalizeProductContent(wrap([col(12, [])])).blocks[0].columns).toHaveLength(2)
    expect(normalizeProductContent(wrap([col(3, []), col(3, []), col(3, []), col(3, [])]))
      .blocks[0].columns).toHaveLength(3)
  })

  it('壞掉的欄變成空欄，不丟例外', () => {
    const b = normalizeProductContent({ version: 1, blocks: [
      { type: 'columns', columns: [null, 'nope', { span: 6, blocks: 'x' }] },
    ] }).blocks[0]
    expect(b.columns).toHaveLength(3)
    b.columns.forEach(c => expect(c.blocks).toEqual([]))
  })

  it('columns 不是陣列時整塊丟棄', () => {
    expect(normalizeProductContent({ version: 1, blocks: [{ type: 'columns', columns: 'nope' }] }).blocks)
      .toEqual([])
  })

  it('span 不在允許值內時退回 6', () => {
    const b = normalizeProductContent(wrap([col(99, []), col('x', [])])).blocks[0]
    expect(b.columns[0].span).toBe(6)
    expect(b.columns[1].span).toBe(6)
  })

  it('首頁（預設放行清單）不接受欄容器', () => {
    expect(normalizeContent(wrap([col(6, []), col(6, [])])).blocks).toEqual([])
  })

  it('巢狀總數受 MAX_BLOCKS 限制', () => {
    const many = Array.from({ length: 40 }, () => ({ type: 'text', title: 't' }))
    const out = normalizeProductContent({ version: 1, blocks: [
      { type: 'columns', columns: [col(6, many), col(6, many)] },
      { type: 'text', title: '最後' },
    ] })
    const count = out.blocks.reduce((n, b) =>
      n + 1 + (b.columns ? b.columns.reduce((m, c) => m + c.blocks.length, 0) : 0), 0)
    expect(count).toBeLessThanOrEqual(60)
  })

  it('舊的扁平內容正規化後與加這個功能之前相同（回歸）', () => {
    const flat = { version: 1, blocks: [
      { type: 'product_gallery', span: 6 },
      { type: 'product_title', span: 6 },
    ] }
    const out = normalizeProductContent(flat)
    expect(out.blocks.map(b => [b.type, b.span])).toEqual([
      ['product_gallery', 6], ['product_title', 6],
    ])
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm run test -- contentBlocks`
Expected: FAIL —— `columns` 型別不在放行清單，`out.blocks` 是空陣列。

- [ ] **Step 3: 實作**

`src/lib/contentBlocks.js`：

```js
// 版面容器：把幾個區塊裝進同一欄，讓「左邊一根長圖、右邊一疊資訊」排得出來。
//
// 為什麼需要它：扁平的十二欄格線是逐列填的，新的一列從最高那格的下緣開始。
// 圖庫很高、標題很矮 → 第三塊會掉到圖庫下面而不是接在標題底下，右欄整片空白。
// 一維的「順序 + 寬度」畫不出二維的欄結構，這是模型問題不是 CSS 問題。
//
// 巢狀刻意只有一層。欄裡再放欄能表達的版面，商品頁一個都用不到，
// 但會讓正規化、編輯操作與渲染各多一層遞迴的錯誤空間。
export const LAYOUT_BLOCK_TYPES = ['columns']

export const MIN_COLUMNS = 2
export const MAX_COLUMNS = 3
export const DEFAULT_COLUMN_SPAN = 6

// 常用比例。店主不必在腦中把十二欄換算成版面。
export const COLUMN_PRESETS = [
  { key: '6-6', label: '對半', spans: [6, 6] },
  { key: '4-8', label: '左窄右寬', spans: [4, 8] },
  { key: '8-4', label: '左寬右窄', spans: [8, 4] },
  { key: '4-4-4', label: '三等分', spans: [4, 4, 4] },
]
```

`ALL_BLOCK_TYPES` 改成 `[...BLOCK_TYPES, ...PRODUCT_BLOCK_TYPES, ...LAYOUT_BLOCK_TYPES]`。
`BLOCK_LABELS` 加 `columns: '欄容器'`。

`normalizeBlock` 改寫（`columns` 不走 `NORMALIZERS`，因為它要遞迴且沒有 `span`）：

```js
function normalizeBlock(raw, index, allow, budget) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const type = raw.type
  if (typeof type !== 'string' || !allow.includes(type)) return null
  const id = typeof raw.id === 'string' && raw.id ? raw.id : `${type}-${index}`

  if (type === 'columns') {
    if (!Array.isArray(raw.columns)) return null
    // 欄裡不准再放欄：從放行清單移掉，遞迴自然就到底了
    const innerAllow = allow.filter(t => t !== 'columns')
    let cols = raw.columns.slice(0, MAX_COLUMNS).map((c, ci) => {
      const src = c && typeof c === 'object' && !Array.isArray(c) ? c : {}
      const list = Array.isArray(src.blocks) ? src.blocks : []
      const blocks = []
      for (let i = 0; i < list.length && budget.left > 0; i++) {
        const b = normalizeBlock(list[i], i, innerAllow, budget)
        if (b) { blocks.push(b); budget.left -= 1 }
      }
      return {
        id: typeof src.id === 'string' && src.id ? src.id : `col-${index}-${ci}`,
        span: oneOf(toInt(src.span), SPANS, DEFAULT_COLUMN_SPAN),
        blocks,
      }
    })
    // 少於下限就補空欄。一欄的「欄容器」沒有意義，而店主可能正在編排中途
    while (cols.length < MIN_COLUMNS) {
      cols.push({ id: `col-${index}-${cols.length}`, span: DEFAULT_COLUMN_SPAN, blocks: [] })
    }
    return { id, type, columns: cols }
  }

  const span = oneOf(toInt(raw.span), SPANS, DEFAULT_SPAN)
  return { id, type, span, ...NORMALIZERS[type](raw) }
}
```

`normalizeContent` 改成帶預算（巢狀總數共用 `MAX_BLOCKS`）：

```js
export function normalizeContent(raw, { allow = BLOCK_TYPES } = {}) {
  if (raw == null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) return null
  const list = Array.isArray(raw.blocks) ? raw.blocks : []
  const blocks = []
  // 巢狀之後「幾個區塊」要算總數，否則 60 個欄容器各塞 60 個子塊就爆了
  const budget = { left: MAX_BLOCKS }
  for (let i = 0; i < list.length && budget.left > 0; i++) {
    const block = normalizeBlock(list[i], i, allow, budget)
    if (block) { blocks.push(block); budget.left -= 1 }
  }
  return { version: CONTENT_VERSION, blocks }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm run test -- contentBlocks`
Expected: PASS，且**既有的所有測試仍然通過**（特別是壞資料那組與首頁那組）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/contentBlocks.js src/lib/contentBlocks.test.js
git commit -m "feat: 區塊內容支援欄容器"
```

---

### Task 2: 路徑版編輯操作（TDD）

**Files:**
- Modify: `src/lib/contentBlocks.js`
- Test: `src/lib/contentBlocks.test.js`

**Interfaces:**
- Produces（`path` 是 `[blockIndex]` 或 `[columnsIndex, columnIndex, childIndex]`）：
  - `getBlockAt(blocks, path)`
  - `insertBlockAt(blocks, path, block)`
  - `removeBlockAt(blocks, path)`
  - `replaceBlockAt(blocks, path, next)`
  - `duplicateBlockAt(blocks, path)`
  - `moveBlockAt(blocks, path, dir)` — 只在自己的容器內移動
  - `moveBlockTo(blocks, fromPath, toPath)` — 可跨容器
  - `createColumns(count)`
  - `removeColumnAt(blocks, columnsIndex, columnIndex)` — 內容搬到相鄰欄
- 既有的 `moveBlock` / `duplicateBlock` / `removeBlock` / `replaceBlock` 保持原簽名與行為（首頁編排器在用）。

- [ ] **Step 1: 寫失敗的測試**

```js
describe('路徑版編輯操作', () => {
  const flat = () => ([
    { id: 'a', type: 'text', span: 12, title: 'A', body: '' },
    { id: 'cols', type: 'columns', columns: [
      { id: 'c0', span: 6, blocks: [{ id: 'x', type: 'text', span: 12, title: 'X', body: '' }] },
      { id: 'c1', span: 6, blocks: [{ id: 'y', type: 'text', span: 12, title: 'Y', body: '' }] },
    ] },
    { id: 'b', type: 'text', span: 12, title: 'B', body: '' },
  ])

  it('getBlockAt 取得頂層與巢狀區塊', () => {
    expect(getBlockAt(flat(), [0]).id).toBe('a')
    expect(getBlockAt(flat(), [1, 1, 0]).id).toBe('y')
    expect(getBlockAt(flat(), [9])).toBe(null)
    expect(getBlockAt(flat(), [1, 5, 0])).toBe(null)
  })

  it('insertBlockAt 插進指定位置', () => {
    const nb = { id: 'n', type: 'text', span: 12, title: 'N', body: '' }
    expect(insertBlockAt(flat(), [0], nb).map(b => b.id)).toEqual(['n', 'a', 'cols', 'b'])
    expect(insertBlockAt(flat(), [1, 0, 0], nb)[1].columns[0].blocks.map(b => b.id))
      .toEqual(['n', 'x'])
  })

  it('removeBlockAt 移除頂層與巢狀', () => {
    expect(removeBlockAt(flat(), [0]).map(b => b.id)).toEqual(['cols', 'b'])
    expect(removeBlockAt(flat(), [1, 0, 0])[1].columns[0].blocks).toEqual([])
  })

  it('replaceBlockAt 換掉指定位置', () => {
    const nb = { id: 'n', type: 'text', span: 12, title: 'N', body: '' }
    expect(replaceBlockAt(flat(), [1, 1, 0], nb)[1].columns[1].blocks[0].id).toBe('n')
  })

  it('duplicateBlockAt 複製並給新 id', () => {
    const out = duplicateBlockAt(flat(), [1, 0, 0])
    const list = out[1].columns[0].blocks
    expect(list).toHaveLength(2)
    expect(list[1].id).not.toBe(list[0].id)
    expect(list[1].title).toBe('X')
  })

  it('moveBlockAt 只在自己的容器內移動', () => {
    const withTwo = insertBlockAt(flat(), [1, 0, 1], { id: 'x2', type: 'text', span: 12, title: '', body: '' })
    expect(moveBlockAt(withTwo, [1, 0, 0], 1)[1].columns[0].blocks.map(b => b.id)).toEqual(['x2', 'x'])
    // 到邊界就不動，不會跳到別的容器
    expect(moveBlockAt(flat(), [1, 0, 0], -1)[1].columns[0].blocks.map(b => b.id)).toEqual(['x'])
  })

  it('moveBlockTo 可以跨容器', () => {
    const out = moveBlockTo(flat(), [0], [1, 1, 0])       // 頂層 a → 第二欄最前面
    expect(out.map(b => b.id)).toEqual(['cols', 'b'])
    expect(out[0].columns[1].blocks.map(b => b.id)).toEqual(['a', 'y'])
  })

  it('moveBlockTo 從欄裡搬到頂層', () => {
    const out = moveBlockTo(flat(), [1, 0, 0], [0])
    expect(out.map(b => b.id)).toEqual(['x', 'a', 'cols', 'b'])
    expect(out[2].columns[0].blocks).toEqual([])
  })

  it('非法路徑一律回原陣列', () => {
    const src = flat()
    expect(removeBlockAt(src, [99])).toBe(src)
    expect(replaceBlockAt(src, [1, 9, 0], {})).toBe(src)
    expect(moveBlockTo(src, [9], [0])).toBe(src)
  })

  it('createColumns 給合法的預設形狀', () => {
    const c2 = createColumns(2)
    expect(c2.type).toBe('columns')
    expect(c2.columns.map(c => c.span)).toEqual([6, 6])
    expect(createColumns(3).columns.map(c => c.span)).toEqual([4, 4, 4])
  })

  it('removeColumnAt 把內容搬到相鄰欄，不刪掉店主的東西', () => {
    const out = removeColumnAt(flat(), 1, 1)       // 刪第二欄
    expect(out[1].columns).toHaveLength(1)
    expect(out[1].columns[0].blocks.map(b => b.id)).toEqual(['x', 'y'])
  })

  it('舊的扁平 API 行為不變', () => {
    const src = flat()
    expect(removeBlock(src, 0).map(b => b.id)).toEqual(['cols', 'b'])
    expect(moveBlock(src, 0, 1).map(b => b.id)).toEqual(['cols', 'a', 'b'])
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm run test -- contentBlocks`
Expected: FAIL —— `getBlockAt is not defined`。

- [ ] **Step 3: 實作**

```js
// ── 路徑版編輯操作 ────────────────────────────────
// path 只有兩種形狀：
//   [i]        頂層第 i 塊
//   [i, c, j]  頂層第 i 塊（欄容器）的第 c 欄的第 j 塊
// 巢狀只有一層，所以不需要通用的樹走訪 —— 那會換來一堆用不到的分支。
//
// 全部回新陣列。路徑非法一律回**原陣列本身**（不是複本），
// 呼叫端可以用 === 判斷「什麼都沒發生」。

function columnOf(blocks, path) {
  const [i, c] = path
  const parent = blocks?.[i]
  if (!parent || parent.type !== 'columns') return null
  const col = parent.columns?.[c]
  return col ?? null
}

export function getBlockAt(blocks, path) {
  if (!Array.isArray(blocks) || !Array.isArray(path)) return null
  if (path.length === 1) return blocks[path[0]] ?? null
  if (path.length === 3) return columnOf(blocks, path)?.blocks?.[path[2]] ?? null
  return null
}

// 對某一欄的 blocks 做一次替換，回新的頂層陣列
function withColumnBlocks(blocks, i, c, fn) {
  const parent = blocks[i]
  const col = parent?.columns?.[c]
  if (!col) return blocks
  const nextBlocks = fn(col.blocks)
  if (nextBlocks === col.blocks) return blocks
  const columns = parent.columns.map((x, ci) => (ci === c ? { ...x, blocks: nextBlocks } : x))
  return blocks.map((b, bi) => (bi === i ? { ...parent, columns } : b))
}

export function insertBlockAt(blocks, path, block) {
  if (!Array.isArray(blocks) || !block) return blocks
  if (path.length === 1) {
    const at = Math.max(0, Math.min(path[0], blocks.length))
    const out = blocks.slice()
    out.splice(at, 0, block)
    return out
  }
  if (path.length === 3) {
    return withColumnBlocks(blocks, path[0], path[1], list => {
      const at = Math.max(0, Math.min(path[2], list.length))
      const out = list.slice()
      out.splice(at, 0, block)
      return out
    })
  }
  return blocks
}

export function removeBlockAt(blocks, path) {
  if (getBlockAt(blocks, path) == null) return blocks
  if (path.length === 1) return blocks.filter((_, i) => i !== path[0])
  return withColumnBlocks(blocks, path[0], path[1], list => list.filter((_, j) => j !== path[2]))
}

export function replaceBlockAt(blocks, path, next) {
  if (getBlockAt(blocks, path) == null) return blocks
  if (path.length === 1) return blocks.map((b, i) => (i === path[0] ? next : b))
  return withColumnBlocks(blocks, path[0], path[1], list => list.map((b, j) => (j === path[2] ? next : b)))
}

export function duplicateBlockAt(blocks, path) {
  const src = getBlockAt(blocks, path)
  if (!src) return blocks
  const copy = { ...structuredCloneish(src), id: makeId(src.type || 'block') }
  // 欄容器的複本要連子區塊的 id 都換掉，否則兩份共用同一組 id，選取與拖拉會認錯人
  if (copy.type === 'columns') {
    copy.columns = copy.columns.map(c => ({
      ...c,
      id: makeId('col'),
      blocks: c.blocks.map(b => ({ ...b, id: makeId(b.type || 'block') })),
    }))
  }
  const at = path.slice()
  at[at.length - 1] += 1
  return insertBlockAt(blocks, at, copy)
}

export function moveBlockAt(blocks, path, dir) {
  const at = path[path.length - 1]
  const to = at + dir
  if (to < 0) return blocks
  if (path.length === 1) {
    if (to >= blocks.length) return blocks
    return moveBlock(blocks, at, dir)
  }
  const col = columnOf(blocks, path)
  if (!col || to >= col.blocks.length) return blocks
  return withColumnBlocks(blocks, path[0], path[1], list => moveBlock(list, at, dir))
}

export function moveBlockTo(blocks, fromPath, toPath) {
  const src = getBlockAt(blocks, fromPath)
  if (!src) return blocks
  const removed = removeBlockAt(blocks, fromPath)
  if (removed === blocks) return blocks
  // 移除來源後，同一個容器內位於來源之後的插入點要往回退一格
  const to = toPath.slice()
  const sameContainer = fromPath.length === toPath.length &&
    fromPath.slice(0, -1).every((v, i) => v === toPath[i])
  if (sameContainer && fromPath[fromPath.length - 1] < to[to.length - 1]) {
    to[to.length - 1] -= 1
  }
  // 從頂層搬走一塊會讓後面的頂層索引往前一格，巢狀路徑的第一段也要跟著調
  if (fromPath.length === 1 && to.length === 3 && fromPath[0] < to[0]) to[0] -= 1
  const out = insertBlockAt(removed, to, src)
  return out === removed ? blocks : out
}

export function createColumns(count = 2) {
  const n = Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, toInt(count) ?? MIN_COLUMNS))
  const spans = n === 3 ? [4, 4, 4] : [6, 6]
  return {
    id: makeId('columns'),
    type: 'columns',
    columns: spans.map(span => ({ id: makeId('col'), span, blocks: [] })),
  }
}

/**
 * 刪掉一欄。裡面的區塊搬到前一欄（沒有前一欄就搬到後一欄）——
 * 靜靜刪掉店主寫過的內容是最不該做的事。
 * 剩下的欄數會低於下限時，整個欄容器不動（呼叫端該改成刪整塊）。
 */
export function removeColumnAt(blocks, columnsIndex, columnIndex) {
  const parent = blocks?.[columnsIndex]
  if (!parent || parent.type !== 'columns') return blocks
  const cols = parent.columns
  if (!cols?.[columnIndex] || cols.length <= 1) return blocks
  const survivorIndex = columnIndex > 0 ? columnIndex - 1 : 1
  const moved = cols[columnIndex].blocks
  const next = cols
    .map((c, i) => (i === survivorIndex ? { ...c, blocks: [...c.blocks, ...moved] } : c))
    .filter((_, i) => i !== columnIndex)
  return blocks.map((b, i) => (i === columnsIndex ? { ...parent, columns: next } : b))
}
```

`makeId` 與 `structuredCloneish` 已存在（`:225-229`、`:258-260`），不用重寫。

- [ ] **Step 4: 跑測試確認通過**

Run: `npm run test -- contentBlocks`
Expected: PASS，既有測試也全過。

- [ ] **Step 5: Commit**

```bash
git add src/lib/contentBlocks.js src/lib/contentBlocks.test.js
git commit -m "feat: 區塊編輯操作支援巢狀路徑"
```

---

### Task 3: 預設範本改成左圖右資訊（TDD）

**Files:**
- Modify: `src/lib/contentBlocks.js`（`PRODUCT_TEMPLATE_SEEDS` / `buildProductTemplate` / `seedBlocks`）
- Test: `src/lib/contentBlocks.test.js`

- [ ] **Step 1: 寫失敗的測試**

```js
describe('buildProductTemplate — 左圖右資訊', () => {
  it('回傳一個欄容器：左欄圖庫、右欄購買動線', () => {
    const t = buildProductTemplate()
    expect(t.blocks).toHaveLength(1)
    const cols = t.blocks[0]
    expect(cols.type).toBe('columns')
    expect(cols.columns).toHaveLength(2)
    expect(cols.columns[0].blocks.map(b => b.type)).toEqual(['product_gallery'])
    expect(cols.columns[1].blocks.map(b => b.type)).toEqual([
      'product_title', 'product_price', 'product_desc', 'product_options',
      'product_status', 'product_qty', 'product_note', 'product_cta',
    ])
  })

  it('產出的內容通得過正規化且不變形', () => {
    const t = buildProductTemplate()
    expect(normalizeProductContent(t)).toEqual(t)
  })

  it('mergeIntroIntoTemplate 把既有 intro 接在最後、各佔滿版', () => {
    const merged = mergeIntroIntoTemplate(buildProductTemplate(), {
      version: 1, blocks: [{ type: 'text', title: '購買須知', body: '內容' }],
    })
    expect(merged.blocks).toHaveLength(2)
    expect(merged.blocks[1].type).toBe('text')
    expect(merged.blocks[1].span).toBe(12)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm run test -- contentBlocks`
Expected: FAIL —— 目前 `buildProductTemplate()` 回九塊扁平區塊。

- [ ] **Step 3: 實作**

把 `PRODUCT_TEMPLATE_SEEDS`（`:337-347`）與 `buildProductTemplate`（`:350-352`）換成：

```js
// 商品頁範本的起點：左欄一根長圖、右欄一疊購買動線。
//
// 改成欄容器之前這裡是九塊各佔一半的扁平區塊，畫出來是鋸齒
// （格線逐列填，圖庫很高所以第三塊掉到它下面而不是接在標題底下）。
const PRODUCT_TEMPLATE_LEFT = ['product_gallery']
const PRODUCT_TEMPLATE_RIGHT = [
  'product_title', 'product_price', 'product_desc', 'product_options',
  'product_status', 'product_qty', 'product_note', 'product_cta',
]

/** 店主第一次進商品頁編排器時的起點。 */
export function buildProductTemplate() {
  const cols = createColumns(2)
  cols.columns[0].blocks = PRODUCT_TEMPLATE_LEFT.map(t => createBlock(t))
  cols.columns[1].blocks = PRODUCT_TEMPLATE_RIGHT.map(t => createBlock(t))
  return { version: CONTENT_VERSION, blocks: [cols] }
}
```

`createBlock` 的預設 `span` 是 12，欄裡的子區塊本來就該吃滿自己那一欄，正確。

`mergeIntroIntoTemplate`（`:361-370`）不改：它把 intro 接在頂層、各佔 `DEFAULT_SPAN`，
與改動前的視覺位置一致。

- [ ] **Step 4: 跑測試確認通過**

Run: `npm run test -- contentBlocks`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/contentBlocks.js src/lib/contentBlocks.test.js
git commit -m "feat: 商品頁預設範本改成左圖右資訊"
```

---

### Task 4: 同步商城端的副本

**Files:**
- Modify: `shop/src/lib/contentBlocks.js`

- [ ] **Step 1: 同步**

把 `src/lib/contentBlocks.js` 這次的所有改動（Task 1-3）逐項搬到 `shop/src/lib/contentBlocks.js`。
兩份的差異只允許出現在檔頭的說明註解。

- [ ] **Step 2: 逐行比對**

```bash
diff <(grep -v '^\s*//' src/lib/contentBlocks.js) <(grep -v '^\s*//' shop/src/lib/contentBlocks.js)
```

Expected: 沒有輸出（去掉註解後兩份完全相同）。有差異就是漏搬了。

- [ ] **Step 3: 商城起得來**

```bash
cd shop && npm run dev
```

Expected: 編譯沒有錯誤，首頁與既有商品頁照常顯示。

- [ ] **Step 4: Commit**

```bash
git add shop/src/lib/contentBlocks.js
git commit -m "chore: 同步商城端的 contentBlocks"
```

---

### Task 5: 商城遞迴渲染欄容器

**Files:**
- Modify: `shop/src/app/products/[id]/ProductPageView.jsx`
- Modify: `shop/src/app/products/[id]/product-blocks.css`
- Modify: `shop/src/lib/useBuyBar.js`（只改呼叫端傳的 key，函式本身不動）

**Interfaces:**
- Consumes: 正規化後的 `columns` 形狀（Task 1）

- [ ] **Step 1: 把儲存格渲染抽成遞迴函式**

`PageBody` 內，把 `blocks.map(block => …)` 那段換成：

```jsx
  // 一塊區塊 → 一個格線儲存格。欄容器多包一層格線，子區塊在欄內垂直堆疊。
  function renderCell(block) {
    const cls = [
      'pp-cell',
      block.type === 'columns' ? 'pp-columns' : '',
      editing && block.id === selectedId ? 'is-selected' : '',
      editing && block.id === highlightId ? 'is-highlighted' : '',
    ].filter(Boolean).join(' ')

    if (block.type === 'columns') {
      return (
        <div key={block.id} className={cls} style={{ '--pp-span': 12 }}
          data-block-id={editing ? block.id : undefined}>
          <div className="blk-grid">
            {block.columns.map(col => (
              <div key={col.id} className="pp-col" style={{ '--pp-span': col.span }}>
                {col.blocks.map(child => renderCell(child))}
              </div>
            ))}
          </div>
        </div>
      )
    }

    const Renderer = PRODUCT_RENDERERS[block.type]
    return (
      <div key={block.id} className={cls} style={{ '--pp-span': block.span }}
        data-block-id={editing ? block.id : undefined}>
        {Renderer
          ? <Renderer block={block} anchorRef={block.type === 'product_cta' ? anchorRef : undefined} />
          : <BlocksView blocks={[block]} productsByBlock={productsByBlock} />}
      </div>
    )
  }
```

主體變成：

```jsx
  <div className="container blk-grid pp-grid">
    {blocks.map(block => renderCell(block))}
  </div>
```

- [ ] **Step 2: 黏底購買列的 key 要含巢狀 id**

`useBuyBar` 目前吃 `blocks.map(b => b.id).join(',')`。店主把 CTA 搬進欄裡時，
那個 key 不會變 → observer 盯著已經被移掉的節點。改成：

```js
  // 攤平所有 id（含欄內的）：店主一搬動區塊，product_cta 就是另一個 DOM 節點了，
  // observer 得重掛才不會盯著一個已經不存在的節點看
  const blockKey = blocks.flatMap(b =>
    b.type === 'columns'
      ? [b.id, ...b.columns.flatMap(c => [c.id, ...c.blocks.map(x => x.id)])]
      : [b.id],
  ).join(',')
  const { anchorRef, visible: barVisible } = useBuyBar(blockKey)
```

- [ ] **Step 3: CSS**

`product-blocks.css` 在 `.pp-cell` 規則附近加：

```css
/* 欄容器：自己吃滿整列，內部再一層十二欄格線。
   欄裡是垂直堆疊而不是又一層格線 —— 欄的意義就是「這一疊東西排在一起」。 */
.pp-columns > .blk-grid { align-items: start; row-gap: var(--space-5); }
.pp-col {
  grid-column: span var(--pp-span, 12);
  min-width: 0;
  display: flex; flex-direction: column; gap: var(--space-5);
}
/* 手機一律堆疊，與外層格線同一條規則、同一個斷點 */
@media (max-width: 900px) { .pp-col { grid-column: span 12; } }

/* 欄內畫不出東西的儲存格不佔位；整欄都空就整欄不佔位；
   整個欄容器都空就整塊不佔位。編輯器裡仍要看得見（看不到就選不到也刪不掉）。 */
.pp-col:empty { display: none; }
.pp-editing .pp-col:empty {
  display: block; padding: 14px; border-radius: var(--r-card);
  background: var(--border-light); color: var(--text-3); font-size: 12.5px;
}
.pp-editing .pp-col:empty::after { content: '空的欄，把區塊拖進來'; }
```

> `:empty` 只認「沒有子節點」。`.pp-cell:empty { display: none }` 已經讓畫不出東西的儲存格消失，
> 但那些 `<div>` 仍是 `.pp-col` 的子節點，所以 `.pp-col:empty` 不會成立。
> 這是刻意的：只有真的一個區塊都沒有的欄才不佔位。

- [ ] **Step 4: 瀏覽器驗證**

```bash
cd shop && npm run dev     # :3000
npm run dev                # 另一個終端，後台 :5173
```

後台 → 商品頁範本 → 若是空的，按「從現有版型開始」套用新範本 → 存檔。

1. 商城商品頁 → 桌機是左圖右資訊兩欄
2. 視窗縮到 900px 以下 → 上下堆疊，順序是圖庫 → 標題 → 價格 → …
3. 捲過加入購物車鈕 → 黏底購買列出現；捲回去 → 收起
4. 找一件**沒有規格**的商品 → 「規格選擇」區塊不佔位，右欄沒有空洞
5. **回歸**：把該店的範本清成 null（`update stores set … = null`）→ 商品頁走
   `ProductDetail` 內建版型，畫面與改動前一模一樣
6. **回歸**：手動塞一份舊的扁平範本（九塊 span 6）→ 版面與改動前一模一樣

- [ ] **Step 5: Commit**

```bash
git add shop/src/app/products/\[id\]/ProductPageView.jsx shop/src/app/products/\[id\]/product-blocks.css
git commit -m "feat: 商品頁渲染支援欄容器"
```

---

### Task 6: 編輯器兩層清單與拖拉

**Files:**
- Modify: `src/components/ProductPageEditor.jsx`
- Modify: `src/styles/product-editor.css`

**Interfaces:**
- Consumes: Task 2 的路徑版操作、`createColumns`

- [ ] **Step 1: 清單改成兩層**

`blocks.map((block, i) => …)` 改成先畫頂層，遇到 `columns` 再往下畫一層。
`selectedId` 的查找也要能找到巢狀的那塊：

```js
// 選中的區塊可能在某一欄裡。回傳路徑，後面所有操作都吃它。
function findPath(blocks, id) {
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].id === id) return [i]
    if (blocks[i].type === 'columns') {
      const cols = blocks[i].columns
      for (let c = 0; c < cols.length; c++) {
        const j = cols[c].blocks.findIndex(b => b.id === id)
        if (j >= 0) return [i, c, j]
      }
    }
  }
  return null
}

const selectedPath = selectedId ? findPath(blocks, selectedId) : null
const selected = selectedPath ? getBlockAt(blocks, selectedPath) : null
```

所有 `onChange(removeBlock(blocks, i))` 之類改成路徑版：
`onChange(removeBlockAt(blocks, path))`、`replaceBlockAt(blocks, selectedPath, next)`、
`duplicateBlockAt(blocks, path)`、`moveBlockAt(blocks, path, ±1)`。

欄容器的列多一個展開/收合，子項用 `.pe-item.is-child` 縮排。每一欄畫一個小標題列
（「第 1 欄・一半」）＋一顆刪欄鈕。

頂端 import 要補（缺一個就是 ReferenceError）：

```js
import {
  BLOCK_TYPES, PRODUCT_BLOCK_TYPES, BLOCK_LABELS, MIN_COLUMNS,
  createBlock, createColumns, moveBlock, replaceBlock,
  getBlockAt, insertBlockAt, removeBlockAt, replaceBlockAt,
  duplicateBlockAt, moveBlockAt, moveBlockTo, removeColumnAt,
} from '../lib/contentBlocks'
```

- [ ] **Step 2: 拖拉支援落到欄裡**

`dragIndex` 改成 `dragPath`，`dropAt` 改成 `{ path, after }`。
`onDragOver` 對三種目標各自處理：

```js
// 落點有三種：頂層項目之間、某一欄的子項之間、空欄本身。
// 空欄要能當落點，否則店主建了欄容器卻沒辦法把東西放進去。
function onDragOverItem(e, path) {
  if (!dragPath) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  const rect = e.currentTarget.getBoundingClientRect()
  const after = e.clientY > rect.top + rect.height / 2
  setDropAt({ path, after })
}

function onDragOverEmptyColumn(e, columnsIndex, columnIndex) {
  if (!dragPath) return
  e.preventDefault()
  setDropAt({ path: [columnsIndex, columnIndex, 0], after: false })
}
```

`onDrop`：

```js
function onDrop(e) {
  e.preventDefault()
  const from = dragPath
  const target = dropAt
  endDrag()
  if (!from || !target) return
  const to = target.path.slice()
  if (target.after) to[to.length - 1] += 1
  // 不准把欄容器拖進欄裡（巢狀只有一層）
  const moving = getBlockAt(blocks, from)
  if (moving?.type === 'columns' && to.length === 3) return
  const next = moveBlockTo(blocks, from, to)
  if (next !== blocks) onChange(next)
}
```

- [ ] **Step 3: 加入欄容器**

「加入區塊」面板最上面多一組：

```jsx
<div className="sec" style={{ marginTop: 0 }}>版面</div>
<div className="pe-add-grid">
  <button type="button" className="pe-add-btn" onClick={() => addColumns(2)}>
    <div className="pe-add-name">兩欄</div>
    <div className="pe-add-hint">例如左邊放圖、右邊放購買資訊</div>
  </button>
  <button type="button" className="pe-add-btn" onClick={() => addColumns(3)}>
    <div className="pe-add-name">三欄</div>
    <div className="pe-add-hint">三件事情並排，各佔三分之一</div>
  </button>
</div>
```

```js
function addColumns(count) {
  const block = createColumns(count)
  onChange([...blocks, block])
  setSelectedId(block.id)
  setAdding(false)
}
```

- [ ] **Step 4: 刪除的兩種情況**

```js
function removeAt(path) {
  const block = getBlockAt(blocks, path)
  if (!block) return
  if (block.type === 'columns') {
    const n = block.columns.reduce((s, c) => s + c.blocks.length, 0)
    const msg = n > 0
      ? `確定刪除這個欄容器？裡面的 ${n} 個區塊會一起刪掉。`
      : '確定刪除這個欄容器？'
    if (!window.confirm(msg)) return
  } else if (!window.confirm(`確定刪除這個「${BLOCK_LABELS[block.type]}」區塊？`)) {
    return
  }
  if (block.id === selectedId) setSelectedId(null)
  onChange(removeBlockAt(blocks, path))
}

// 刪一欄：內容搬到相鄰欄，不會靜靜消失。只剩兩欄時不給刪
//（欄容器至少要兩欄，要整個拿掉請刪整塊）。
function removeColumn(columnsIndex, columnIndex) {
  const parent = blocks[columnsIndex]
  if (parent.columns.length <= MIN_COLUMNS) {
    alert('欄容器至少要兩欄。要整個拿掉請刪除這個欄容器。')
    return
  }
  onChange(removeColumnAt(blocks, columnsIndex, columnIndex))
}
```

- [ ] **Step 5: 樣式**

`src/styles/product-editor.css` 加：

```css
/* 欄容器在清單裡是兩層：容器一列，欄與子區塊縮排在下面 */
.pe-group { border: 1px solid var(--border); border-radius: 10px; padding: 8px; }
.pe-col-head {
  display: flex; align-items: center; gap: 6px;
  font-size: 11.5px; color: var(--text-3); padding: 6px 4px 4px;
}
.pe-col-body { display: flex; flex-direction: column; gap: 6px; padding-left: 10px; }
.pe-item.is-child { padding: 7px 8px; }
.pe-col-empty {
  border: 1px dashed var(--border); border-radius: 8px;
  padding: 12px; text-align: center; font-size: 11.5px; color: var(--text-3);
}
.pe-col-empty.is-over { border-color: var(--text); color: var(--text); }
```

- [ ] **Step 6: 瀏覽器驗證**

1. 全店範本頁 → 新店（範本是空的）→ 按「從現有版型開始」→ 清單顯示一個欄容器，
   展開後左欄一塊、右欄八塊
2. 預覽是左圖右資訊
3. 加入一個「兩欄」→ 出現空欄提示
4. 把一塊區塊從頂層拖進左欄 → 成功，預覽即時更新
5. 從左欄拖到右欄 → 成功
6. 從欄裡拖回頂層 → 成功
7. 把欄容器拖到另一個欄裡 → **不會發生**（巢狀限一層）
8. ↑↓ 按鈕在欄內移動，到邊界就停住，不會跳出容器
9. 刪除有內容的欄容器 → 確認訊息寫明會刪掉幾個區塊
10. 三欄的容器刪掉中間那欄 → 內容跑到第一欄，沒有消失
11. 兩欄的容器按刪欄 → 提示至少要兩欄
12. 點預覽裡的巢狀區塊 → 左側切到那一塊的設定
13. 滑過清單裡的巢狀區塊 → 預覽把它框起來
14. **回歸**：首頁編排器（`/home-design`）完全沒有變化，加不到欄容器

- [ ] **Step 7: Commit**

```bash
git add src/components/ProductPageEditor.jsx src/styles/product-editor.css
git commit -m "feat: 編排器支援欄容器與拖進欄"
```

---

### Task 7: 欄容器的屬性面板

**Files:**
- Modify: `src/components/BlockInspector.jsx`

- [ ] **Step 1: `columns` 走自己的設定**

`SpanField`（`:36`）只在非 `columns` 時顯示 —— 欄容器沒有自己的 `span`：

```jsx
{block.type !== 'columns' && (
  <SpanField value={block.span ?? DEFAULT_SPAN} onChange={set('span')} />
)}

{block.type === 'columns' && <ColumnsField block={block} onChange={onChange} />}
```

```jsx
// 欄容器：欄數與比例。刻意不開放「手機是否反序」之類的選項 ——
// 多一個開關就多一種店主排得出來的壞版面，而他在自己的手機上不一定會發現。
function ColumnsField({ block, onChange }) {
  const spans = block.columns.map(c => c.span)
  const activeKey = COLUMN_PRESETS.find(p =>
    p.spans.length === spans.length && p.spans.every((v, i) => v === spans[i]))?.key

  function applyPreset(preset) {
    const next = preset.spans.map((span, i) => (
      block.columns[i]
        ? { ...block.columns[i], span }
        // 從兩欄變三欄：新的那欄是空的
        : { id: `col-${Date.now()}-${i}`, span, blocks: [] }
    ))
    // 從三欄變兩欄：被砍掉那欄的內容併進最後保留的那欄，不要弄丟店主的東西
    const dropped = block.columns.slice(preset.spans.length).flatMap(c => c.blocks)
    if (dropped.length) {
      const last = next.length - 1
      next[last] = { ...next[last], blocks: [...next[last].blocks, ...dropped] }
    }
    onChange({ ...block, columns: next })
  }

  return (
    <>
      <Field label="欄位比例" hint="只在桌機生效 —— 手機一律整列堆疊，並排會每一欄都太窄。">
        <div className="pe-chip-row">
          {COLUMN_PRESETS.map(p => (
            <button key={p.key} type="button"
              className={`pe-chip ${activeKey === p.key ? 'is-active' : ''}`}
              onClick={() => applyPreset(p)}>
              {p.label}
            </button>
          ))}
        </div>
      </Field>
      {block.columns.map((c, i) => (
        <Field key={c.id} label={`第 ${i + 1} 欄寬度`}>
          <CustomSelect
            label="— 選擇欄寬 —"
            value={c.span}
            options={SPANS.map(n => ({ value: n, label: `${n} / 12 欄` }))}
            onChange={(v) => {
              if (v == null) return
              onChange({ ...block, columns: block.columns.map((x, xi) => xi === i ? { ...x, span: v } : x) })
            }}
          />
        </Field>
      ))}
    </>
  )
}
```

頂端 import 補 `COLUMN_PRESETS`。
`BLOCK_HINTS` 加 `columns: '把幾個區塊裝進同一欄，排得出「左邊一根長圖、右邊一疊資訊」。'`
`blockSummary` 對 `columns` 回 `${block.columns.length} 欄`。

- [ ] **Step 2: 瀏覽器驗證**

1. 選中欄容器 → 出現「欄位比例」四個預設，目前的比例是選中狀態
2. 按「左窄右寬」→ 預覽的欄寬跟著變
3. 兩欄按「三等分」→ 變三欄，第三欄是空的
4. 三欄按「對半」→ 變兩欄，**第三欄的內容併進第二欄**（沒有消失）
5. 個別調第 1 欄寬度為 5 → 預設按鈕全部變成未選中，預覽正確
6. 選中一般區塊 → 仍然顯示「欄寬」，沒有出現欄位比例
7. 清單裡欄容器那一列的副標顯示「2 欄」

- [ ] **Step 3: Commit**

```bash
git add src/components/BlockInspector.jsx
git commit -m "feat: 欄容器的欄數與比例設定"
```

---

### Task 8: 完整回歸與合併

- [ ] **Step 1: 純函式**

Run: `npm run test`
Expected: 全綠，包含 `contentBlocks` 與其他既有測試。

- [ ] **Step 2: 兩份副本再比一次**

```bash
diff <(grep -v '^\s*//' src/lib/contentBlocks.js) <(grep -v '^\s*//' shop/src/lib/contentBlocks.js)
```

Expected: 沒有輸出。（Task 4 之後又改了 Task 5-7，其中若動到 `contentBlocks.js` 要重新同步。）

- [ ] **Step 3: 三項回歸（最重要）**

1. **沒編排過的店**：範本與覆寫都是 null → 商品頁走 `ProductDetail`，畫面與改動前一模一樣
2. **舊的扁平範本**：手動塞九塊 span 6 → 版面與改動前一模一樣
3. **首頁編排器**：完全不受影響，加不到欄容器

- [ ] **Step 4: 走一次真實流程**

新建一個範本 → 排成左圖右資訊 → 加一個三欄放三段文字 → 存檔發佈 →
在商城看正式頁面 → 桌機兩欄/三欄正確、手機堆疊、黏底購買列正常。

- [ ] **Step 5: 合併**

```bash
git checkout main
git merge feat/product-page-columns
```

- [ ] **Step 6: 記錄後續**

在 `docs/TODO.md` 的「進行中」那一節，把 S5 標為完成前先補一行後續：
預覽 iframe 內的直接拖放（第二階段）。五支全部合併後整節刪掉，只留這一行後續。
