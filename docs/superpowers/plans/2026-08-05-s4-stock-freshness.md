# S4 賣完的不能再被選 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 商品頁與組合頁上顯示的可選性反映當下庫存，而不是最舊一小時前的快照；結帳送出前再攔一次。

**Architecture:** SSR/ISR 維持不變（SEO 需要 server 端就吐完整內容），client 掛載後打一支輕量 API 取當下庫存，覆蓋快照再算可選性。加入購物車與結帳送出前各再驗一次。`place_order` 的 `FOR UPDATE` 檢查是最後防線，不動。

**Tech Stack:** Next.js 14 App Router（Route Handler + client hook）、React 18

**Spec:** `docs/superpowers/specs/2026-08-05-s4-stock-freshness-design.md`

## Global Constraints

- 分支 `feat/stock-freshness`，在自己的 git worktree 執行。
- **前置條件：S3（`feat/bundle-variant-images`）必須已合併進 `main`**，兩者都改 `BundleDetail.jsx`、`ProductDetail.jsx`、`ProductStateProvider.jsx`。開工前 `git log main --oneline -3` 確認。
- **不改 `place_order`。** 它已經有 `SELECT … FOR UPDATE` 的庫存檢查（`supabase/migrations/20250071_place_order_bundle_discount.sql:75-124`），是正確的最後防線。這份計畫不碰交易邏輯。
- **API 用 anon key（`NEXT_PUBLIC_SUPABASE_*`），不要用 secret key。** 商城的 server 資料層一律如此（`shop/src/lib/data.js:2-3`），而且 migration 39 對 anon 封鎖了 `variant_cost` —— 走 anon 等於白拿一層成本保護。
- **絕不 `select('*')` 查 `product_variants`。** 明列 `id, product_id, stock`。成本欄位不可出現在消費者拿得到的回應裡。
- 輔助 API 失敗時**一律放行**，不可把消費者鎖成不能購買。極少數的競態交給 `place_order` 擋。
- 預購／收單商品（`skip_stock_check` 或有 `collection_end`）不受庫存數字影響，既有的 `skipStock` 判斷優先。
- `shop/` 沒有測試 runner，這次不引入。驗收全部是瀏覽器步驟。
- 不新增任何依賴。
- **商城 dev server 在跑時不要跑 `npm run build`**。
- commit message 用繁體中文、簡潔，不要加 Co-Authored-By。

---

## File Structure

| 檔案 | 責任 |
|---|---|
| `shop/src/app/api/stock/route.js`（新） | 即時庫存查詢端點。只回數字，不快取 |
| `shop/src/lib/useFreshStock.js`（新） | client hook：掛載與回到前景時取一次；含 `mergeStock` 純函式 |
| `shop/src/app/products/[id]/ProductStateProvider.jsx`（改） | 編排版商品頁：庫存補正、初始選擇改成挑有貨的、加入購物車前驗證 |
| `shop/src/app/products/[id]/ProductDetail.jsx`（改） | 內建版商品頁：同上 |
| `shop/src/app/bundles/[id]/BundleDetail.jsx`（改） | 組合頁：庫存補正、加入購物車前驗證 |
| `shop/src/app/checkout/page.jsx`（改） | 送出前驗證、錯誤就地呈現取代 alert |

---

### Task 1: 即時庫存查詢端點

**Files:**
- Create: `shop/src/app/api/stock/route.js`

**Interfaces:**
- Produces: `POST /api/stock`
  - request: `{ productIds: number[] }`（上限 50）
  - response 200: `{ products: { [productId]: number }, variants: { [variantId]: number }, at: string }`
  - response 400: `{ error: string }`

- [ ] **Step 1: 建立 route**

```js
// 即時庫存查詢。商品頁與組合頁是 ISR 靜態頁（最舊可能一小時前的快照），
// 而下單扣庫存不會觸發任何快取失效 —— 所以賣完的規格會繼續顯示成可選，
// 消費者填完整張表才被 place_order 擋下。這支就是用來補正那段落差。
//
// 一律用 anon key 走 RLS（與 lib/data.js 同一個規則）：
// migration 39 對 anon 封鎖了 variant_cost，走 anon 等於白拿一層成本保護。
// 明列欄位而不是 select('*') 也是同一個理由。
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

// 組合商品最多也就十幾件。超過這個數代表呼叫端有問題，不該默默照做。
const MAX_IDS = 50

export async function POST(req) {
  if (!URL || !ANON) {
    return NextResponse.json({ error: 'server not configured' }, { status: 500 })
  }

  const body = await req.json().catch(() => ({}))
  const ids = Array.isArray(body.productIds)
    ? [...new Set(body.productIds.map(Number).filter(n => Number.isInteger(n) && n > 0))]
    : []

  if (ids.length === 0) return NextResponse.json({ error: 'productIds required' }, { status: 400 })
  if (ids.length > MAX_IDS) return NextResponse.json({ error: 'too many productIds' }, { status: 400 })

  const sb = createClient(URL, ANON)
  const [{ data: variants }, { data: products }] = await Promise.all([
    // 明列欄位：這張表有 variant_cost，成本不可出現在消費者拿得到的回應裡
    sb.from('product_variants').select('id, product_id, stock').in('product_id', ids),
    sb.from('products').select('id, quantity').in('id', ids),
  ])

  const out = {
    products: Object.fromEntries((products ?? []).map(p => [p.id, Number(p.quantity) || 0])),
    variants: Object.fromEntries((variants ?? []).map(v => [v.id, Number(v.stock) || 0])),
    at: new Date().toISOString(),
  }

  // 這支的意義就是不被快取。少了這個 header，Next 或 CDN 會把它當成可快取的 POST 回應。
  return NextResponse.json(out, { headers: { 'Cache-Control': 'no-store' } })
}
```

- [ ] **Step 2: 手動打一次**

```bash
cd shop && npm run dev
curl -s -X POST http://localhost:3000/api/stock \
  -H "Content-Type: application/json" -d '{"productIds":[1,2,3]}' | head -c 400
```

Expected: 回 `{"products":{…},"variants":{…},"at":"…"}`。

- [ ] **Step 3: 邊界驗證**

```bash
curl -s -X POST http://localhost:3000/api/stock -H "Content-Type: application/json" -d '{}'
curl -s -X POST http://localhost:3000/api/stock -H "Content-Type: application/json" -d '{"productIds":[]}'
curl -s -X POST http://localhost:3000/api/stock -H "Content-Type: application/json" \
  -d "{\"productIds\":[$(seq -s, 1 60)]}"
```

Expected: 依序是 400 `productIds required`、400 `productIds required`、400 `too many productIds`。

- [ ] **Step 4: 成本外洩檢查（不可跳過）**

```bash
curl -s -X POST http://localhost:3000/api/stock \
  -H "Content-Type: application/json" -d '{"productIds":[1]}' | grep -i "cost" || echo "OK：沒有成本欄位"
```

Expected: `OK：沒有成本欄位`

- [ ] **Step 5: Commit**

```bash
git add shop/src/app/api/stock/route.js
git commit -m "feat: 即時庫存查詢端點"
```

---

### Task 2: 庫存補正 hook

**Files:**
- Create: `shop/src/lib/useFreshStock.js`

**Interfaces:**
- Consumes: `POST /api/stock`（Task 1）
- Produces:
  - `useFreshStock(productIds) => { products, variants, status, at, refetch }`
    - `status`：`'loading' | 'ready' | 'error'`
    - `refetch()` 回傳 `Promise<{ products, variants } | null>`（失敗回 `null`）
  - `mergeStock(variants, fresh) => variants[]` — 純函式，回新陣列
  - `mergeQuantity(quantity, productId, fresh) => number`
- Task 3、4、5、6 只吃這幾支。

- [ ] **Step 1: 建立檔案**

```js
'use client'
// 庫存補正：SSR 給的是快照（最舊一小時前），這支在瀏覽器補上當下的數字。
//
// 為什麼不改成動態渲染：商品頁要 SSR 出完整 HTML 給搜尋引擎與社群預覽，
// 那是 SEO 改造的成果，不能為了庫存新鮮度退回去。
//
// 為什麼不定時輪詢：這不是拍賣網站。掛載時取一次、分頁回到前景時再取一次就夠，
// 剩下的競態由 place_order 的 FOR UPDATE 檢查兜住。
import { useCallback, useEffect, useRef, useState } from 'react'

async function fetchStock(productIds) {
  const res = await fetch('/api/stock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productIds }),
  })
  if (!res.ok) throw new Error('stock fetch failed')
  return res.json()
}

export function useFreshStock(productIds) {
  const [state, setState] = useState({ products: null, variants: null, status: 'loading', at: null })
  // 陣列每次 render 都是新物件，用內容當依賴才不會無限重取
  const key = (productIds || []).join(',')
  const keyRef = useRef(key)
  keyRef.current = key

  const load = useCallback(async () => {
    const ids = keyRef.current ? keyRef.current.split(',').map(Number) : []
    if (ids.length === 0) {
      setState({ products: {}, variants: {}, status: 'ready', at: null })
      return { products: {}, variants: {} }
    }
    try {
      const data = await fetchStock(ids)
      setState({ products: data.products, variants: data.variants, status: 'ready', at: data.at })
      return data
    } catch {
      // 取不到就維持 SSR 快照。寧可顯示舊資料，也不要讓整頁不能買。
      setState(s => ({ ...s, status: 'error' }))
      return null
    }
  }, [])

  useEffect(() => { load() }, [key, load])

  // 分頁被切到背景一陣子再回來，看到的不該是十分鐘前的庫存
  useEffect(() => {
    function onVisible() { if (!document.hidden) load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])

  return { ...state, refetch: load }
}

/**
 * 把 SSR 的 variants 換上新鮮庫存。回新陣列，fresh 沒有的項目維持原值。
 * @param {Array} variants SSR 帶下來的規格列
 * @param {{variants?: Object}|null} fresh useFreshStock 的結果或 refetch 的回傳
 */
export function mergeStock(variants, fresh) {
  const map = fresh?.variants
  if (!map) return variants || []
  return (variants || []).map(v => (
    Object.prototype.hasOwnProperty.call(map, v.id) ? { ...v, stock: map[v.id] } : v
  ))
}

/** 沒有規格的商品用 products.quantity。取不到就沿用原值。 */
export function mergeQuantity(quantity, productId, fresh) {
  const map = fresh?.products
  if (!map || !Object.prototype.hasOwnProperty.call(map, productId)) return quantity
  return map[productId]
}
```

- [ ] **Step 2: Commit**

```bash
git add shop/src/lib/useFreshStock.js
git commit -m "feat: 庫存補正 hook"
```

（這一支沒有呼叫端，還看不出效果。下一個 Task 會接上。）

---

### Task 3: 商品頁套用補正

**Files:**
- Modify: `shop/src/app/products/[id]/ProductStateProvider.jsx`
- Modify: `shop/src/app/products/[id]/ProductDetail.jsx`

**Interfaces:**
- Consumes: `useFreshStock` / `mergeStock` / `mergeQuantity`（Task 2）

- [ ] **Step 1: `ProductStateProvider` 接上補正**

頂端加：

```js
import { useFreshStock, mergeStock, mergeQuantity } from '../../../lib/useFreshStock'
```

在 `variants` 進來後、算 `activeTypes` 之前插入：

```js
  const fresh = useFreshStock([sp.product_id])
  // SSR 的庫存最舊可能是一小時前的快照，補正之後底下所有可選性判斷才是真的
  const variants = mergeStock(rawVariants, fresh)
  const quantity = mergeQuantity(p.quantity, p.id, fresh)
```

（把原本的 prop `variants` 在解構時改名成 `rawVariants`；後續 `p.quantity` 的用法換成 `quantity`。）

- [ ] **Step 2: 初始選擇改成挑有貨的**

現行初始選擇是「每個維度的第一個值」（`:39-47`），不看庫存，所以可能一進頁面就停在缺貨規格。
組合頁那邊（`BundleDetail.initialOptions`）本來就是挑有貨的。統一成同一套。

⚠️ **順序問題**：`skipStock` 目前是在 `useState` 初始化之後才算的（`:74` 附近）。
挑有貨的值需要它，所以要先把 `isCollection` / `skipStock` 那三行**上移到 `selectedOptions`
的 `useState` 之前**。不移的話會拿到 undefined，預購商品的初始選擇會被誤判成缺貨。

```js
  // 每個維度挑第一個還有貨的值，全缺貨才退回第一個。
  // 與組合商品頁的 initialOptions 同一套規則 —— 同一件商品在兩條路徑上
  // 不該有不同的預設選擇。
  const [selectedOptions, setSelectedOptions] = useState(() => {
    const initial = {}
    activeTypes.forEach(type => {
      const valueIds = [...new Set(variants.map(v => v.options?.[String(type.id)]).filter(Boolean))]
      const avail = valueIds.find(vid => !isValueSoldOut(variants, initial, type.id, vid, skipStock))
      const pick = avail ?? valueIds[0]
      if (pick) initial[String(type.id)] = pick
    })
    return initial
  })
```

`isValueSoldOut` 目前只存在於 `BundleDetail.jsx`（`:395-406`）。把它搬進
`shop/src/lib/variantImages.js` 旁邊的新位置不合適（那支管圖片），另建
`shop/src/lib/variantStock.js`，兩處共用：

```js
// 規格可選性的判斷。商品頁與組合商品頁共用 ——
// 兩邊算出不同答案的話，同一件商品會在兩個頁面顯示不同的缺貨規格。
export function isValueSoldOut(variants, selectedOptions, typeId, valueId, skipStock) {
  if (skipStock) return false
  const matching = (variants || []).filter(v => {
    if (v.options?.[String(typeId)] !== valueId) return false
    return Object.entries(selectedOptions || {}).every(([tid, vid]) => {
      if (Number(tid) === typeId) return true
      return v.options?.[tid] === undefined || v.options?.[tid] === vid
    })
  })
  if (matching.length === 0) return true
  return matching.every(v => v.stock <= 0)
}

/** 每個維度挑第一個還有貨的值，全缺貨才退回第一個。 */
export function initialOptions(variants, activeTypes, skipStock, valuesFor) {
  const initial = {}
  activeTypes.forEach(type => {
    const values = valuesFor(type)
    const avail = values.find(v => !isValueSoldOut(variants, initial, type.id, v.id, skipStock))
    const pick = avail || values[0]
    if (pick) initial[String(type.id)] = pick.id
  })
  return initial
}
```

`BundleDetail.jsx` 刪掉自己那兩支，改成 import。

- [ ] **Step 3: 補正後若當前選擇缺貨，換掉並說明**

在 `ProductStateProvider` 加：

```js
  const [autoSwitched, setAutoSwitched] = useState(null)   // { from, to } 或 null

  // 庫存補正回來時，如果客人正選著的規格已經賣完，幫他換到同維度第一個有貨的。
  // 但一定要講 —— 默默改掉客人的選擇比不改更糟。
  useEffect(() => {
    if (fresh.status !== 'ready') return
    for (const type of activeTypes) {
      const tid = String(type.id)
      const cur = selectedOptions[tid]
      if (!cur || !isValueSoldOut(variants, selectedOptions, type.id, cur, skipStock)) continue
      const values = [...new Set(variants.map(v => v.options?.[tid]).filter(Boolean))]
      const next = values.find(vid => !isValueSoldOut(variants, selectedOptions, type.id, vid, skipStock))
      if (!next) continue
      const label = id => type.variant_option_values?.find(v => v.id === id)?.value ?? ''
      setAutoSwitched({ from: label(cur), to: label(next) })
      setSelectedOptions(o => ({ ...o, [tid]: next }))
      break
    }
  }, [fresh.at])   // 每次補正回來檢查一次
```

把 `autoSwitched` 一起放進 context value，讓區塊畫得出提示。
`product_status` 區塊（`shop/src/app/products/[id]/blocks/`）與 `ProductDetail` 的規格區塊下方加：

```jsx
{autoSwitched && (
  <div className="pp-auto-switch">
    {zh ? `你剛才選的「${autoSwitched.from}」已售完，已改成「${autoSwitched.to}」。`
        : `“${autoSwitched.from}” just sold out, switched to “${autoSwitched.to}”.`}
  </div>
)}
```

樣式（`product-blocks.css` 與 `globals.css` 各一份，兩頁都要）：

```css
.pp-auto-switch { font-size: 12.5px; line-height: 1.6; color: var(--text-2); margin-top: 8px; }
```

- [ ] **Step 4: `ProductDetail.jsx` 做同樣的三件事**

`ProductDetail` 是沒編排版面的店走的內建版型，邏輯與 `ProductStateProvider` 平行。
同樣加 `useFreshStock` + `mergeStock` + `mergeQuantity`、改用 `variantStock.js` 的
`isValueSoldOut`、加自動換規格的提示。

> 這兩支的重複是既有狀態（`ProductStateProvider` 檔頭寫明「內容是從 ProductDetail 原封搬過來的」）。
> 這份計畫**不做**兩者合併——那是另一件事，會把這個分支撐爆。但兩邊都要改，漏一邊就會出現
> 「編排過的店有補正、沒編排的店沒有」。

- [ ] **Step 5: 瀏覽器驗證**

開兩個視窗：A = 商城（:3000）、B = 後台（:5173）。

1. B 把某規格庫存設成 5 → A 開商品頁 → 可買
2. B 把庫存改成 0，**不要在後台商品頁存檔**（避免觸發 revalidate）→ A 重新整理
   → 該規格 chip 立刻是缺貨、不可選
3. A 停在頁面不動 → B 把另一個規格也清成 0 → A 切到別的分頁再切回來 → chip 跟著變缺貨
4. A 正選著 M 號 → B 把 M 清成 0 → A 切回分頁 → 自動改選 L，並出現「你剛才選的 M 已售完」
5. 全部規格清成 0 → 顯示「已售完」，加入購物車鈕停用
6. 預購商品（`skip_stock_check` 打勾，或設了 `collection_end`）庫存 0 → **仍可選、仍可買**
7. 對一個編排過版面的商品重做 2-4（走 `ProductPageView`）
8. 把 `/api/stock` 改成 `return NextResponse.json({error:'x'},{status:500})` → 頁面照常可買、
   規格照常可選（沿用 SSR 快照）→ 測完改回來

- [ ] **Step 6: Commit**

```bash
git add shop/src/lib/variantStock.js shop/src/app/products/\[id\]/ProductStateProvider.jsx shop/src/app/products/\[id\]/ProductDetail.jsx shop/src/app/products/\[id\]/product-blocks.css shop/src/app/globals.css shop/src/app/bundles/\[id\]/BundleDetail.jsx
git commit -m "feat: 商品頁庫存即時補正"
```

---

### Task 4: 組合商品頁套用補正

**Files:**
- Modify: `shop/src/app/bundles/[id]/BundleDetail.jsx`

- [ ] **Step 1: 接上 hook**

頂端加：

```js
import { useFreshStock, mergeStock } from '../../../lib/useFreshStock'
```

在 `picks` state 之前：

```js
  const productIds = items.map(it => it.productId)
  const fresh = useFreshStock(productIds)
  // 每一件的 variants 都換上新鮮庫存，底下 rows / isValueSoldOut 自然就是用真的數字判斷
  const freshItems = useMemo(
    () => items.map(it => ({ ...it, variants: mergeStock(it.variants, fresh) })),
    [items, fresh.at, fresh.status],
  )
```

底下 `const rows = items.map(...)` 改成 `freshItems.map(...)`。

`picks` 的初始值仍用原始 `items`（首次 render 時 `fresh` 還沒回來，這是對的：
SSR 與首次 client render 要一致，否則 hydration 會不匹配）。

- [ ] **Step 2: 補正後修正已缺貨的選擇**

```js
  // 補正回來時，若某件正選著的規格已賣完，換到同維度第一個有貨的。
  // 這頁一次好幾件卡片，不逐件跳提示 —— 卡片上的缺貨標示已經說明了狀況。
  useEffect(() => {
    if (fresh.status !== 'ready') return
    setPicks(prev => {
      const next = { ...prev }
      let changed = false
      freshItems.forEach(it => {
        const types = activeTypesFor(it.variants, optTypes)
        const cur = prev[it.productId]?.options || {}
        const fixed = { ...cur }
        types.forEach(type => {
          const tid = String(type.id)
          if (!fixed[tid]) return
          if (!isValueSoldOut(it.variants, fixed, type.id, fixed[tid], skipStockFor(it.sp))) return
          const values = valuesFor(type, it.variants)
          const avail = values.find(v => !isValueSoldOut(it.variants, fixed, type.id, v.id, skipStockFor(it.sp)))
          if (avail) { fixed[tid] = avail.id; changed = true }
        })
        next[it.productId] = { ...prev[it.productId], options: fixed }
      })
      return changed ? next : prev
    })
  }, [fresh.at])
```

- [ ] **Step 3: 瀏覽器驗證**

1. 開一個組合頁 → 後台把其中一件的某規格清成 0（不存檔）→ 重新整理 bundle 頁
   → 該 chip 缺貨不可選
2. S3 做的缺貨摘要跟著出現（把某件的所有規格清成 0）
3. 切到別的分頁再回來 → 補正生效
4. 預購商品在組合裡 → 庫存 0 仍可選
5. `/api/stock` 回 500 → 組合頁照常可買

- [ ] **Step 4: Commit**

```bash
git add shop/src/app/bundles/\[id\]/BundleDetail.jsx
git commit -m "feat: 組合商品頁庫存即時補正"
```

---

### Task 5: 加入購物車前驗證

**Files:**
- Modify: `shop/src/app/products/[id]/ProductStateProvider.jsx`（`addToCart`）
- Modify: `shop/src/app/products/[id]/ProductDetail.jsx`（`handleAddToCart`）
- Modify: `shop/src/app/bundles/[id]/BundleDetail.jsx`（`handleAdd`）

- [ ] **Step 1: 商品頁**

`addToCart` 改成 async，送出前先 `refetch`：

```js
  const [addError, setAddError] = useState(null)

  async function addToCart() {
    setAddError(null)
    // 頁面可能開很久了。按下去的這一刻再確認一次，不要讓客人填完整張結帳表才知道沒貨。
    const now = await fresh.refetch()
    if (now) {
      const merged = mergeStock(rawVariants, now)
      const cur = merged.find(v => v.id === currentVariant?.id)
      const left = cur ? cur.stock : mergeQuantity(p.quantity, p.id, now)
      if (!skipStock && left < qty) {
        setAddError(zh
          ? (left > 0 ? `這個規格只剩 ${left} 件了` : '這件剛剛被買走了')
          : (left > 0 ? `Only ${left} left` : 'Just sold out'))
        return
      }
    }
    // refetch 失敗（now 為 null）就照常加入 —— place_order 仍會擋，
    // 把客人卡在「連不到伺服器所以不能買」是更糟的結果
    …（既有的 addItem 與 trackPixel 不變）…
  }
```

`addError` 顯示在加入購物車鈕下方：

```jsx
{addError && <div className="pp-add-error">{addError}</div>}
```

```css
.pp-add-error { font-size: 13px; color: var(--red); margin-top: 8px; line-height: 1.6; }
```

- [ ] **Step 2: `ProductDetail.jsx` 同樣處理**

- [ ] **Step 3: 組合頁**

`handleAdd` 改成 async，送出前 `refetch`，逐件比對。有任何一件不足就不加入，
把該件標成不可選（`picks` 那件 `included: false`）並顯示訊息：

```js
  const [addError, setAddError] = useState(null)

  async function handleAdd() {
    setAddError(null)
    const chosen = rows.filter(r => r.included)
    if (chosen.length === 0) return

    const now = await fresh.refetch()
    if (now) {
      const bad = chosen.filter(r => {
        if (r.skipStock) return false
        const v = r.currentVariant
        const left = v ? (now.variants[v.id] ?? v.stock) : (now.products[r.sp.products.id] ?? 0)
        return left < 1
      })
      if (bad.length) {
        setAddError(zh
          ? `「${bad.map(r => r.name).join('」、「')}」剛剛被買走了，已從這一套移除。`
          : `${bad.map(r => r.name).join(', ')} just sold out and ${bad.length > 1 ? 'were' : 'was'} removed from the set.`)
        setPicks(p => {
          const next = { ...p }
          bad.forEach(r => { next[r.productId] = { ...p[r.productId], included: false } })
          return next
        })
        return
      }
    }
    …（既有的 addItems 與 trackPixel 不變）…
  }
```

- [ ] **Step 4: 瀏覽器驗證**

1. A 停在商品頁 → B 把庫存清成 0 → A **不重新整理**直接按加入購物車
   → 被擋下、顯示「這件剛剛被買走了」、購物車數量沒有變
2. 庫存剩 1 但選了數量 3 → 顯示「這個規格只剩 1 件了」
3. 組合頁同樣的情境 → 該件被移出這一套並顯示訊息，其餘仍可加入
4. `/api/stock` 回 500 → 加入購物車照常成功
5. 預購商品 → 庫存 0 仍可加入

- [ ] **Step 5: Commit**

```bash
git add shop/src/app/products/\[id\]/ProductStateProvider.jsx shop/src/app/products/\[id\]/ProductDetail.jsx shop/src/app/bundles/\[id\]/BundleDetail.jsx shop/src/app/products/\[id\]/product-blocks.css shop/src/app/globals.css
git commit -m "feat: 加入購物車前再確認一次庫存"
```

---

### Task 6: 結帳送出前驗證與錯誤就地呈現

**Files:**
- Modify: `shop/src/app/checkout/page.jsx`（送出流程 `:263` 附近與 `:278-301`）

- [ ] **Step 1: 送出前檢查**

在呼叫 `supabase.rpc('place_order', …)`（`:278`）之前插入：

```js
  // 購物車可能放了很久。送出前再確認一次，不要在 place_order 丟例外之後才用 alert 打回票。
  const ids = [...new Set(cart.map(i => Number(i.id)).filter(Boolean))]
  let shortages = []
  if (ids.length) {
    try {
      const res = await fetch('/api/stock', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds: ids }),
      })
      if (res.ok) {
        const now = await res.json()
        shortages = cart.filter(i => {
          // 預購／收單品項不看庫存，與 place_order 第 78-80 行的規則一致
          if (i.isCollection) return false
          const left = i.variantId ? now.variants[i.variantId] : now.products[i.id]
          return left != null && left < i.qty
        }).map(i => ({
          key: `${i.id}-${i.variantId ?? ''}`,
          name: i.name,
          variantLabel: i.variantLabel,
          want: i.qty,
          left: (i.variantId ? now.variants[i.variantId] : now.products[i.id]) ?? 0,
        }))
      }
    } catch {
      // 查不到就放行，交給 place_order 擋
    }
  }
  if (shortages.length) { setStockIssues(shortages); setSubmitting(false); return }
```

- [ ] **Step 2: 就地呈現與兩個動作**

加 state 與畫面（放在購物車摘要區塊上方，不要用 alert）：

```jsx
{stockIssues.length > 0 && (
  <div className="checkout-stock-issue">
    <div className="checkout-stock-title">
      {zh ? '有商品的庫存不夠了' : 'Some items are no longer available'}
    </div>
    <ul className="checkout-stock-list">
      {stockIssues.map(s => (
        <li key={s.key}>
          {s.name}{s.variantLabel ? `（${s.variantLabel}）` : ''}　
          {zh ? `你要 ${s.want} 件，只剩 ${s.left} 件` : `you want ${s.want}, only ${s.left} left`}
        </li>
      ))}
    </ul>
    <div className="checkout-stock-actions">
      <button type="button" className="btn-outline" onClick={dropShortItems}>
        {zh ? '移除這幾件' : 'Remove them'}
      </button>
      <button type="button" className="btn-primary" onClick={clampShortItems}>
        {zh ? '改成剩餘數量' : 'Use remaining quantity'}
      </button>
    </div>
  </div>
)}
```

兩個動作用購物車既有的 API（`useCart` 的 `removeItem` / `updateQty`，
確切名稱以 `shop/src/app/layout.jsx` 的實作為準）：

```js
function dropShortItems() {
  stockIssues.forEach(s => removeItem(s.key))
  setStockIssues([])
}
function clampShortItems() {
  // 剩 0 的直接移除，其餘改成剩餘數量
  stockIssues.forEach(s => (s.left > 0 ? updateQty(s.key, s.left) : removeItem(s.key)))
  setStockIssues([])
}
```

- [ ] **Step 3: `place_order` 失敗也改成就地呈現**

`:300-301` 的 `alert(errMsg)` 換成把訊息放進同一塊區域：

```js
      setPlaceError(errMsg)   // 顯示在 stockIssues 同一塊，樣式共用
      setSubmitting(false)
      return
```

`append_to_order` 的 `alert`（`:137`）與優惠券的 `alert`（`:263`）**不在這份範圍內**，維持原樣。

- [ ] **Step 4: 樣式**

```css
/* 結帳的庫存問題：需要客人動手處理，所以是有邊框的區塊而不是一行小字。
   不加底色 —— 結帳頁已經夠花了。 */
.checkout-stock-issue {
  border: 1px solid var(--red); border-radius: var(--r-card);
  padding: 14px 16px; margin-bottom: 16px;
}
.checkout-stock-title { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
.checkout-stock-list { font-size: 13px; line-height: 1.8; color: var(--text-2); margin: 0 0 12px; padding-left: 18px; }
.checkout-stock-actions { display: flex; gap: 8px; flex-wrap: wrap; }
```

- [ ] **Step 5: 瀏覽器驗證**

1. A 把商品加入購物車 → B 把庫存清成 0 → A 進結帳填完資料按送出
   → **不送出**，出現「有商品的庫存不夠了」並列出品名與剩餘數
2. 按「移除這幾件」→ 該品項從購物車消失 → 再按送出 → 下單成功
3. 重來一次，庫存剩 1 但買 3 → 按「改成剩餘數量」→ 數量變 1 → 送出成功
4. 預購商品（`isCollection`）→ 庫存 0 仍可順利下單
5. 把 `/api/stock` 改成 500 → 結帳照常送出；若真的沒貨，`place_order` 的錯誤訊息
   顯示在同一塊區域，**不是 alert**
6. 一切正常時 → 結帳流程與改動前完全一樣，沒有多出任何提示

- [ ] **Step 6: Commit**

```bash
git add shop/src/app/checkout/page.jsx shop/src/app/globals.css
git commit -m "feat: 結帳送出前確認庫存，錯誤就地顯示"
```

---

### Task 7: 合併回 main

- [ ] **Step 1: 完整回歸**

- Task 1 Step 4 的成本外洩檢查
- Task 3 Step 5 的八項、Task 4 Step 3 的五項、Task 5 Step 4 的五項、Task 6 Step 5 的六項
- 額外：從商品頁一路買到下單成功走一次完整流程，確認沒有多出來的攔截

- [ ] **Step 2: 合併**

```bash
git checkout main
git merge feat/stock-freshness
```

Track B 到此結束。
