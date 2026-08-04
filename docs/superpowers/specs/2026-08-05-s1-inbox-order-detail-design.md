# S1 — 客服收件匣：訂單詳情 popup

**日期**：2026-08-05
**分支**：`feat/inbox-order-detail`
**Track**：A（第 1 支，完成合併後才輪到 S2）
**規模**：小

---

## 背景

客服在收件匣右欄看得到會員的近期訂單（`src/pages/InboxPage.jsx:401-422`），但那是唯讀摘要：
訂單編號、金額、兩個狀態徽章、時間。客服想確認「他買了什麼」「付了多少」「寄到哪」時，
必須離開收件匣、切到訂單頁、再把單號找出來——對話期間做這件事等於中斷服務。

後台已經有一份完整的訂單詳情實作：`ConsumerOrderDetailSheet`（`src/pages/OrdersPage.jsx:890`），
內含付款明細、折讓、優惠券退還、品項取消、運費與物流單號、狀態變更信。
它是自足的——只吃 `useAuth` 與 `supabase`，沒有依賴 `OrdersPage` 的任何 state。
搭配的 `Sheet` 外框在同一個檔案的 `:2706`。

## 目標

收件匣點訂單卡 → 彈出與訂單頁**完全相同**的訂單詳情。

## 非目標

- 不改 `ConsumerOrderDetailSheet` 的任何行為。這支管著金流與寄信，抽出時一個字都不准順手改。
- 不處理內部訂單（`OrderDetailSheet`，`:2109`）。收件匣的對話對應的是消費者，
  近期訂單撈的是 `consumer_orders`，內部訂單不會出現在這裡。
- 不做訂單搜尋或跳轉到訂單頁。

---

## 設計

### 一、抽出共用元件

新增兩個檔案，內容從 `OrdersPage.jsx` **原封移動**：

| 新檔 | 來源 |
|---|---|
| `src/components/Sheet.jsx` | `OrdersPage.jsx:2706-2719` |
| `src/components/ConsumerOrderDetailSheet.jsx` | `OrdersPage.jsx:890-1838`（到 `AddOrderSheet` 之前） |

`ConsumerOrderDetailSheet.jsx` 需要 `import Sheet from './Sheet'`，以及原本在 `OrdersPage.jsx`
頂端、它實際用到的那些 import（`useAuth`、`supabase`、`useState/useEffect/useCallback` 等）。
抽完後 `OrdersPage.jsx` 改成 import 這兩支，並刪掉原本的函式定義。

`AddOrderSheet`、`OrderDetailSheet`、`ExportShippingSheet`、`ExportRevenueSheet` 也用 `Sheet`，
它們留在 `OrdersPage.jsx`，改成 import 即可。

**這一步是純搬家。** 驗收方式：抽完後訂單頁的行為與抽之前一模一樣（見下方驗收清單）。

### 二、收件匣接上

`src/pages/InboxPage.jsx`：

1. 訂單卡（`:406-418` 的 `.inbox-order`）從 `<div>` 改成 `<button>`，加 `cursor: pointer` 與 hover 樣式。
2. 點擊時以 id 撈完整那一列——收件匣的 `fetchCustomer` 只 select 了七個欄位（`:116`），
   `ConsumerOrderDetailSheet` 需要 `items_json`、`shipping_fee`、`discount_amount`、`coupon_id`、
   `tracking_number`、`fulfillment_type` 等等，所以另外打一次 `select('*')`：

   ```js
   const { data, error } = await supabase
     .from('consumer_orders').select('*').eq('id', orderId).eq('store_id', storeId).maybeSingle()
   ```

   `.eq('store_id', storeId)` 不是為了安全（RLS 已經擋住跨店），是為了讓「拿到別店的 id」這種
   程式錯誤直接查不到，而不是靜靜地開一個空 sheet。

3. 撈到就開 sheet，撈不到（訂單已被刪）顯示提示，**不開空 sheet**。
4. `canEdit` 用 `useAuth` 的 `can('pay')`（`src/hooks/useAuth.jsx:83-91`），與訂單頁的傳法一致：
   viewer 拿到唯讀，editor 以上可編輯。
5. `onSaved` 傳一支重撈近期訂單的函式（現有的 `fetchCustomer(active)`），
   讓客服在 sheet 裡改完狀態後，右欄的摘要跟著更新。

### 三、Sheet 疊在收件匣上的層級

收件匣是三欄滿版佈局（`.inbox-split` 撐滿 `100dvh - 210px`）。`Sheet` 用的是全站既有的
`.sheet-overlay` / `.sheet` 樣式，z-index 已經在全域 CSS 裡定義過，沿用即可，
**不要**在 `InboxPage` 裡另外調整層級。若實測發現被蓋住，改全域樣式並在 spec 回報，不要就地加 `!important`。

---

## 資料流

```
客服點訂單卡
  → InboxPage.openOrder(id)
  → supabase.from('consumer_orders').select('*') ── 走 RLS，該店成員才讀得到
  → setOrderSheet(row)
  → <ConsumerOrderDetailSheet order={row} canEdit={can('pay')} onSaved={fetchCustomer} onClose=… />
       └── 內部自己撈 order_payments、coupons，與訂單頁走同一條路
```

## 錯誤處理

| 情況 | 行為 |
|---|---|
| 訂單已被刪除 / 查不到 | 顯示「這筆訂單已不存在」，不開 sheet |
| 查詢出錯（網路、RLS） | 顯示錯誤訊息，不開 sheet |
| viewer 點擊 | 正常開啟，內部所有編輯動作停用（`canEdit=false`） |
| 撈取中 | 卡片顯示載入狀態，避免連點兩次開兩個 sheet |

---

## 驗收清單

**抽出後訂單頁必須零變化**（逐項在瀏覽器確認）：

1. 訂單頁 → 點一筆消費者訂單 → sheet 正常開啟，欄位與抽出前一致
2. 登記收款、登記退款 → 金額與付款狀態正確更新
3. 折讓金額輸入後失焦 → 寫回 DB，總額重算
4. 取消單一品項 → 總額重算、狀態信可寄出
5. 有優惠券的訂單 → 折讓欄位鎖住、退還優惠券可用
6. 關閉 sheet → 列表刷新

**收件匣新功能**：

7. 開一條已識別會員的對話 → 右欄近期訂單可點
8. 點下去 → 開出與第 1 項同一個 sheet，內容正確
9. 在 sheet 裡改狀態並存檔 → 關閉後右欄摘要的狀態徽章跟著變
10. 以 viewer 帳號登入 → 訂單卡仍可點開，但所有編輯控制項停用
11. 訪客對話（未識別身分）→ 右欄仍顯示「訪客登入或下單後才看得到」，沒有可點的訂單卡

**本機帳號**：`owner@daigogo.dev` / `localdev123`（super_admin）。
測 viewer 需另外建一個角色為 viewer 的帳號，或直接改 `user_store_roles` 的 role 欄位測完再改回來。

---

## 涉及檔案

- 新增 `src/components/Sheet.jsx`
- 新增 `src/components/ConsumerOrderDetailSheet.jsx`
- 改 `src/pages/OrdersPage.jsx`（刪掉搬走的兩個函式、改 import）
- 改 `src/pages/InboxPage.jsx`（訂單卡可點、開 sheet、樣式）

## 風險

- **`ConsumerOrderDetailSheet` 有 900 行、牽涉金流與寄信。** 搬家時漏掉一個 import 或改到一個
  變數名，壞掉的是真實訂單的付款狀態。逐項跑完上面 1-6 項才算完成。
- 這支同時被兩頁使用之後，未來改它會影響兩個地方——這是刻意的（本來就該只有一份），
  但改動時要記得兩邊都驗。

## 完成後

跑完驗收清單 → commit → merge 回 `main` → 通知 S2 可以開工（S2 會改到同一支 `InboxPage.jsx`）。
