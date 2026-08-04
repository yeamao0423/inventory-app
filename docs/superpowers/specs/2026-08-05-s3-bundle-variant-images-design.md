# S3 — 組合商品：規格連動照片與缺貨呈現

**日期**：2026-08-05
**分支**：`feat/bundle-variant-images`
**Track**：B（第 1 支，完成合併後才輪到 S4）
**規模**：小

---

## 背景

### 規格對應照片

`product_images.tag_filter` 是「這張圖屬於哪些規格值」的綁定
（`supabase/migrations/20250033_image_variant_tag.sql`），格式 `{"<option_type_id>": [<value_id>, …]}`，
`null` 表示共用圖。

商品詳情頁吃這個欄位：選了「藍色」就只顯示綁到藍色的圖
（`ProductDetail.jsx:43-44`、`ProductStateProvider.jsx:56-58`）。

**組合商品落地頁沒有。** `getBundleDetail` 已經把 `tag_filter` 撈下來了
（`shop/src/lib/data.js:288`），但 `BundleDetail.jsx:451-463` 的 `resolveItem` 一律取
`images[0]`，完全不看目前選了什麼規格。所以在 bundle 頁把尺寸／顏色切來切去，圖不會動。

### 三份副本

`imageMatches` / `repImageFor` 目前存在兩份：

- `shop/src/app/products/[id]/ProductStateProvider.jsx:173,184`（有 export）
- `shop/src/app/products/[id]/ProductDetail.jsx:315,326`（私有副本，內容相同）

再讓 bundle 抄第三份就是製造第三個會漂移的地方。

### 缺貨呈現

逐規格的缺貨鎖定**已經做了**：`isValueSoldOut` 算出該值在目前其他維度的選擇下有沒有貨，
沒貨就 `disabled`（`BundleDetail.jsx:296-305`），樣式是刪除線 + 40% 透明（`globals.css:381`）。
整件售完會標「已售完」、勾選鈕消失、卡片變灰（`:247-271`）。

缺的是**提醒**：

- 頁面層只說「目前少了 N 件」（`:202`），沒說是哪幾件，消費者得自己往下找。
- 缺貨 chip 只有視覺沒有語意——刪除線加透明度，色弱與讀屏使用者收不到訊息。

## 目標

1. bundle 卡片的圖跟著規格切換。
2. `imageMatches` / `repImageFor` 收成一份。
3. 缺貨從「看得出來」變成「說得出來」。

## 非目標

- **不處理庫存新鮮度**（賣完了但快取頁還顯示有貨）。那是 S4，這份只管「已知的缺貨要講清楚」。
- 不改 `tag_filter` 的資料格式，不動後台的圖片綁定 UI。
- 不改套裝價的計算（`evaluateSelection`）。

---

## 設計

### 一、抽出共用純函式

新增 `shop/src/lib/variantImages.js`：

```js
/** 這張圖在目前選到的規格下該不該顯示。tag_filter 為 null＝共用圖。 */
export function imageMatches(img, selectedOptions)

/** 某規格值的代表圖：images 需已依 sort_order 排序，取第一張綁到該值的圖。 */
export function repImageFor(images, typeId, valueId)

/**
 * 目前該顯示哪幾張圖。過濾後為空就退回全部 —— 該規格沒有專屬圖也沒有共用圖時
 * 不能開天窗（這是 ProductDetail.jsx:44 既有的行為，抽出來時要保留）。
 */
export function visibleImages(sortedImages, selectedOptions)
```

實作直接搬 `ProductDetail.jsx:315-331`，行為不變。
`ProductStateProvider.jsx` 與 `ProductDetail.jsx` 改成 import 這支，刪掉本地副本。
`ProductStateProvider` 原本 export 這兩支，檢查有沒有別的檔案在 import 它們，一併改掉。

> `shop/` 目前沒有測試 runner（`shop/package.json` 只有 next/react），這次**不引入**。
> 這三支的正確性靠下方驗收清單在瀏覽器逐項確認。

### 二、bundle 卡片的圖跟著規格切換

`BundleDetail.jsx` 的 `resolveItem`（`:420-466`）：

```js
const images = [...(p.product_images || [])].sort((a, b) => a.sort_order - b.sort_order)
const shown = visibleImages(images, options)
…
image: shown[0]?.url || null,
```

`resolveItem` 已經收到 `options` 參數，不必改簽名。

切換時加淡入：圖片元素以 `key={image}` 重新掛載，配一段 120ms 的 opacity transition。
**不要**做交叉淡出或滑動——這頁一次顯示好幾張卡，動得太多會搶掉「選規格」這個主要動作的注意力。

### 三、規格 chip 顯示代表圖

商品詳情頁的 chip 已經有 `.spec-chip-img` 樣式（`globals.css:382`）。
bundle 的 chip 沿用同一套：`repImageFor` 拿得到代表圖就在 chip 左側放一顆 30px 圓形縮圖。
拿不到就只有文字（現況）。

### 四、缺貨說得出來

**(a) chip 加語意**。`BundleDetail.jsx:298-304` 的缺貨 chip 加：

```jsx
aria-label={`${val.value}（已售完）`}
title={zh ? '已售完' : 'Sold out'}
```

**(b) 頁面層點名**。商品清單標題下方（`:227-231` 那段 `.bundle-items-sub` 之後）加一條摘要，
**只在有缺貨品項時出現**：

> 這一套有 2 件目前缺貨：**日本限定護唇膏**、**櫻花洗面乳**。缺貨的不列入結帳，其餘仍可原價購買。

品名做成可點，點了捲到那張卡（`scrollIntoView({ behavior: 'smooth', block: 'center' })`）
並讓卡片閃一下外框。捲動位置要避開黏底購買列。

**(c) 不適用套裝價的原因寫清楚**。`:199-203` 的「目前少了 N 件」改成點名少了哪幾件
（下架的走既有的 `missingProductIds` 文案，缺貨的用品名）。

英文文案同步（這頁全部走 `zh ? … : …`）。

---

## 資料流

```
消費者點某件的「M 號」
  → pickOption(productId, typeId, valueId)
  → picks state 更新
  → rows 重算 → resolveItem(item, optTypes, options, lang)
       ├── visibleImages(images, options) → 卡片主圖換掉
       ├── isValueSoldOut(…)              → 其他維度的 chip 重新判斷可選性
       └── variantLabel / price           → 卡片底列與總價更新
  → 缺貨摘要跟著重算（rows.filter(r => r.unavailable)）
```

## 錯誤處理

| 情況 | 行為 |
|---|---|
| 商品沒有任何圖 | 卡片維持現有的無圖樣式，不放佔位灰塊 |
| 選到的規格沒有專屬圖也沒有共用圖 | `visibleImages` 退回全部（既有行為） |
| `tag_filter` 是壞資料（非物件、值不是陣列） | `imageMatches` 視為不設限，回 `true`。**不可丟例外**——這是店主手動綁的欄位 |
| 整件售完 | 維持現況：標「已售完」、勾選鈕消失、不列入結帳 |

---

## 驗收清單

**規格連動照片**：

1. 後台把某商品的圖綁到「藍色」，另一張綁到「紅色」，一張不綁（共用）
2. 商品詳情頁切換顏色 → 圖庫跟著換（**這是既有行為，抽出共用函式後不可壞掉**）
3. 用編排過版面的商品再測一次（走 `ProductPageView` / `ProductStateProvider` 那條路）
4. 把該商品放進一個組合 → bundle 頁切換顏色 → 卡片主圖跟著換
5. 綁了圖的規格值 → chip 左側出現圓形縮圖
6. 沒綁任何圖的商品 → bundle 卡片顯示第一張圖，切規格不動（不報錯）

**缺貨呈現**：

7. 把某規格的庫存改成 0 → bundle 頁該 chip 刪除線且不可點，滑上去有「已售完」tooltip
8. 讀屏（VoiceOver）唸到該 chip 時說得出「已售完」
9. 把某件商品的所有規格庫存清成 0 → 清單上方出現缺貨摘要並點名該商品
10. 點摘要裡的品名 → 捲到那張卡且卡片閃一下，沒有被黏底購買列擋住
11. 兩件都缺貨 → 摘要列出兩個品名
12. 全部有貨 → 摘要**不出現**（不要留一條空的提示）
13. 英文介面下 7-12 的文案都正確

**本機環境**：後台改庫存後要等商城 ISR 快取失效，或在後台存檔觸發 revalidate。
（庫存變動不會自動 revalidate——那正是 S4 要解的問題，這份先用後台存檔手動清。）

---

## 涉及檔案

- 新增 `shop/src/lib/variantImages.js`
- 改 `shop/src/app/products/[id]/ProductDetail.jsx`（刪副本、改 import）
- 改 `shop/src/app/products/[id]/ProductStateProvider.jsx`（刪副本、改 import）
- 改 `shop/src/app/bundles/[id]/BundleDetail.jsx`（連動圖、chip 縮圖、缺貨文案）
- 改 `shop/src/app/globals.css`（缺貨摘要樣式、卡片閃爍）

## 風險

- 抽出 `imageMatches` 時若不小心改了「過濾後為空退回全部」這個 fallback，
  某些商品的圖庫會整個消失。驗收第 2、3 項就是在守這件事。
- 商城 dev server 在跑時**不要**跑 `npm run build`（會弄壞 `.next`）。

## 完成後

跑完驗收 → commit → merge 回 `main` → 通知 S4 可以開工（S4 會改到同樣這幾支檔案）。
