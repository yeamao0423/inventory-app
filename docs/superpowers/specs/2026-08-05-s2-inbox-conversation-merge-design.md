# S2 — 客服對話依會員彙整

**日期**：2026-08-05
**分支**：`feat/inbox-conversation-merge`
**Track**：A（第 2 支，**必須等 S1 合併進 main 之後才開工**——兩者都改 `InboxPage.jsx`）
**規模**：中

---

## 背景

對話的找回依據是 `(store_id, visitor_token)`：

- `supabase/functions/chat/index.ts:214-225`（GET，沒帶 conversationId 時找最近一條未關閉的）
- `:310-339`（POST，帶了就驗證、沒帶就新建）

`visitor_token` 是存在 localStorage 的隨機 UUID（`shop/src/lib/chat.js:12-21`）。登入**不影響**這條路徑，
只是事後由 `action: 'claim'` 把該 token 底下的對話補上 `consumer_id`（`chat/index.ts:242-263`）。

結果：同一位已登入的消費者，換瀏覽器、清 localStorage、開無痕、換手機，
每一次都是新的 `visitor_token` → 新的一條 `conversations`。客服端的列表因此長得很快，
而且同一個人的問題散在好幾列，看不出脈絡。

## 目標

1. **不再繼續長**：已登入的消費者發話時，重用他在該店的既有對話，而不是開新的。
2. **既有的收斂**：後台列表把同一位會員的多條對話收成一列，點開是單一時間軸。

## 非目標

- **不搬移既有資料**。不把舊對話的 `messages` 實際搬到另一條對話底下——那不可逆，
  `last_message_preview` 那組 trigger 快照要重算，而且 LINE 併進來時同一個問題會再來一次。
  合併是顯示層的事，資料層維持「一條對話 = 一個身分的一段」。
- 不動 LINE 那條路（`line_messages`）。`conversations.channel` 的 `'line'` 仍是預留值。
- 不改對話狀態機、限流、Turnstile、AI 開關。

---

## 設計

### 一、資料層：一條對話可以有多個裝置

新增 migration（檔名接在 `20250082_product_page_blocks.sql` 之後，用當日時間戳格式）：

```sql
create table if not exists public.conversation_devices (
  conversation_id bigint not null references public.conversations(id) on delete cascade,
  visitor_token   text   not null,
  store_id        bigint not null references public.stores(id) on delete cascade,
  first_seen_at   timestamptz not null default now(),
  primary key (conversation_id, visitor_token)
);

-- token → 對話的反查（取代現行的 conversations.visitor_token 查詢）
create index if not exists conversation_devices_token_idx
  on public.conversation_devices (store_id, visitor_token);

alter table public.conversation_devices enable row level security;
-- 後台成員唯讀（客服想知道這位客人從幾個裝置來過）；寫入只有 service role
create policy "members read conversation devices" on public.conversation_devices
  for select to authenticated using (public.is_store_member(store_id));
```

**回填**：把既有 `conversations` 的 `(id, visitor_token, store_id)` 灌進去（`visitor_token is not null`）。

`conversations.visitor_token` **保留不動**，語意變成「建立這條對話的第一個裝置」。
既有查詢與 broadcast 不必一次全改，回填後兩邊資料一致。

> 套用方式見 `docs/architecture.md` 與專案慣例：**絕不可跑 `supabase db push`**
> （remote 有 repo 沒有的 migration）。上 remote 走 MCP `apply_migration`，套 local 用 `psql -f`。

### 二、Edge Function：找對話的順序改變

`supabase/functions/chat/index.ts`

**新增**：一支 `resolveConsumerId(req)`——把 Authorization header 的 JWT 拿去
`admin.auth.getUser()`，成功且該 uid 存在於 `consumers` 就回傳它，否則回 `null`。
`handleClaim` 已經有等價邏輯（`:249-252`），抽出來三處共用。

**GET（`handleGet`）**：

```
consumerId = resolveConsumerId(req)          // 沒登入就是 null
若帶了 conversationId：
    撈該 id 且 store_id 相符的對話，然後驗證存取權：
      (a) consumerId 不為 null 且等於 conv.consumer_id     → 放行
      (b) (conv.id, visitorToken) 在 conversation_devices  → 放行
      其餘 → 當作查不到（回空，不是 403，不洩漏「這條對話存在」）
否則：
    consumerId 不為 null → 找 (store_id, consumer_id, status != 'closed') 最近一條
    找不到或沒登入      → 走 conversation_devices 反查 (store_id, visitorToken) 的最近一條未關閉對話
```

> **這條存取權檢查是這份 spec 的安全核心。** 現行程式靠 `.eq('visitor_token', …)` 擋住
> 「猜 conversationId 讀別人對話」；改成多裝置之後，那個條件不再成立，必須換成上面的 (a)/(b)。
> 少了它等於任何人都能用自己的 token 去讀任意對話。

**POST（`handlePost`）**：

- 找對話的順序同上。
- 建立新對話後，寫一筆 `conversation_devices`。
- **每次成功找到／建立對話，都 upsert 一筆 `(conversation_id, visitorToken, store_id)`**——
  這就是「這位會員又從一台新裝置來了」的登記點。`on conflict do nothing`。
- `handleClaim` 保留（舊版商城前端仍會呼叫），行為不變。

**Broadcast**：`broadcast(visitorTopic(token), …)` 現在只推一個頻道（`:353`、`:426`）。
改成先撈該對話的所有 token，逐一推。`notify.ts` 的 `broadcast()` 本身不用改，
在 `index.ts` 加一支 `broadcastToConversation(admin, conversationId, event, payload)` 包起來。

推不出去不影響訊息寫入（既有的 try/catch 行為保留），前端每 6 秒輪詢兜底。

### 三、商城端：送訊息時帶身分

`shop/src/lib/chat.js`：`loadHistory` 與 `sendMessage` 都多收一個 `accessToken`，
有值就放進 `Authorization: Bearer`（`headers()` 已經支援，`:28-34`）。

`shop/src/app/ChatWidget.jsx` 已經在用 `supabase.auth.getSession()`（`:88`），
把 token 存進 state 或每次呼叫前取一次，傳給上面兩支。沒登入就照舊不帶。

`claimConversations` 保留呼叫（結帳頁 `checkout/page.jsx:335` 也在用），不動。

### 四、後台：分組顯示

`src/lib/customerInbox.js` 新增純函式（**要寫 vitest，`src/lib` 有 test runner**）：

```js
/**
 * 把對話列表收成「一位顧客一列」。
 * 已識別會員（consumer_id 相同）併成一組；未識別訪客各自成組。
 * @returns {{ key, consumerId, conversationIds, label, channel,
 *             status, unread, lastMessageAt, lastMessagePreview, lastMessageSender }[]}
 */
export function groupConversations(list)
```

規則：

| 欄位 | 取法 |
|---|---|
| `key` | 有 `consumer_id` 用 `c:{consumer_id}`，否則 `v:{conversation_id}` |
| `status` | 組內**最急**的（沿用 `STATUS_RANK`：waiting_human < human < bot < closed） |
| `unread` | 組內 `unread_for_store` 加總 |
| `lastMessageAt` / 預覽 | 組內最新那條的值 |
| `label` | 組內第一個非空的 `customer_label`，沒有就 `'會員'` / `訪客 #id` |

`sortConversations` 改成吃 group（排序規則不變：等真人 → 有未讀 → 最後訊息時間），
或另寫 `sortGroups`。既有的 `sortConversations` 測試要一起更新。

`src/pages/InboxPage.jsx`：

- 列表改跑 group。列上多一個「3 個裝置」之類的細字**只在組內對話數 > 1 時**顯示。
- 點開時撈組內所有 `conversation_id` 的訊息，依 `created_at` 合併成單一時間軸。
  來源不同的相鄰訊息之間插一條細分隔線，標「另一個裝置・3/12 起」。
- 標已讀：對組內所有對話都清 `unread_for_store`。
- 接管／交還／結束：套用到組內**所有**對話（客服的心智模型是「處理這個人」，不是「處理這條記錄」）。
- 回覆：寫進組內 `last_message_at` 最新的那條。
- Realtime：訂閱組內所有 `visitor_token` 的頻道（要撈 `conversation_devices`，
  後台 RLS 已開唯讀）。

---

## 資料流

```
消費者（已登入，新裝置）送出訊息
  → chat.js sendMessage({ …, accessToken })
  → Edge Function：resolveConsumerId → 找到他在這店的既有對話
  → upsert conversation_devices(conv.id, 新 token)
  → 寫入 messages、更新 conversations
  → broadcastToConversation → 舊裝置與新裝置都收到
  → notifyStore → 店主推播

客服開收件匣
  → conversations（單表查詢，不變）+ conversation_devices（只在點開某組時撈）
  → groupConversations → 一位顧客一列
  → 點開 → messages where conversation_id in (組內全部) order by created_at
```

## 錯誤處理

| 情況 | 行為 |
|---|---|
| JWT 過期／無效 | 當作未登入，走 visitor_token 那條路，不報錯（對話不能因為 token 過期就斷掉） |
| 猜 conversationId + 自己的 token | GET 回空、POST 回 404，與現行一致 |
| `conversation_devices` upsert 失敗 | 記 log，不影響訊息寫入 |
| broadcast 推不到部分裝置 | 記 log，靠 6 秒輪詢兜底 |
| 組內某條對話被刪 | 分組函式對缺漏欄位要能容忍（回傳仍是合法 group），不丟例外 |

---

## 驗收清單

**純函式（vitest，`npm run test`）**：

1. `groupConversations`：同 consumer 的三條併一組、未識別訪客各自成組
2. 狀態取最急、未讀加總、預覽取最新
3. 空陣列、缺欄位、`consumer_id` 為 null 的混合輸入都不丟例外

**端對端（本機，需先 seed 會員——`scripts/sync-remote-to-local.mjs` 不含會員相關表）**：

4. 未登入訪客在商城發話 → 後台出現一條「訪客 #N」
5. 該訪客登入 → 認領生效，後台顯示會員名字
6. **換一個瀏覽器（或清 localStorage）登入同一帳號發話 → 後台仍是同一列，不是新的一列**
7. 點開該列 → 兩個裝置的訊息依時間排在同一條時間軸，接縫有分隔標記
8. 客服在後台回覆 → **兩個瀏覽器都收得到**（一個靠 broadcast、一個靠輪詢都算通過）
9. 接管 → 組內所有對話狀態都變 `human`
10. 未登入的訪客照舊各自一列，彼此看不到對方
11. **安全**：拿 A 的 conversationId + B 的 visitor_token 打 GET → 回空，讀不到內容

---

## 涉及檔案

- 新增 `supabase/migrations/<timestamp>_conversation_devices.sql`
- 改 `supabase/functions/chat/index.ts`
- 改 `shop/src/lib/chat.js`、`shop/src/app/ChatWidget.jsx`
- 改 `src/lib/customerInbox.js` + `src/lib/customerInbox.test.js`
- 改 `src/pages/InboxPage.jsx`

## 風險

- **存取權檢查改寫**是這份最危險的地方。改完務必跑驗收第 11 項。
- 新增 Edge Function 之後要 `supabase stop && supabase start` 才會被本地收錄；
  但這份是**改**既有的 function，不需要重建容器。
- `customerInbox.js` 與 Edge Function 的 `_shared/assistant/policy.ts` 是刻意維護的雙胞胎。
  `groupConversations` 只有後台用，**不要**複製過去。

## 完成後

跑完驗收 → commit → merge 回 `main` → migration 用 MCP `apply_migration` 上 remote。
