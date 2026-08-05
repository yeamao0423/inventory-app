# S4 — 賣完的不能再被選：庫存新鮮度

**日期**：2026-08-05
**分支**：`feat/stock-freshness`
**Track**：B（第 2 支，**必須等 S3 合併進 main 之後才開工**——兩者都改 `BundleDetail.jsx` 與 `ProductDetail.jsx`）
**規模**：中

---

## 背景

### 不會超賣，但會白填一次表

`place_order` 有庫存檢查，而且是 `SELECT … FOR UPDATE` 鎖住再比對，不足就 `RAISE EXCEPTION`
（`supabase/migrations/20250071_place_order_bundle_discount.sql:75-124`）。
**所以資料是安全的，不會超賣。**

問題在前面：商品頁與組合頁都是 ISR 靜態頁——
`revalidate = 3600` 加上 `unstable_cache` 的 TTL（`shop/src/app/products/[id]/[[...slug]]/page.jsx`、
`bundles/[id]/[[...slug]]/page.jsx:9`、`shop/src/lib/data.js`）。
而 `/api/revalidate` 的呼叫端**全部是後台存檔的頁面**（`src/lib/revalidateShop.js` 的使用處），
**下單扣庫存不會觸發任何快取失效**。

結果：某個規格剛被買走，商品頁與 bundle 頁最長一小時內仍然顯示它有貨、可以選。
消費者選了、加入購物車、填完收件資料、選好物流，按下送出才被 `place_order` 擋下——
`checkout/page.jsx:300-301` 直接 `alert()` 一句「庫存不足：「XXX」(M)，剩餘 0 件」。

### 還有一個小落差

`ProductStateProvider` 的初始規格選擇是「每個維度的第一個值」（`:39-47`），不看庫存；
`BundleDetail.initialOptions`（`:409-418`）則是「第一個還有貨的值」。
同一件商品在兩條路徑上會有不同的預設選擇，且前者可能一進頁面就停在缺貨的規格。

## 目標

1. **前端就顯示哪些沒貨、不能選**——頁面上的可選性反映的是當下庫存，不是一小時前的快照。
2. **結帳時再檢查一遍**——送出前就攔下來並講清楚哪一件不行，而不是填完才被 alert 打回票。

## 非目標

- 不改 `place_order`。它已經是正確的最後防線，這份不碰交易邏輯。
- **不做**「下單成功後回打 `/api/revalidate`」。目標 1 已經讓顯示是新鮮的，
  再拉一條從結帳回到 Next.js 的線只是多一個會壞的東西。
- 不做即時庫存推播（Realtime 訂閱庫存變動）。輪詢一次就夠，這不是拍賣網站。
- 不新增測試 runner —— 也不需要：根目錄的 vitest 已經涵蓋 `shop/src/lib/*.test.js`，
  `mergeStock` / `mergeQuantity` / `isValueSoldOut` / `initialOptions` 都要寫測試。
- 不改 SSR/ISR 的快取策略。SEO 需要 server 端就吐出完整內容，這點不動。

---

## 設計

原則：**SSR 照舊給完整內容（SEO 不受影響），client 掛載後補正庫存。**

### 一、庫存查詢 API

新增 `shop/src/app/api/stock/route.js`，與 `/api/revalidate`、`/api/send-order-email` 同一層
（消費者端不直連資料庫，ADR-0002）。**用 anon key 走 RLS**，與商城既有的 server 資料層一致
（`shop/src/lib/data.js:2-3`）——migration 39 對 anon 封鎖了 `variant_cost`，走 anon 等於白拿一層成本保護。

```
POST /api/stock
body: { productIds: number[] }        // 上限 50，超過回 400
→ 200 {
    products: { [productId]: number },        // products.quantity
    variants:  { [variantId]:  number },      // product_variants.stock
    at: ISO 時間字串
  }
```

- 明列欄位查詢：`product_variants` 只取 `id, product_id, stock`。
  **不可用 `select('*')`**——那張表有 `variant_cost`，成本不能出現在消費者拿得到的回應裡。
  走 anon key 時 `select('*')` 會直接整句失效（`shop/src/lib/data.js:292` 已有同樣的註記），
  但不要靠那個報錯當防線，明列欄位才是。
- 回應加 `Cache-Control: no-store`。這支的意義就是不被快取。
- 只回庫存數字。庫存本來就顯示在頁面上，不是新的洩漏面；但也因此**不要**順手多回別的欄位。
- 不需要 Turnstile 或限流：它比 SSR 頁面本身便宜，而且沒有寫入與外部 API 成本。
  若日後被濫用再加，不要現在先做。

### 二、補正 hook

新增 `shop/src/lib/useFreshStock.js`：

```js
/**
 * 頁面掛載後打一次 /api/stock，回傳覆蓋用的庫存表。
 * @returns {{ products, variants, status: 'loading'|'ready'|'error', at }}
 * 失敗就維持 status='error'，呼叫端沿用 SSR 快照（寧可顯示舊資料，也不要整頁不能買）。
 */
export function useFreshStock(productIds)
```

- 掛載時打一次。
- 分頁從背景切回前景時（`visibilitychange`）再打一次——消費者開著分頁去忙別的事回來，
  看到的不該是十分鐘前的庫存。
- **不做**定時輪詢。

### 三、三個顯示點套用

一支小工具（放在 `useFreshStock.js` 或旁邊）把 SSR 的 variants 陣列與新鮮值合併：

```js
export function mergeStock(variants, fresh) // 回新陣列，fresh 沒有的項目維持原值
```

套用處：

| 檔案 | 改法 |
|---|---|
| `shop/src/app/products/[id]/ProductStateProvider.jsx` | `variants` 進來後先 merge，再算 `currentVariant` / `stock` / `stockSoldOut` |
| `shop/src/app/products/[id]/ProductDetail.jsx` | 同上（沒編排版面的店走這條） |
| `shop/src/app/bundles/[id]/BundleDetail.jsx` | `rows` 計算前先 merge 各 item 的 `variants` |

merge 之後 `isValueSoldOut` 自然就是用新鮮值判斷，缺貨的 chip 自動變成不可選——
**不需要**另外寫「把某個 chip 標成缺貨」的邏輯。

**順手修掉初始選擇的落差**：`ProductStateProvider` 的初始選擇改成與
`BundleDetail.initialOptions` 同一套（每個維度挑第一個還有貨的值，全缺貨才退回第一個）。
新鮮庫存回來後若當前選擇已缺貨，把選擇移到同維度第一個還有貨的值，並顯示一句
「你剛才選的 M 號已售完，已幫你改成 L」。**不要**默默改掉——那比不改更糟。

`skip_stock_check` 或 `collection_end`（可預訂／收單中）的商品**不受影響**，
既有的 `skipStock` 判斷優先於庫存數字。

### 四、加入購物車前驗證

`ProductStateProvider.addToCart` 與 `BundleDetail.handleAdd`：送出前打一次 `/api/stock`，
不足就不加入，就地把該規格標成售完並提示「這件剛剛被買走了」。

API 失敗（網路斷）**不阻擋**加入購物車——`place_order` 仍會擋下，
把消費者卡在「連不到伺服器所以不能買」是更糟的結果。

### 五、結帳前再檢查一遍

`shop/src/app/checkout/page.jsx`：在呼叫 `place_order`（`:278`）之前，
以購物車內容打一次 `/api/stock`：

- 全部足夠 → 照常下單。
- 有不足 → **不送出**，在購物車摘要區塊就地標出哪幾件、剩幾件，給兩個動作：
  「移除這幾件」與「改成剩餘數量」。消費者處理完才能再按送出。
- `isCollection`（預購／收單）品項跳過檢查，與 `place_order:78-80` 的規則一致。

`place_order` 仍可能失敗（檢查與下單之間又被買走）。那時的 `alert()`（`:300-301`）
改成與上面同一套的就地呈現，不要再用 `alert`。

---

## 資料流

```
SSR/ISR：商品頁 → 快照庫存（最舊可能一小時前）→ 完整 HTML（SEO 拿得到）
  ↓ 掛載
useFreshStock([productIds]) → POST /api/stock → server 用 anon key 走 RLS 查即時庫存
  ↓
mergeStock(SSR variants, fresh) → isValueSoldOut 用新鮮值 → 缺貨 chip 不可選
  ↓ 加入購物車
再打一次 /api/stock → 不足就擋在這裡
  ↓ 結帳送出
再打一次 /api/stock → 不足就就地標示，不送出
  ↓
place_order（FOR UPDATE，最後防線，不動）
```

## 錯誤處理

| 情況 | 行為 |
|---|---|
| `/api/stock` 失敗（網路、5xx） | 沿用 SSR 快照，頁面照常可買。**不可**把頁面鎖成不能購買 |
| `productIds` 超過 50 | 400。bundle 最多也就十幾件，超過代表呼叫端有問題 |
| 加入購物車時 API 失敗 | 放行，交給 `place_order` 擋 |
| 結帳前檢查 API 失敗 | 放行送出，交給 `place_order` 擋（既有錯誤呈現要改好） |
| 當前選擇的規格在補正後變成缺貨 | 自動移到同維度第一個有貨的值，**並明白告訴消費者** |
| 全部規格都缺貨 | 走既有的「已售完」路徑（`unavailable`） |

---

## 驗收清單

**準備**：本機開兩個瀏覽器視窗（A 買家、B 後台）。

1. B 把某規格庫存改成 1 → A 開商品頁 → 顯示可買
2. B 把庫存改成 0（**不做任何會觸發 revalidate 的存檔**）→ A **重新整理**商品頁
   → 該規格 chip 立刻是缺貨、不可選（SSR 給的還是舊值，補正後變正確）
3. A 停在商品頁不動 → B 把庫存改成 0 → A 切到別的分頁再切回來 → chip 變缺貨
4. A 目前選著 M 號 → B 把 M 號庫存改成 0 → A 切回分頁 → 自動改選 L 並出現說明文字
5. 對編排過版面的商品重做 2-4（走 `ProductPageView` 那條路）
6. 對 bundle 頁重做 2-4
7. 預購商品（`skip_stock_check` 或有 `collection_end`）庫存 0 → **仍可選、仍可買**
8. A 加入購物車前一刻 B 把庫存清成 0 → A 按加入購物車 → 被擋下並提示，購物車沒有變化
9. A 已在購物車有該商品 → B 清庫存 → A 進結帳按送出 → **不送出**，就地標示哪件不足，
   提供「移除」與「改數量」
10. 處理完再送出 → 下單成功
11. 把 `/api/stock` 手動改成回 500 → 頁面照常可買、可加入購物車、可送出
    （最後由 `place_order` 擋，錯誤訊息就地呈現不是 alert）
12. 檢查 `/api/stock` 的回應內容 → **沒有** `variant_cost` 或任何成本欄位

---

## 涉及檔案

- 新增 `shop/src/app/api/stock/route.js`
- 新增 `shop/src/lib/useFreshStock.js`（含 `mergeStock`）
- 改 `shop/src/app/products/[id]/ProductStateProvider.jsx`
- 改 `shop/src/app/products/[id]/ProductDetail.jsx`
- 改 `shop/src/app/bundles/[id]/BundleDetail.jsx`
- 改 `shop/src/app/checkout/page.jsx`
- 可能改 `shop/src/app/cart/page.jsx`（購物車頁若也要標缺貨）

## 風險

- **`select('*')` 會把成本洩漏給消費者。** 驗收第 12 項專門守這件事。
- 補正邏輯若寫錯，可能讓有貨的商品顯示成缺貨——那是直接的營收損失。
  驗收第 1、7、11 項守「不該擋的不要擋」。
- 商城 dev server 在跑時不要跑 `npm run build`。

## 完成後

跑完驗收 → commit → merge 回 `main`。Track B 結束。
