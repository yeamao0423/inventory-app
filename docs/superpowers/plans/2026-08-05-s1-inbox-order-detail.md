# S1 客服收件匣訂單詳情 popup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 客服在收件匣點右欄的訂單卡，就地彈出與訂單頁完全相同的訂單詳情。

**Architecture:** 把 `OrdersPage.jsx` 裡自足的 `Sheet` 與 `ConsumerOrderDetailSheet` 原封抽成獨立元件，兩頁共用。收件匣點擊時以訂單 id 撈完整那一列（現有查詢只有七個欄位），再開同一個 sheet。

**Tech Stack:** React 18 + Vite、react-router-dom v6、Supabase JS v2（走 RLS）

**Spec:** `docs/superpowers/specs/2026-08-05-s1-inbox-order-detail-design.md`

## Global Constraints

- 分支 `feat/inbox-order-detail`，在自己的 git worktree 執行。
- **`ConsumerOrderDetailSheet` 的行為一個字都不准改。** 這支管著收付款、折讓、優惠券退還、品項取消與狀態信。抽出是搬家，不是重構。
- 後台不新增 runtime 依賴（CLAUDE.md 的最小依賴原則）。
- 本專案的 `src/lib` 有 vitest（`npm run test`），但這份計畫動到的都是 React 元件，沒有純函式可測 —— 驗收一律走瀏覽器，每個 Task 都有明確步驟。
- 後台本機帳號：`owner@daigogo.dev` / `localdev123`。後台跑在 :5173（`npm run dev`）。
- 商城 dev server 在跑時**不要**跑 `npm run build`（會弄壞 `.next`）。這份計畫不需要動商城。
- commit message 用繁體中文、簡潔，**不要**加 Co-Authored-By。

---

## File Structure

| 檔案 | 責任 |
|---|---|
| `src/components/Sheet.jsx`（新） | 底部彈出面板的外框：遮罩、標題列、關閉鈕。無業務邏輯 |
| `src/components/ConsumerOrderDetailSheet.jsx`（新） | 消費者訂單的完整詳情與編輯：付款、折讓、品項、物流、狀態信 |
| `src/pages/OrdersPage.jsx`（改） | 刪掉搬走的兩個函式，改成 import |
| `src/pages/InboxPage.jsx`（改） | 訂單卡可點、撈完整訂單、開 sheet |

---

### Task 1: 抽出 `Sheet` 外框

**Files:**
- Create: `src/components/Sheet.jsx`
- Modify: `src/pages/OrdersPage.jsx`（刪除 `:2706-2719` 的 `Sheet` 定義、頂端加 import）

**Interfaces:**
- Produces: `default export function Sheet({ title, onClose, children })` — 其餘四個 sheet 元件都靠它。

- [ ] **Step 1: 建立 `src/components/Sheet.jsx`**

內容從 `OrdersPage.jsx:2706-2719` 原封搬過來，加一段說明檔頭：

```jsx
// 底部彈出面板的外框。訂單頁與客服收件匣共用。
//
// 樣式（.sheet-overlay / .sheet / .sheet-handle）在全站 CSS 裡，這裡不重新定義 ——
// 兩份樣式遲早漂移，而這個外框全站到處都在用。
export default function Sheet({ title, onClose, children }) {
  return (
    <div className="sheet-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <div className="sheet-handle" />
        <div className="row-sb" style={{marginBottom:20}}>
          <div className="sheet-title" style={{margin:0}}>{title}</div>
          <button onClick={onClose} style={{background:'none',border:'none',fontSize:22,cursor:'pointer',color:'var(--text-3)'}}>×</button>
        </div>
        {children}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 在 `OrdersPage.jsx` 改用它**

刪掉 `OrdersPage.jsx` 檔尾的 `function Sheet(...)` 定義，在檔案頂端的 import 區加：

```js
import Sheet from '../components/Sheet'
```

- [ ] **Step 3: 瀏覽器驗證**

```
npm run dev            # :5173
```

以 `owner@daigogo.dev` / `localdev123` 登入 → 訂單頁：
1. 點一筆消費者訂單 → sheet 正常開啟，標題與內容位置與改動前相同
2. 點遮罩空白處 → 關閉
3. 點右上角 × → 關閉
4. 點「新增訂單」→ `AddOrderSheet` 正常開啟（它也用 `Sheet`）
5. 點「匯出出貨單」→ `ExportShippingSheet` 正常開啟

Expected: 五項全部與改動前一致，Console 沒有新的錯誤。

- [ ] **Step 4: Commit**

```bash
git add src/components/Sheet.jsx src/pages/OrdersPage.jsx
git commit -m "refactor: Sheet 外框抽成共用元件"
```

---

### Task 2: 抽出 `ConsumerOrderDetailSheet`

**Files:**
- Create: `src/components/ConsumerOrderDetailSheet.jsx`
- Modify: `src/pages/OrdersPage.jsx`（刪除 `:890` 起到 `AddOrderSheet`（`:1840`）之前的整段、加 import）

**Interfaces:**
- Consumes: `Sheet`（Task 1）
- Produces: `default export function ConsumerOrderDetailSheet({ order, onClose, onSaved, canEdit })`
  - `order` — `consumer_orders` 的完整一列（需要 `items_json`、`shipping_fee`、`discount_amount`、`coupon_id`、`tracking_number`、`fulfillment_type` 等）
  - `onSaved` — 存檔成功後呼叫，呼叫端據此重新整理列表
  - `canEdit` — false 時所有編輯控制項停用

- [ ] **Step 1: 建立 `src/components/ConsumerOrderDetailSheet.jsx`**

把 `OrdersPage.jsx` 第 890 行的 `function ConsumerOrderDetailSheet({ order: o, onClose, onSaved, canEdit }) {` 一路到 `function AddOrderSheet`（`:1840`）**之前**那一整段，原封貼進新檔，函式宣告前加 `export default`。

檔頭加：

```jsx
// 消費者訂單的完整詳情與編輯：收付款、折讓、品項取消、運費與物流單號、狀態變更信。
//
// 訂單頁與客服收件匣共用。這支碰的是金流與寄信，改動前先想清楚兩邊都會受影響。
```

補齊它實際用到的 import。逐一確認（不要用猜的，在原檔搜尋每個識別字）：

```js
import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import Sheet from './Sheet'
```

若這一段還用到 `OrdersPage.jsx` 裡的其他輔助函式（例如 `consumerStatusBadge`、`paymentBadge`、`statusBadge`），有兩種處理：
- 只被這一段使用 → 一起搬過來
- 訂單頁其他地方也在用 → 留在 `OrdersPage.jsx`，把它也搬到新檔並從 `OrdersPage` import，或複製一份（**優先選搬移＋import，不要複製**）

搬完後在新檔跑一次搜尋，確認沒有任何未定義的識別字。

- [ ] **Step 2: 在 `OrdersPage.jsx` 改用它**

刪掉搬走的整段，頂端加：

```js
import ConsumerOrderDetailSheet from '../components/ConsumerOrderDetailSheet'
```

`:736` 的用法不變：

```jsx
<ConsumerOrderDetailSheet order={sheet} onClose={() => setSheet(null)} onSaved={fetchAll} canEdit={can('pay')} />
```

- [ ] **Step 3: 啟動並確認沒有編譯錯誤**

Run: `npm run dev`
Expected: Vite 沒有 "is not defined" 或 "failed to resolve import"；瀏覽器 Console 乾淨。

- [ ] **Step 4: 逐項回歸驗證（這一步不可跳過）**

訂單頁 → 找一筆消費者訂單（沒有就先從商城下一筆）：

1. 點開 → 欄位、金額、狀態、品項清單與改動前一致
2. 「登記收款」輸入金額 → 送出 → 已收金額與付款狀態徽章正確更新
3. 「登記退款」→ 同上，金額往回扣
4. 折讓金額欄輸入數字 → 點別處失焦 → 總額重算，重新整理頁面後數字還在（有寫回 DB）
5. 勾選取消某個品項 → 存檔 → 總額重算
6. 找一筆有優惠券的訂單 → 折讓欄位是鎖住的、「退還優惠券」可按
7. 改狀態 → 存檔 → 關閉後列表那一列的狀態跟著變

Expected: 七項全部與改動前一致。任何一項不同就是搬家搬壞了，回頭比對原始程式碼。

- [ ] **Step 5: Commit**

```bash
git add src/components/ConsumerOrderDetailSheet.jsx src/pages/OrdersPage.jsx
git commit -m "refactor: 消費者訂單詳情抽成共用元件"
```

---

### Task 3: 收件匣接上訂單詳情

**Files:**
- Modify: `src/pages/InboxPage.jsx`（訂單卡 `:406-418`、頂端 import、新增 state 與開啟函式、頁尾 `<style>` 區塊）

**Interfaces:**
- Consumes: `ConsumerOrderDetailSheet`（Task 2）、`useAuth().can`（`src/hooks/useAuth.jsx:83`）

- [ ] **Step 1: 加 import 與 state**

`InboxPage.jsx` 頂端加：

```js
import ConsumerOrderDetailSheet from '../components/ConsumerOrderDetailSheet'
```

`useAuth()` 解構多拿一個 `can`（`:36`）：

```js
const { profile, storeId, user, store, can } = useAuth()
```

在其他 state 旁邊加兩個：

```js
const [orderSheet, setOrderSheet] = useState(null)   // 開著的訂單完整資料
const [orderLoading, setOrderLoading] = useState(null) // 正在撈的訂單 id，避免連點開兩個
```

- [ ] **Step 2: 加開啟函式**

放在 `fetchCustomer` 下面：

```js
// 右欄的近期訂單只 select 了七個欄位（fetchCustomer），
// ConsumerOrderDetailSheet 要的是完整一列，所以點下去才另外撈。
async function openOrder(orderId) {
  if (orderLoading) return
  setOrderLoading(orderId)
  const { data, error } = await supabase
    .from('consumer_orders')
    .select('*')
    // RLS 已經擋住跨店；這個條件是為了讓「拿到別店的 id」這種程式錯誤直接查不到，
    // 而不是靜靜開一個空 sheet
    .eq('store_id', storeId)
    .eq('id', orderId)
    .maybeSingle()
  setOrderLoading(null)
  if (error) { alert('讀取訂單失敗：' + error.message); return }
  if (!data) { alert('這筆訂單已不存在'); return }
  setOrderSheet(data)
}
```

- [ ] **Step 3: 訂單卡改成可點**

把 `:406-418` 的 `<div key={o.id} className="inbox-order">` 改成 `<button>`：

```jsx
{customer?.orders?.length
  ? customer.orders.map(o => (
    <button
      key={o.id}
      type="button"
      className="inbox-order"
      onClick={() => openOrder(o.id)}
      disabled={orderLoading === o.id}
      aria-label={`查看訂單 #${o.store_order_no ?? o.id} 的詳細資料`}
    >
      <div className="inbox-order-top">
        <span className="inbox-order-no">#{o.store_order_no ?? o.id}</span>
        <span className="inbox-order-amt">NT${Number(o.total_amount || 0).toLocaleString()}</span>
      </div>
      <div className="inbox-order-meta">
        <span className="badge">{o.status}</span>
        <span className="badge badge-ok">{o.payment_status}</span>
        <span>{orderLoading === o.id ? '讀取中…' : shortTime(o.created_at)}</span>
      </div>
    </button>
  ))
  : <div className="inbox-side-none">…（不變）…</div>}
```

- [ ] **Step 4: 掛上 sheet**

在 `</aside>` 之後、`<style>` 之前加：

```jsx
{orderSheet && (
  <ConsumerOrderDetailSheet
    order={orderSheet}
    canEdit={can('pay')}
    onClose={() => setOrderSheet(null)}
    onSaved={() => { fetchCustomer(active); setOrderSheet(null) }}
  />
)}
```

- [ ] **Step 5: 補樣式**

`<style>` 區塊裡的 `.inbox-order` 規則（`:503`）改成按鈕該有的樣子：

```css
.inbox-order {
  display: block; width: 100%; text-align: left;
  border: 0.5px solid var(--border); border-radius: 10px; padding: 9px 10px;
  margin-bottom: 8px; background: none; cursor: pointer;
  transition: border-color .15s;
}
.inbox-order:hover:not(:disabled) { border-color: var(--text-3); }
.inbox-order:disabled { opacity: .6; cursor: wait; }
```

`.inbox-order:last-child { margin-bottom: 0; }` 保留不動。

- [ ] **Step 6: 瀏覽器驗證**

前置：本機要有一位「有訂單」且「有客服對話」的消費者。同步腳本不含會員相關表，
需要自己 seed：在商城以會員身分下一筆單，再用同一個帳號開聊天視窗發一則訊息。

1. 後台收件匣 → 開那條已識別會員的對話 → 右欄訂單卡有 hover 效果
2. 點下去 → 開出與訂單頁完全相同的 sheet
3. 在 sheet 裡改狀態 → 存檔 → sheet 關閉、右欄那張卡的狀態徽章跟著變
4. 開一條**訪客**對話 → 右欄顯示「訪客登入或下單後才看得到」，沒有可點的卡
5. 連點同一張卡兩下 → 只開一個 sheet
6. 手動把該訂單從資料庫刪掉再點 → 出現「這筆訂單已不存在」，不開空 sheet

- [ ] **Step 7: 權限驗證**

把自己的 `user_store_roles.role` 暫時改成 `viewer`：

```sql
-- psql "postgresql://postgres:postgres@127.0.0.1:54332/postgres"
update user_store_roles set role = 'viewer' where user_id = '<你的 uid>';
```

重新登入後：
7. 訂單卡仍可點開，sheet 內所有編輯控制項停用（`canEdit=false`）

測完改回原本的角色：

```sql
update user_store_roles set role = 'super_admin' where user_id = '<你的 uid>';
```

- [ ] **Step 8: Commit**

```bash
git add src/pages/InboxPage.jsx
git commit -m "feat: 客服收件匣可直接開訂單詳情"
```

---

### Task 4: 合併回 main

- [ ] **Step 1: 從頭跑一次完整驗收**

把 Task 2 Step 4 的七項與 Task 3 Step 6 的六項再跑一次（分支上累積的改動可能互相影響）。

- [ ] **Step 2: 合併**

```bash
git checkout main
git merge feat/inbox-order-detail
```

- [ ] **Step 3: 通知 S2 可以開工**

S2（`feat/inbox-conversation-merge`）會改到同一支 `InboxPage.jsx`，它的前置條件就是這支合併完成。
