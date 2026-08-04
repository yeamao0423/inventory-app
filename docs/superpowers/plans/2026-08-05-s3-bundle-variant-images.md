# S3 組合商品規格連動照片與缺貨呈現 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 組合商品頁選規格時照片跟著換，並把「哪幾件缺貨」明白說出來。

**Architecture:** 把散在兩個檔案的 `imageMatches` / `repImageFor` 收成一支共用模組，組合商品頁改用它挑圖。缺貨的呈現從「只有視覺」補上語意與頁面層的點名。

**Tech Stack:** Next.js 14 App Router（商城）、React 18

**Spec:** `docs/superpowers/specs/2026-08-05-s3-bundle-variant-images-design.md`

## Global Constraints

- 分支 `feat/bundle-variant-images`，在自己的 git worktree 執行。
- **`shop/` 沒有測試 runner**（`shop/package.json` 只有 next/react），這次**不引入**。每個 Task 的驗收都是瀏覽器步驟，逐項做完才算完成。
- 不新增任何依賴（runtime 或 dev）。圖示沿用內嵌 SVG 的既有慣例，不裝 icon 套件。
- 文案一律中英雙語（這幾頁都走 `zh ? '…' : '…'`）。
- **商城 dev server 在跑時不要跑 `npm run build`**（會弄壞 `.next`）。
- 本機商城 :3000、後台 :5173。後台帳號 `owner@daigogo.dev` / `localdev123`。
- 庫存改動不會自動讓商城快取失效（那是 S4 要解的）。這份的驗收要看到庫存變化時，**在後台商品頁存一次檔**觸發 revalidate。
- commit message 用繁體中文、簡潔，不要加 Co-Authored-By。

---

## File Structure

| 檔案 | 責任 |
|---|---|
| `shop/src/lib/variantImages.js`（新） | 規格 ↔ 圖片對應的純函式。零依賴、無 React |
| `shop/src/app/products/[id]/ProductDetail.jsx`（改） | 刪本地副本，改 import |
| `shop/src/app/products/[id]/ProductStateProvider.jsx`（改） | 同上 |
| `shop/src/app/bundles/[id]/BundleDetail.jsx`（改） | 連動圖、chip 縮圖、缺貨點名 |
| `shop/src/app/globals.css`（改） | 缺貨摘要與卡片閃爍的樣式 |

---

### Task 1: 抽出共用的規格圖片函式

**Files:**
- Create: `shop/src/lib/variantImages.js`
- Modify: `shop/src/app/products/[id]/ProductDetail.jsx`（刪 `:315-331`、加 import）
- Modify: `shop/src/app/products/[id]/ProductStateProvider.jsx`（刪 `:173-190` 附近的兩支、加 import）

**Interfaces:**
- Produces:
  - `imageMatches(img, selectedOptions) => boolean`
  - `repImageFor(images, typeId, valueId) => image | null`
  - `visibleImages(sortedImages, selectedOptions) => image[]`
- Task 2、3 只吃這三支。

- [ ] **Step 1: 建立 `shop/src/lib/variantImages.js`**

```js
// 規格對應圖片的純函式。商品詳情頁、編排版商品頁、組合商品頁三處共用。
//
// tag_filter 是每張圖選擇性綁定的規格值（migration 20250033）：
//   null          → 共用圖，任何規格都顯示
//   某維度沒有 key → 該維度不設限
//   {"3":[7,9]}   → 只有第 3 種規格選到 7 或 9 時才顯示
//
// 這三支原本各自散在 ProductDetail.jsx 與 ProductStateProvider.jsx，內容相同。
// 組合商品頁要用第三次，所以收成一份 —— 三份副本必然漂移。
//
// 壞資料是前提不是例外：tag_filter 由店主在後台手動綁，任何形狀都可能出現。
// 這裡的每一支都必須「不丟例外」，看不懂的一律當作不設限。

/** 這張圖在目前選到的規格下該不該顯示。 */
export function imageMatches(img, selectedOptions) {
  const tf = img?.tag_filter
  if (!tf || typeof tf !== 'object') return true
  return Object.entries(tf).every(([typeId, vals]) => {
    if (!Array.isArray(vals) || vals.length === 0) return true
    const sel = selectedOptions?.[typeId]
    return sel == null || vals.map(Number).includes(Number(sel))
  })
}

/** 某規格值的代表圖：images 需已依 sort_order 排序，取第一張綁到該值的圖。 */
export function repImageFor(images, typeId, valueId) {
  return (images || []).find(img => {
    const allowed = img?.tag_filter?.[String(typeId)]
    return Array.isArray(allowed) && allowed.map(Number).includes(Number(valueId))
  }) || null
}

/**
 * 目前該顯示哪幾張圖。
 * 過濾後為空就退回全部 —— 該規格沒有專屬圖也沒有共用圖時不能開天窗。
 * 這個 fallback 是既有行為（ProductDetail.jsx 原本的第 44 行），拿掉會讓某些商品的圖庫整個消失。
 */
export function visibleImages(sortedImages, selectedOptions) {
  const all = sortedImages || []
  const matched = all.filter(img => imageMatches(img, selectedOptions))
  return matched.length ? matched : all
}
```

- [ ] **Step 2: `ProductDetail.jsx` 改用它**

刪掉 `:315-331` 的 `imageMatches` 與 `repImageFor` 定義，頂端 import 區加：

```js
import { repImageFor, visibleImages } from '../../../lib/variantImages'
```

`:43-44` 兩行併成一行：

```js
const visible = visibleImages(sortedImages, selectedOptions)
```

（原本的 `matched` / `visibleImages` 區域變數改名為 `visible`，避免與 import 進來的函式同名。
`:146` 的 `<ImageGallery key={…} images={visibleImages} …>` 跟著改成 `images={visible}`，
`key` 那行的 `visibleImages.map` 也改。）

- [ ] **Step 3: `ProductStateProvider.jsx` 改用它**

刪掉檔尾 `export function imageMatches` 與 `export function repImageFor`（`:173`、`:184`），頂端加：

```js
import { repImageFor, visibleImages } from '../../../lib/variantImages'
```

`:56-58` 兩行併成：

```js
const visible = visibleImages(sortedImages, selectedOptions)
```

並把後續用到 `visibleImages` 這個變數的地方改成 `visible`。

**這兩支原本是 export 的**，先搜尋整個 `shop/` 有沒有別的檔案在 import 它們：

```bash
cd shop && grep -rn "imageMatches\|repImageFor" src/
```

有的話一併改成從 `lib/variantImages` 取。

- [ ] **Step 4: 回歸驗證（這一步在守既有行為）**

前置：後台隨便挑一件有規格的商品，在圖片管理把一張圖綁到「藍色」、另一張綁到「紅色」、
第三張不綁（共用）。存檔（順便觸發 revalidate）。

```bash
cd shop && npm run dev    # :3000
```

1. 商品詳情頁 → 切到藍色 → 只顯示藍色圖 + 共用圖
2. 切到紅色 → 只顯示紅色圖 + 共用圖
3. 切到一個沒綁任何圖的規格值 → **顯示全部的圖**（不是空白）
4. 規格 chip 上有代表圖的仍然顯示小圖
5. 找一個編排過版面的商品（或在後台範本頁編一個）→ 重複 1-3，走的是 `ProductStateProvider` 那條路
6. Console 沒有錯誤

Expected: 六項全部與改動前一致。

- [ ] **Step 5: Commit**

```bash
git add shop/src/lib/variantImages.js shop/src/app/products/\[id\]/ProductDetail.jsx shop/src/app/products/\[id\]/ProductStateProvider.jsx
git commit -m "refactor: 規格對應圖片的函式收成一份"
```

---

### Task 2: 組合商品卡片的圖跟著規格切換

**Files:**
- Modify: `shop/src/app/bundles/[id]/BundleDetail.jsx`（頂端 import、`resolveItem` `:451-463`、卡片圖片 `:245-254`）
- Modify: `shop/src/app/globals.css`（淡入）

**Interfaces:**
- Consumes: `visibleImages`（Task 1）

- [ ] **Step 1: `resolveItem` 依規格挑圖**

頂端加：

```js
import { repImageFor, visibleImages } from '../../../lib/variantImages'
```

`resolveItem` 內 `:451` 那兩行改成：

```js
  const images = [...(p.product_images || [])].sort((a, b) => a.sort_order - b.sort_order)
  // 選了什麼規格就顯示對應的圖。與商品詳情頁同一支函式，行為一致。
  const shown = visibleImages(images, options)
```

回傳物件的 `image` 改成 `shown[0]?.url || null`，並多回一個 `images`（Task 3 的 chip 縮圖要用）：

```js
    image: shown[0]?.url || null,
    images,
```

`resolveItem` 已經收到 `options`，簽名不用改。

- [ ] **Step 2: 圖片換掉時淡入**

`:245-254` 的 `<img>` 加 `key`，讓它在圖片換掉時重新掛載：

```jsx
<Link href={productHref} className="bundle-card-media">
  {r.image && <img key={r.image} src={r.image} alt={r.name} loading="lazy" className="bundle-card-img" />}
  …（旗標不變）…
</Link>
```

`globals.css` 的「組合商品落地頁」段加：

```css
/* 規格切換時換圖：淡入 120ms。不做交叉淡出或滑動 ——
   這頁一次顯示好幾張卡，動得太多會搶掉「選規格」這個主要動作的注意力。 */
.bundle-card-img { animation: bundleImgIn .12s var(--ease-out); }
@keyframes bundleImgIn { from { opacity: .35 } to { opacity: 1 } }
@media (prefers-reduced-motion: reduce) { .bundle-card-img { animation: none } }
```

- [ ] **Step 3: 瀏覽器驗證**

前置：把 Task 1 那件綁過圖的商品放進一個已發佈的組合（後台組合商品頁）。

1. 打開 `/bundles/<id>` → 該商品的卡片顯示第一張符合預設規格的圖
2. 點「藍色」→ 卡片主圖換成藍色的圖，有淡入
3. 點「紅色」→ 換成紅色的圖
4. 點一個沒綁圖的規格值 → 顯示第一張圖（不是空白、不報錯）
5. 組合裡另一件**完全沒綁圖**的商品 → 切規格圖不動，Console 沒有錯誤
6. 開系統「減少動態效果」→ 圖直接換，沒有動畫

- [ ] **Step 4: Commit**

```bash
git add shop/src/app/bundles/\[id\]/BundleDetail.jsx shop/src/app/globals.css
git commit -m "feat: 組合商品選規格時照片跟著換"
```

---

### Task 3: 規格 chip 顯示代表圖

**Files:**
- Modify: `shop/src/app/bundles/[id]/BundleDetail.jsx`（規格 chip `:288-310`）

**Interfaces:**
- Consumes: `repImageFor`（Task 1）、`r.images`（Task 2 Step 1 新增的回傳欄位）

- [ ] **Step 1: chip 加縮圖**

`.spec-chip-img` 樣式已經存在（`globals.css:382`），商品詳情頁在用同一套。
把 `:296-305` 的 chip 改成：

```jsx
{values.map(val => {
  const isSelected = r.options[String(type.id)] === val.id
  const soldOut = isValueSoldOut(r.variants, r.options, type.id, val.id, r.skipStock)
  const rep = repImageFor(r.images, type.id, val.id)
  return (
    <button
      key={val.id}
      className={`spec-chip${isSelected ? ' selected' : ''}`}
      onClick={() => !soldOut && pickOption(r.productId, type.id, val.id)}
      disabled={soldOut}
      aria-pressed={isSelected}
    >
      {rep && <img className="spec-chip-img" src={rep.url} alt="" loading="lazy" />}
      {val.value}
    </button>
  )
})}
```

- [ ] **Step 2: 瀏覽器驗證**

1. 綁了圖的規格值 → chip 左側出現 30px 圓形縮圖
2. 沒綁圖的規格值 → 只有文字，chip 高度與有圖的一致（不會忽高忽低）
3. 選中狀態的 chip 縮圖仍看得清楚（深色底不會把圖吃掉）
4. 商品詳情頁的 chip 沒有變化（那邊本來就有這個功能）

- [ ] **Step 3: Commit**

```bash
git add shop/src/app/bundles/\[id\]/BundleDetail.jsx
git commit -m "feat: 組合商品規格 chip 顯示代表圖"
```

---

### Task 4: 缺貨說得出來

**Files:**
- Modify: `shop/src/app/bundles/[id]/BundleDetail.jsx`（chip 語意、清單標題下的摘要、不適用套裝價的原因）
- Modify: `shop/src/app/globals.css`（摘要與卡片閃爍樣式）

- [ ] **Step 1: 缺貨 chip 加語意**

Task 3 那段 chip 補兩個屬性（視覺已經有刪除線與透明度，但色弱與讀屏收不到）：

```jsx
      disabled={soldOut}
      aria-pressed={isSelected}
      aria-label={soldOut ? `${val.value}（${zh ? '已售完' : 'sold out'}）` : undefined}
      title={soldOut ? (zh ? '已售完' : 'Sold out') : undefined}
```

- [ ] **Step 2: 清單標題下加缺貨摘要**

在 `:222-232` 的 `<Reveal>` 區塊內、`.bundle-items-sub` 之後加。先算出缺貨的品項：

```js
// rows 已經算好 unavailable，直接挑出來。已下架的走 missingProductIds 那條既有路徑。
const soldOutRows = rows.filter(r => r.unavailable)
```

```jsx
{soldOutRows.length > 0 && (
  <p className="bundle-sold-note">
    {zh
      ? <>這一套有 {soldOutRows.length} 件目前缺貨：{soldOutRows.map((r, i) => (
          <span key={r.productId}>
            {i > 0 && '、'}
            <button type="button" className="bundle-sold-link" onClick={() => focusCard(r.productId)}>
              {r.name}
            </button>
          </span>
        ))}。缺貨的不列入結帳，其餘仍可以原價購買。</>
      : <>{soldOutRows.length} item(s) in this set are sold out: {soldOutRows.map((r, i) => (
          <span key={r.productId}>
            {i > 0 && ', '}
            <button type="button" className="bundle-sold-link" onClick={() => focusCard(r.productId)}>
              {r.name}
            </button>
          </span>
        ))}. They are excluded from checkout; the rest can still be bought at regular price.</>}
  </p>
)}
```

捲動函式（放在 `toggle` / `pickOption` 旁邊）：

```js
// 點品名捲到那張卡並閃一下。block:'center' 是為了避開黏底購買列 ——
// 用 'start' 的話卡片底部會被那條列擋住。
function focusCard(productId) {
  const el = document.getElementById(`bundle-card-${productId}`)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el.classList.remove('is-flash')
  // 強制重排，否則連點兩次不會重播動畫
  void el.offsetWidth
  el.classList.add('is-flash')
}
```

卡片要有 id —— `:239-244` 的 `<Reveal as="article" …>` 加 `id={`bundle-card-${r.productId}`}`。
（`Reveal` 若不透傳未知 props，改成在它外層包一個 `<div id=…>`；先確認 `shop/src/app/Reveal.jsx` 的實作。）

- [ ] **Step 3: 不適用套裝價的原因寫清楚**

`:199-203` 那段的 `selection.complete === false` 分支，把「少了 N 件」改成點名：

```jsx
: (zh
    ? `套裝價只在整套齊全時成立。目前少了 ${selection.totalCount - selection.includedCount} 件${
        soldOutRows.length ? `（${soldOutRows.map(r => r.name).join('、')}）` : ''
      }，其餘以原價購買。`
    : `The bundle price applies only to the complete set. ${selection.totalCount - selection.includedCount} item(s) are missing${
        soldOutRows.length ? ` (${soldOutRows.map(r => r.name).join(', ')})` : ''
      }, so the rest are at regular price.`)
```

- [ ] **Step 4: 樣式**

`globals.css` 的組合商品段加：

```css
/* 缺貨摘要：說明性文字，不是警示框。加底色只會讓它跟旁邊的套裝價卡片打架。 */
.bundle-sold-note {
  font-size: 13.5px; line-height: 1.7; color: var(--text-2);
  max-width: var(--measure); margin-top: 10px;
}
.bundle-sold-link {
  background: none; border: none; padding: 0; cursor: pointer;
  font: inherit; color: var(--text); font-weight: 600;
  text-decoration: underline; text-underline-offset: 2px;
}
.bundle-card.is-flash { animation: cardFlash 1.1s var(--ease-out); }
@keyframes cardFlash {
  0%, 100% { box-shadow: 0 0 0 0 transparent }
  20%      { box-shadow: 0 0 0 2px var(--brand, var(--text)) }
}
@media (prefers-reduced-motion: reduce) { .bundle-card.is-flash { animation: none } }
```

- [ ] **Step 5: 瀏覽器驗證**

前置：後台把組合裡某一件商品的**所有**規格庫存改成 0，並在後台商品頁存一次檔觸發 revalidate。

1. bundle 頁 → 清單標題下出現缺貨摘要，點名那件商品
2. 點摘要裡的品名 → 平順捲到那張卡、卡片閃一下外框、**沒有被黏底購買列擋住**
3. 再點一次同一個品名 → 動畫重播（不是只閃第一次）
4. 把第二件也清成 0 → 摘要列出兩個品名，中間有「、」
5. 全部有貨 → 摘要**不出現**（不是空白一行）
6. 只有單一規格缺貨（不是整件）→ 該 chip 刪除線且不可點，滑上去有「已售完」tooltip，
   摘要**不出現**（那件還買得到）
7. 開 VoiceOver 移到缺貨 chip → 唸得出「已售完」
8. 切英文 → 1-6 的文案都是英文且通順
9. 有商品已下架時 → 既有的「有商品已下架」文案照舊出現，不與缺貨摘要衝突

- [ ] **Step 6: Commit**

```bash
git add shop/src/app/bundles/\[id\]/BundleDetail.jsx shop/src/app/globals.css
git commit -m "feat: 組合商品明白點名哪幾件缺貨"
```

---

### Task 5: 合併回 main

- [ ] **Step 1: 從頭跑一次完整驗收**

Task 1 Step 4 的六項回歸（**最重要**，守的是商品詳情頁沒被抽壞）+ Task 2/3/4 的驗收。

- [ ] **Step 2: 合併**

```bash
git checkout main
git merge feat/bundle-variant-images
```

- [ ] **Step 3: 通知 S4 可以開工**

S4（`feat/stock-freshness`）會改到同樣這幾支檔案，它的前置條件就是這支合併完成。
