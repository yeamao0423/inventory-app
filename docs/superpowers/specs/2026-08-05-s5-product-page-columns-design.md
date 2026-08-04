# S5 — 商品頁編排：欄容器版面模型

**日期**：2026-08-05
**分支**：`feat/product-page-columns`
**Track**：C（獨立，可與 A、B 同時進行）
**規模**：大

---

## 背景

商品頁編排器的版面模型是「一維順序 + 每塊一個欄寬」：區塊依序流進一個十二欄格線，
每塊吃 `span` 欄（`shop/src/app/products/[id]/ProductPageView.jsx` 的 `.blk-grid.pp-grid`、
`product-blocks.css:22`）。

CSS 沒有壞——兩個相鄰的 `span 6` **確實**會並排。壞的是模型本身：

Grid 的 auto-flow 是逐列填，**新的一列從最高那格的下緣開始**。圖庫很高、標題很矮，
於是「圖庫｜標題」佔掉第一列之後，第三塊（價格）掉到**圖庫下面**，而不是接在標題底下。
右欄從標題到列底整片空白。

換句話說：這個模型畫不出「左邊一根長圖、右邊一疊資訊」——而那是商品頁最基本的版型。
預設範本九塊全是 `span 6`（`src/lib/contentBlocks.js:337-347`），所以店主一進編排器
看到的就是這種鋸齒。

## 目標

讓店主排得出真正的多欄版面，並把預設範本改成「左圖右資訊」。

## 非目標（第一階段）

- **不做預覽 iframe 內的直接拖放**。清單樹先能拖、iframe 負責點選與高亮。
  iframe 內拖放要處理跨 frame 座標換算、自動捲動、drag image，值得單獨一份 spec。
- **不做自由座標格線**（每塊存 col/row 起訖）。已評估並否決：要手寫拖拉、縮放、
  碰撞偵測與 RWD 降級，而且店主容易排出手機版壞掉的版面。
- 首頁編排（`home_blocks`）**不開放**欄容器。首頁的渲染器（`BlocksView`）根本不吃 `span`，
  放進去只會得到畫不出來的空殼。
- 不改既有的 `product_*` 區塊各自的設定與外觀。

---

## 設計

### 一、資料形狀

`src/lib/contentBlocks.js` 新增一個型別：

```js
{
  id: 'columns-xxx',
  type: 'columns',
  columns: [
    { id: 'col-xxx', span: 6, blocks: [ …子區塊… ] },
    { id: 'col-yyy', span: 6, blocks: [ … ] },
  ],
}
```

規則：

- `columns` **沒有自己的 `span`**，一律吃滿整列。內部的欄再分十二格。
  （少一個維度就少一種店主排不出來的組合。）
- **巢狀限一層**：`column.blocks` 的放行清單移除 `'columns'`，從正規化層根絕無限巢狀。
- 欄數 **2 或 3**。比例預設 6/6、4/8、8/4、4/4/4，也可用既有的 `SPANS` 自訂。
- 各欄 span 加總不必等於 12——grid 會自己處理，硬性限制只會擋住合理的排法（例如 4/4 靠左）。
- `columns` 只出現在 `PRODUCT_BLOCK_TYPES` 那一組的放行清單裡，`BLOCK_TYPES`（首頁）不含它。

### 二、正規化

`normalizeBlock` 改成可遞迴：

```js
function normalizeBlock(raw, index, allow)
  // type === 'columns' 時：
  //   columns 陣列 → 每欄 { id, span: oneOf(span, SPANS, 6), blocks: [遞迴，allow 移除 'columns'] }
  //   欄數夾在 2..3；少於 2 補到 2，多於 3 截掉
  //   壞掉的欄（不是物件、blocks 不是陣列）→ 視為空欄，不丟例外
```

- `MAX_BLOCKS`（60）改成**算巢狀總數**，避免 60 個欄容器各塞 60 個子塊。
  超過上限時從後面截掉，不丟例外。
- 一個 `columns` 底下**所有欄都空**時仍保留（店主可能正在編排中途），
  渲染層負責讓它不佔位。
- 舊資料（flat、沒有 `columns`）完全不受影響——這是相容性的底線。

### 三、編輯操作改成走路徑

現有的 `moveBlock` / `duplicateBlock` / `removeBlock` / `replaceBlock` 吃的是扁平索引，
首頁編排器（`BlocksEditor`）也在用。

改法：實作一組**路徑版**，把現有四支變成它們的薄包裝（`removeBlock(b, i) === removeBlockAt(b, [i])`），
首頁那邊一行都不用改。

```js
// path: [blockIndex] 或 [columnsIndex, columnIndex, childIndex]
export function insertBlockAt(blocks, path, block)
export function removeBlockAt(blocks, path)
export function replaceBlockAt(blocks, path, next)
export function duplicateBlockAt(blocks, path)
export function moveBlockAt(blocks, path, dir)      // 在自己的容器內上下移，不跨容器
export function moveBlockTo(blocks, fromPath, toPath) // 拖拉用，可跨容器
export function getBlockAt(blocks, path)
```

全部回新陣列，不就地改動（與現有慣例一致）。路徑非法（越界、指向不存在的欄）一律回原陣列，
不丟例外——編輯器的 state 與使用者的手速之間本來就會有競態。

### 四、渲染

`shop/src/app/products/[id]/ProductPageView.jsx`：把區塊 → 儲存格那段抽成一支遞迴函式。

```jsx
// columns 畫成一個 span 12 的儲存格，內部再一層十二欄 grid
<div className="pp-cell pp-columns" style={{ '--pp-span': 12 }} data-block-id={editing ? block.id : undefined}>
  <div className="blk-grid">
    {block.columns.map(col => (
      <div key={col.id} className="pp-col" style={{ '--pp-span': col.span }}>
        {col.blocks.map(child => renderCell(child))}
      </div>
    ))}
  </div>
</div>
```

`product-blocks.css` 補：

- `.pp-col { grid-column: span var(--pp-span, 12); min-width: 0; display: flex; flex-direction: column; gap: var(--space-5); }`
  欄內是垂直堆疊，不是又一層格線——欄的意義就是「這一疊東西排在一起」。
- 900px 以下 `.pp-col { grid-column: span 12 }`（沿用現有那條 media query 的斷點）。
- 整欄的子區塊都畫不出東西時整欄不佔位；`columns` 底下所有欄都空時整塊不佔位。
  編輯模式下仍要看得見（沿用 `.pp-editing .pp-cell:empty` 的做法）。

`product_cta` 的 `anchorRef` 要能傳進巢狀——遞迴時往下傳，判斷條件不變（`block.type === 'product_cta'`）。
黏底購買列的 `useBuyBar` key 目前是 `blocks.map(b => b.id).join(',')`，
改成把巢狀 id 也攤平進去，否則店主在欄裡搬動 CTA 時 observer 不會重掛。

編輯模式的 `data-block-id` 對巢狀子塊也要吐，點選才點得到。

### 五、編輯器

`src/components/ProductPageEditor.jsx`：

- 清單變成兩層樹：`columns` 節點顯示「欄容器・2 欄」，可展開，子區塊縮排一階。
- 拖拉落點多兩種：**拖到某欄的子清單內**、**拖出來變成頂層**。
  既有的「以項目中線決定插在上面還是下面」邏輯照用，只是要判斷落在哪個容器。
- ↑↓ 按鈕維持在自己的容器內移動（鍵盤與觸控的備援）。
- 「加入區塊」多一個「**欄容器**」，選 2 欄或 3 欄，建立時各欄為空。
- 刪除 `columns` 且裡面有東西 → 確認對話框寫明「裡面的 N 個區塊會一起刪掉」。
- 刪除單一欄 → **把該欄的子區塊移到前一欄**（沒有前一欄就移到後一欄），不要靜靜刪掉內容。

`src/components/BlockInspector.jsx`：選中 `columns` 時顯示它自己的設定——
欄數（2/3）、比例預設（6/6、4/8、8/4、4/4/4）、各欄自訂 span。
`SpanField` 對 `columns` 型別不顯示（它沒有自己的 span）。

### 六、預設範本

`buildProductTemplate()` 改成回傳：

```
columns
├─ column span=6  → product_gallery
└─ column span=6  → product_title, product_price, product_desc,
                     product_options, product_status, product_qty,
                     product_note, product_cta
```

這就是「左邊一根長圖、右邊一疊資訊」，也順手修掉一進編排器就是鋸齒的問題。

`mergeIntroIntoTemplate` 不變——既有的 `intro_blocks` 仍接在最後、各佔滿版一列。

### 七、雙胞胎同步

`src/lib/contentBlocks.js` 與 `shop/src/lib/contentBlocks.js` 是刻意維護的副本
（Next.js 專案獨立，無法跨 package import，見兩份檔頭）。
這次的改動**兩份都要改，內容必須一致**。測試只放後台那份（`src/lib` 有 vitest）。

---

## 資料流

```
後台編排器（blocks 陣列，含巢狀）
  ├─ 存檔 → stores 的商品頁範本 / storefront_products 的覆寫（jsonb）
  └─ postMessage → 商城 /preview/live → LiveCanvas
                     └─ normalizeProductContent（同一支，自動支援 columns）
                        └─ ProductPageView（同一支渲染器）

商城正式頁 → resolveProductContent(override → template → null)
              └─ null 就走既有的 ProductDetail（安全閥，不動）
```

## 錯誤處理

| 情況 | 行為 |
|---|---|
| `columns` 底下又出現 `columns` | 正規化時丟棄（放行清單不含它），不丟例外 |
| 欄數 < 2 或 > 3 | 補到 2 / 截到 3 |
| 某欄的 `blocks` 不是陣列 | 視為空欄 |
| 巢狀總數超過 `MAX_BLOCKS` | 從後面截掉 |
| 舊的 flat 資料 | 原樣渲染，與這次改動之前一模一樣 |
| 整個 `columns` 沒有可畫的內容 | 正式站不佔位；編輯器裡看得見（否則選不到也刪不掉） |

---

## 驗收清單

**純函式（vitest，`npm run test`，寫在 `src/lib/contentBlocks.test.js`）**：

1. `normalizeProductContent` 正確處理巢狀 `columns`
2. `columns` 內的 `columns` 被丟棄
3. 欄數夾在 2..3；壞掉的欄變空欄；壞資料不丟例外
4. 巢狀總數受 `MAX_BLOCKS` 限制
5. 舊的 flat 內容正規化後與改動前完全相同（回歸測試）
6. `insertBlockAt` / `removeBlockAt` / `replaceBlockAt` / `duplicateBlockAt` /
   `moveBlockAt` / `moveBlockTo` 對頂層與巢狀路徑都正確，非法路徑回原陣列
7. `removeBlock` 等四支舊 API 行為不變（首頁編排器靠它們）
8. `buildProductTemplate()` 回傳的是新的欄容器結構

**編輯器（瀏覽器）**：

9. 全店範本頁 → 新店首次進入 → 看到「左圖右資訊」，不是鋸齒
10. 加入欄容器（2 欄）→ 把區塊拖進左欄、右欄 → 預覽即時反映
11. 改欄比例 4/8 → 預覽跟著變
12. 把區塊從左欄拖到右欄、從欄裡拖到頂層、從頂層拖進欄 → 都正確
13. ↑↓ 按鈕在欄內移動，不會跳出容器
14. 刪除有內容的欄容器 → 確認訊息寫明會刪掉幾個區塊
15. 刪除單一欄 → 內容移到相鄰欄，沒有消失
16. 點預覽裡的巢狀區塊 → 左側切到該塊的設定
17. 滑過清單裡的巢狀區塊 → 預覽把它框起來

**商城（瀏覽器）**：

18. 發佈後的商品頁版面與預覽一致
19. 桌機兩欄、900px 以下堆疊
20. `product_cta` 放在右欄 → 捲過去之後黏底購買列接手；把它搬到別的欄仍正常
21. 沒有規格的商品配上 `product_options` → 該區塊不佔位，版面沒有空洞
22. **回歸**：沒編排過的店（`resolveProductContent` 回 null）仍走 `ProductDetail`，
    畫面與改動前一模一樣
23. **回歸**：已存過舊 flat 範本的店 → 版面與改動前一模一樣
24. **回歸**：首頁編排器完全不受影響，加不到欄容器

---

## 涉及檔案

- 改 `src/lib/contentBlocks.js` + `src/lib/contentBlocks.test.js`
- 改 `shop/src/lib/contentBlocks.js`（與上面保持一致）
- 改 `src/components/ProductPageEditor.jsx`
- 改 `src/components/BlockInspector.jsx`
- 改 `shop/src/app/products/[id]/ProductPageView.jsx`
- 改 `shop/src/app/products/[id]/product-blocks.css`
- 可能改 `shop/src/lib/useBuyBar.js`（key 要含巢狀 id）

## 風險

- **兩份 `contentBlocks.js` 漂移**是這份最可能出的錯。改完逐行 diff 兩份，只有註解可以不同。
- 路徑版操作若有 off-by-one，店主拖一次就會弄丟自己的排版。第 6 項測試是守門的。
- `resolveProductContent` 的「null 走舊版型」是整個功能的安全閥，
  第 22 項回歸測試不可跳過。
- 商城 dev server 在跑時不要跑 `npm run build`。

## 後續（不在這一份）

- 預覽 iframe 內的直接拖放。
- 首頁是否也要欄容器（要先讓 `BlocksView` 吃 `span`）。
