# S2 客服對話依會員彙整 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 同一位已登入消費者不管從幾台裝置來，客服端都只看到一列，且不再繼續長出新對話。

**Architecture:** 新增 `conversation_devices` 讓一條對話可以掛多個裝置識別碼；Edge Function 找對話的順序改成「登入身分優先、訪客識別碼次之」；後台用純函式把同一會員的既有對話收成一組顯示。既有資料不搬移。

**Tech Stack:** Postgres + RLS、Supabase Edge Function（Deno/TS）、Next.js 14 商城、React 18 後台、vitest

**Spec:** `docs/superpowers/specs/2026-08-05-s2-inbox-conversation-merge-design.md`

## Global Constraints

- 分支 `feat/inbox-conversation-merge`，在自己的 git worktree 執行。
- **前置條件：S1（`feat/inbox-order-detail`）必須已合併進 `main`**，兩者都改 `src/pages/InboxPage.jsx`。開工前先 `git log main --oneline -3` 確認。
- **絕不可跑 `supabase db push`** —— remote 有五支 repo 沒有的 migration，push 會亂。套 local 用 `psql -f`，上 remote 用 MCP `apply_migration`。
- 跨店紅線：同一位消費者在 A 店與 B 店的對話絕對不能互見。每一個查詢都要帶 `store_id`。
- 訪客識別碼是能力型鑰匙（ADR-0002），**不可**放進 URL 或任何會被記錄的地方。
- `src/lib/customerInbox.js` 與 `supabase/functions/_shared/assistant/policy.ts` 是刻意維護的雙胞胎。這次新增的 `groupConversations` **只有後台用，不要**複製到 `policy.ts`。
- 不新增 runtime 依賴。
- 本機：後台 :5173、商城 :3000、Supabase API :54331、PG `postgresql://postgres:postgres@127.0.0.1:54332/postgres`。
- **同步腳本不含會員相關表**，測會員功能要自己 seed（下面 Task 6 有步驟）。
- commit message 用繁體中文、簡潔，不要加 Co-Authored-By。

---

## File Structure

| 檔案 | 責任 |
|---|---|
| `supabase/migrations/20260805120000_conversation_devices.sql`（新） | 一條對話 ↔ 多個裝置識別碼的對照表、RLS、既有資料回填 |
| `src/lib/customerInbox.js`（改） | 新增 `groupConversations` / `sortGroups` 純函式 |
| `src/lib/customerInbox.test.js`（改） | 上述兩支的測試 |
| `supabase/functions/chat/index.ts`（改） | 身分解析、找對話順序、裝置登記、存取權檢查、多頻道推播 |
| `shop/src/lib/chat.js`（改） | `loadHistory` / `sendMessage` 帶登入憑證 |
| `shop/src/app/ChatWidget.jsx`（改） | 取得並傳入 access token |
| `src/pages/InboxPage.jsx`（改） | 分組列表、合併時間軸、動作套用整組 |

---

### Task 1: 資料表與回填

**Files:**
- Create: `supabase/migrations/20260805120000_conversation_devices.sql`

**Interfaces:**
- Produces: 表 `public.conversation_devices(conversation_id, visitor_token, store_id, first_seen_at)`，主鍵 `(conversation_id, visitor_token)`；索引 `(store_id, visitor_token)`；後台成員唯讀的 RLS policy。

- [ ] **Step 1: 寫 migration**

```sql
-- ============================================================
-- 一條對話可以有多個裝置
--
-- 原本對話的找回依據是 (store_id, visitor_token)，而 visitor_token 存在 localStorage。
-- 換瀏覽器、清快取、開無痕、換手機都會拿到新的識別碼 → 同一個人散成好幾條對話。
--
-- 這張表把「裝置」從 conversations 拆出來：對話屬於「人」，裝置只是他從哪裡連進來。
-- conversations.visitor_token 保留不動，語意變成「建立這條對話的第一個裝置」。
-- ============================================================

create table if not exists public.conversation_devices (
  conversation_id bigint not null references public.conversations(id) on delete cascade,
  visitor_token   text   not null,
  -- 冗餘欄位：讓 RLS 與反查不必 join conversations（與 messages.store_id 同一個理由）
  store_id        bigint not null references public.stores(id) on delete cascade,
  first_seen_at   timestamptz not null default now(),
  primary key (conversation_id, visitor_token)
);

-- 訪客回訪：以 (店, 訪客識別碼) 反查對話。取代原本查 conversations.visitor_token 的路徑。
create index if not exists conversation_devices_token_idx
  on public.conversation_devices (store_id, visitor_token);

alter table public.conversation_devices enable row level security;

-- 後台成員唯讀（客服想知道這位客人從幾台裝置來過）。寫入只有 service role（Edge Function）。
drop policy if exists "members read conversation devices" on public.conversation_devices;
create policy "members read conversation devices" on public.conversation_devices
  for select to authenticated
  using (public.is_store_member(store_id));

-- ── 回填 ────────────────────────────────────────────────────
-- 既有每一條對話的建立裝置。沒有 visitor_token 的（理論上不存在，identity_chk 允許
-- 只有 consumer_id 的情況）跳過。
insert into public.conversation_devices (conversation_id, visitor_token, store_id, first_seen_at)
select c.id, c.visitor_token, c.store_id, c.created_at
from public.conversations c
where c.visitor_token is not null
on conflict do nothing;
```

- [ ] **Step 2: 套用到 local**

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54332/postgres" \
  -f supabase/migrations/20260805120000_conversation_devices.sql
```

Expected: `CREATE TABLE` / `CREATE INDEX` / `CREATE POLICY` / `INSERT n` 沒有 ERROR。

- [ ] **Step 3: 驗證回填**

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54332/postgres" -c \
"select (select count(*) from conversations where visitor_token is not null) as convs,
        (select count(*) from conversation_devices) as devices;"
```

Expected: 兩個數字相同。

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260805120000_conversation_devices.sql
git commit -m "feat: 對話可掛多個裝置識別碼"
```

---

### Task 2: 分組純函式（TDD）

**Files:**
- Modify: `src/lib/customerInbox.js`（在檔尾「工作台排序」那一段之後）
- Test: `src/lib/customerInbox.test.js`

**Interfaces:**
- Produces:
  - `groupConversations(list) => Group[]`
  - `sortGroups(groups) => Group[]`
  - `Group = { key, consumerId, conversationIds, label, channel, status, unread, assignedTo, lastMessageAt, lastMessagePreview, lastMessageSender }`
- 後續 Task 6（`InboxPage`）只吃這兩支。

- [ ] **Step 1: 寫失敗的測試**

在 `src/lib/customerInbox.test.js` 的 import 清單加 `groupConversations, sortGroups`，並在檔尾加：

```js
describe('groupConversations — 同一位會員收成一列', () => {
  const base = {
    channel: 'web', status: 'bot', unread_for_store: 0,
    last_message_at: '2026-08-01T10:00:00Z', last_message_preview: '在嗎',
    last_message_sender: 'consumer', customer_label: null, assigned_to: null,
  }

  it('同一 consumer_id 的多條併成一組，未識別訪客各自成組', () => {
    const groups = groupConversations([
      { ...base, id: 1, consumer_id: 'u1' },
      { ...base, id: 2, consumer_id: 'u1' },
      { ...base, id: 3, consumer_id: null, visitor_token: 't3' },
      { ...base, id: 4, consumer_id: 'u2' },
    ])
    expect(groups).toHaveLength(3)
    const u1 = groups.find(g => g.key === 'c:u1')
    expect(u1.conversationIds).toEqual([1, 2])
    expect(groups.find(g => g.key === 'v:3').conversationIds).toEqual([3])
  })

  it('狀態取組內最急的（waiting_human < human < bot < closed）', () => {
    const g = groupConversations([
      { ...base, id: 1, consumer_id: 'u1', status: 'closed' },
      { ...base, id: 2, consumer_id: 'u1', status: 'waiting_human' },
      { ...base, id: 3, consumer_id: 'u1', status: 'bot' },
    ])[0]
    expect(g.status).toBe('waiting_human')
  })

  it('未讀加總，最後訊息取最新那條', () => {
    const g = groupConversations([
      { ...base, id: 1, consumer_id: 'u1', unread_for_store: 2,
        last_message_at: '2026-08-01T10:00:00Z', last_message_preview: '舊的' },
      { ...base, id: 2, consumer_id: 'u1', unread_for_store: 3,
        last_message_at: '2026-08-03T10:00:00Z', last_message_preview: '新的',
        last_message_sender: 'staff' },
    ])[0]
    expect(g.unread).toBe(5)
    expect(g.lastMessageAt).toBe('2026-08-03T10:00:00Z')
    expect(g.lastMessagePreview).toBe('新的')
    expect(g.lastMessageSender).toBe('staff')
  })

  it('名字取組內第一個非空的 customer_label', () => {
    const g = groupConversations([
      { ...base, id: 1, consumer_id: 'u1', customer_label: null },
      { ...base, id: 2, consumer_id: 'u1', customer_label: '王小明' },
    ])[0]
    expect(g.label).toBe('王小明')
  })

  it('assignedTo 取最新那條有指派的', () => {
    const g = groupConversations([
      { ...base, id: 1, consumer_id: 'u1', assigned_to: 'staff-a',
        last_message_at: '2026-08-01T10:00:00Z' },
      { ...base, id: 2, consumer_id: 'u1', assigned_to: null,
        last_message_at: '2026-08-03T10:00:00Z' },
    ])[0]
    expect(g.assignedTo).toBe('staff-a')
  })

  it('壞資料不丟例外', () => {
    expect(groupConversations(null)).toEqual([])
    expect(groupConversations(undefined)).toEqual([])
    expect(groupConversations([])).toEqual([])
    expect(() => groupConversations([null, undefined, {}, { id: 9 }])).not.toThrow()
  })
})

describe('sortGroups — 等真人優先，其次有未讀，再來最後訊息時間', () => {
  const g = (over) => ({
    key: 'k', consumerId: null, conversationIds: [1], label: null, channel: 'web',
    status: 'bot', unread: 0, assignedTo: null,
    lastMessageAt: '2026-08-01T10:00:00Z', lastMessagePreview: '', lastMessageSender: 'consumer',
    ...over,
  })

  it('等待真人排最前面', () => {
    const out = sortGroups([g({ key: 'a', status: 'bot' }), g({ key: 'b', status: 'waiting_human' })])
    expect(out[0].key).toBe('b')
  })

  it('同狀態時有未讀的在前', () => {
    const out = sortGroups([g({ key: 'a', unread: 0 }), g({ key: 'b', unread: 1 })])
    expect(out[0].key).toBe('b')
  })

  it('同狀態同未讀時比最後訊息時間', () => {
    const out = sortGroups([
      g({ key: 'a', lastMessageAt: '2026-08-01T10:00:00Z' }),
      g({ key: 'b', lastMessageAt: '2026-08-05T10:00:00Z' }),
    ])
    expect(out[0].key).toBe('b')
  })

  it('不就地改動輸入陣列', () => {
    const input = [g({ key: 'a', status: 'bot' }), g({ key: 'b', status: 'waiting_human' })]
    sortGroups(input)
    expect(input[0].key).toBe('a')
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm run test -- customerInbox`
Expected: FAIL，訊息是 `groupConversations is not a function`（或 import 解析失敗）。

- [ ] **Step 3: 實作**

在 `src/lib/customerInbox.js` 檔尾加：

```js
// ── 依「人」分組 ────────────────────────────────────────────
// 同一位會員可能在好幾台裝置留下好幾條對話（換瀏覽器、清快取、換手機）。
// 客服要處理的是「這個人」，不是「這條記錄」，所以列表以人為單位。
//
// 這是純顯示層的收斂：資料表不動、既有對話不搬。

/**
 * @param {Array} list conversations 的原始列（可含壞資料）
 * @returns {Array} 每位顧客一組
 */
export function groupConversations(list) {
  const map = new Map()
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || typeof c !== 'object') continue
    // 已識別的以人為鍵；未識別的訪客各自成組（他們之間本來就是不同的人）
    const key = c.consumer_id ? `c:${c.consumer_id}` : `v:${c.id}`
    let g = map.get(key)
    if (!g) {
      g = {
        key,
        consumerId: c.consumer_id ?? null,
        conversationIds: [],
        label: null,
        channel: c.channel ?? 'web',
        status: null,
        unread: 0,
        assignedTo: null,
        lastMessageAt: null,
        lastMessagePreview: null,
        lastMessageSender: null,
      }
      map.set(key, g)
    }
    g.conversationIds.push(c.id)
    g.unread += Number(c.unread_for_store) || 0
    if (!g.label && c.customer_label) g.label = c.customer_label
    // 狀態取最急的：客服看列表是在找「誰在等我」
    if (g.status === null || rank(c.status) < rank(g.status)) g.status = c.status
    // 最後訊息與指派對象跟著最新那條走
    if (newer(c.last_message_at, g.lastMessageAt)) {
      g.lastMessageAt = c.last_message_at ?? g.lastMessageAt
      g.lastMessagePreview = c.last_message_preview ?? null
      g.lastMessageSender = c.last_message_sender ?? null
    }
    if (c.assigned_to && newer(c.last_message_at, g._assignedAt)) {
      g.assignedTo = c.assigned_to
      g._assignedAt = c.last_message_at ?? null
    }
  }
  return [...map.values()].map(({ _assignedAt, ...g }) => ({
    ...g,
    status: g.status ?? 'bot',
    conversationIds: g.conversationIds.filter(id => id != null),
  }))
}

function rank(status) {
  return STATUS_RANK[status] ?? 9
}

function newer(a, b) {
  if (!a) return false
  if (!b) return true
  return new Date(a) > new Date(b)
}

/** 與 sortConversations 同一套規則，只是吃分組後的形狀。 */
export function sortGroups(list) {
  return [...list].sort((a, b) => {
    const sa = rank(a.status)
    const sb = rank(b.status)
    if (sa !== sb) return sa - sb
    const ua = (a.unread ?? 0) > 0 ? 0 : 1
    const ub = (b.unread ?? 0) > 0 ? 0 : 1
    if (ua !== ub) return ua - ub
    return new Date(b.lastMessageAt ?? 0) - new Date(a.lastMessageAt ?? 0)
  })
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm run test -- customerInbox`
Expected: PASS，且原本既有的測試（狀態機、限流、記憶、排序）全部仍然通過。

- [ ] **Step 5: Commit**

```bash
git add src/lib/customerInbox.js src/lib/customerInbox.test.js
git commit -m "feat: 客服對話依會員分組的純函式"
```

---

### Task 3: Edge Function — 身分解析與找對話順序

**Files:**
- Modify: `supabase/functions/chat/index.ts`

**Interfaces:**
- Consumes: `conversation_devices`（Task 1）
- Produces: 內部函式 `resolveConsumerId(req)`、`findConversation({ storeId, consumerId, visitorToken, conversationId })`、`rememberDevice(conv, visitorToken)`

- [ ] **Step 1: 加身分解析**

在 `handleClaim` 上面加（它自己也改用這支，`:249-252` 那三行換掉）：

```ts
// 由消費者自己的 access token 證明身分，不能讓呼叫端直接指定 consumer_id。
// 沒帶 token、token 過期、不是消費者 → 一律回 null，走訪客那條路。
// 對話不該因為登入過期就斷掉。
async function resolveConsumerId(req: Request): Promise<string | null> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  // 商城送的 anon key 也會出現在這個 header，長度與格式都像 JWT，所以一定要真的驗
  if (!jwt) return null;
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data?.user) return null;
  const { data: consumer } = await admin
    .from("consumers").select("id").eq("id", data.user.id).maybeSingle();
  return consumer?.id ?? null;
}
```

- [ ] **Step 2: 加裝置登記與對話查找**

```ts
const CONV_COLS = "id, store_id, status, consumer_id, visitor_token, unread_for_store";

// 這位客人又從一台新裝置來了。失敗不影響訊息寫入 —— 少一筆對照只是下次要重新認一次。
async function rememberDevice(conv: ConversationRow, visitorToken: string) {
  const { error } = await admin
    .from("conversation_devices")
    .upsert(
      { conversation_id: conv.id, visitor_token: visitorToken, store_id: conv.store_id },
      { onConflict: "conversation_id,visitor_token", ignoreDuplicates: true },
    );
  if (error) console.error("rememberDevice failed", error.message);
}

/** 這個訪客識別碼登記在哪些對話底下（用來反查與推播）。 */
async function conversationIdsForToken(storeId: number, visitorToken: string): Promise<number[]> {
  const { data } = await admin
    .from("conversation_devices")
    .select("conversation_id")
    .eq("store_id", storeId)
    .eq("visitor_token", visitorToken);
  return (data ?? []).map((r) => r.conversation_id as number);
}

/**
 * 找出這次該用哪一條對話。
 *   帶了 conversationId → 撈出來並驗存取權（見下方 canAccess）
 *   已登入             → 該店該會員最近一條未關閉的
 *   其餘               → 該訪客識別碼登記過的最近一條未關閉的
 * 找不到回 null（呼叫端決定要不要建新的）。
 */
async function findConversation(
  { storeId, consumerId, visitorToken, conversationId }: {
    storeId: number; consumerId: string | null; visitorToken: string; conversationId?: number;
  },
): Promise<ConversationRow | null> {
  if (conversationId && Number.isInteger(conversationId) && conversationId > 0) {
    const { data } = await admin
      .from("conversations").select(CONV_COLS)
      .eq("id", conversationId).eq("store_id", storeId).maybeSingle();
    const conv = data as ConversationRow | null;
    if (!conv) return null;
    return (await canAccess(conv, consumerId, visitorToken)) ? conv : null;
  }

  if (consumerId) {
    const { data } = await admin
      .from("conversations").select(CONV_COLS)
      .eq("store_id", storeId).eq("consumer_id", consumerId).neq("status", "closed")
      .order("last_message_at", { ascending: false }).limit(1).maybeSingle();
    if (data) return data as ConversationRow;
  }

  const ids = await conversationIdsForToken(storeId, visitorToken);
  if (ids.length === 0) return null;
  const { data } = await admin
    .from("conversations").select(CONV_COLS)
    .eq("store_id", storeId).in("id", ids).neq("status", "closed")
    .order("last_message_at", { ascending: false }).limit(1).maybeSingle();
  return (data as ConversationRow | null) ?? null;
}

/**
 * 能不能讀寫這條對話。
 *
 * 原本靠 .eq("visitor_token", …) 把「猜 conversationId 讀別人對話」擋在查詢裡；
 * 一條對話能掛多個裝置之後那個條件不再成立，必須換成這裡的兩條規則。
 * 少了它，任何人都能用自己的識別碼去讀任意對話。
 */
async function canAccess(
  conv: ConversationRow, consumerId: string | null, visitorToken: string,
): Promise<boolean> {
  if (consumerId && conv.consumer_id === consumerId) return true;
  const { data } = await admin
    .from("conversation_devices").select("conversation_id")
    .eq("conversation_id", conv.id).eq("visitor_token", visitorToken).maybeSingle();
  return !!data;
}
```

- [ ] **Step 3: 改寫 `handleGet`**

`handleGet(url)` 的簽名改成 `handleGet(req: Request, url: URL)`（進入點 `:457` 跟著改成 `handleGet(req, url)`）。
把 `:204-225` 找對話那一段整個換掉：

```ts
  const consumerId = await resolveConsumerId(req);
  const conv = await findConversation({
    storeId, consumerId, visitorToken: visitorToken as string,
    conversationId: Number.isInteger(conversationId) && conversationId > 0 ? conversationId : undefined,
  });
```

其餘不變（`:227` 之後的空回應與訊息查詢照舊）。
存取權不足時 `findConversation` 回 `null` → 走既有的「回空」路徑，**不是 403**：
回 403 等於告訴對方「這條對話存在」。

- [ ] **Step 4: 改寫 `handlePost` 的找對話段**

`:306-339` 換成：

```ts
  // ── 找出或建立對話 ──
  const consumerId = await resolveConsumerId(req);
  const conversationId = Number(body.conversationId ?? 0);
  let conv = await findConversation({
    storeId, consumerId, visitorToken: visitorToken as string,
    conversationId: Number.isInteger(conversationId) && conversationId > 0 ? conversationId : undefined,
  });

  // 帶了 conversationId 卻找不到 = 不存在或不是你的，兩種都回 404（不區分，避免探測）
  if (!conv && Number.isInteger(conversationId) && conversationId > 0) {
    return json({ error: "找不到這條對話" }, 404);
  }

  if (!conv) {
    // 建立新對話才驗 Turnstile（每則訊息都驗會擋掉正常對話節奏）
    const ok = await verifyTurnstile(body.turnstileToken, ip);
    if (!ok) return json({ error: "人機驗證失敗，請重新整理再試" }, 403);
    if (!store.isActive) return json({ error: "店家不存在或未營運" }, 404);

    const { data, error } = await admin
      .from("conversations")
      .insert({
        store_id: storeId,
        channel: "web",
        visitor_token: visitorToken,     // 建立這條對話的第一個裝置
        consumer_id: consumerId,          // 一開始就知道是誰的話直接填上
        status: initialStatus({ aiEnabled }),
      })
      .select(CONV_COLS)
      .single();
    if (error) return json({ error: "建立對話失敗" }, 500);
    conv = data as ConversationRow;
  }

  // 每次都登記：這就是「同一個人又換了一台裝置」的紀錄點
  await rememberDevice(conv, visitorToken as string);
```

`conv` 之後所有用到的地方維持不變（狀態計算、寫入訊息、助理、通知）。

- [ ] **Step 5: `handleClaim` 改用共用函式**

`:249-252` 的三行 JWT 解析換成 `const consumerId = await resolveConsumerId(req)`；
`if (!consumerId) return json({ error: "需要登入" }, 401)`；
底下的 `.update({ consumer_id: userRes.user.id })` 改成 `.update({ consumer_id: consumerId })`。
認領成功後，把該 token 也登記進 `conversation_devices`（對每一條被認領的對話）。

- [ ] **Step 6: 本機驗證 Edge Function 起得來**

```bash
supabase functions serve chat --no-verify-jwt
```

Expected: 沒有 TypeScript 編譯錯誤。（改既有 function 不需要 `supabase stop && start`；**新增** function 才需要重建容器。）

用 curl 打一次 GET 確認基本路徑還通：

```bash
curl -s "http://127.0.0.1:54331/functions/v1/chat?storeId=1&visitorToken=$(uuidgen | tr 'A-Z' 'a-z')&sinceId=0" \
  -H "apikey: <local anon key>"
```

Expected: `{"conversationId":null,"status":null,"messages":[],"aiEnabled":…}`

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/chat/index.ts
git commit -m "feat: 聊天以登入身分找回對話，並登記多裝置"
```

---

### Task 4: Edge Function — 推播給對話的所有裝置

**Files:**
- Modify: `supabase/functions/chat/index.ts`

**Interfaces:**
- Consumes: `broadcast`（`./notify.ts`，不改）
- Produces: `broadcastToConversation(conv, event, payload)`

- [ ] **Step 1: 加多頻道推播**

```ts
/**
 * 推給這條對話的每一台裝置。
 * 頻道名＝訪客識別碼（猜不到就聽不到，ADR-0002），所以一條對話有幾台裝置就推幾次。
 * 推不出去不影響訊息寫入 —— 前端每 6 秒輪詢兜底。
 */
async function broadcastToConversation(conv: ConversationRow, event: string, payload: unknown) {
  const { data } = await admin
    .from("conversation_devices").select("visitor_token").eq("conversation_id", conv.id);
  const tokens = (data ?? []).map((r) => r.visitor_token as string);
  // 保險：對照表意外是空的就退回這條對話自己的建立裝置
  if (tokens.length === 0 && conv.visitor_token) tokens.push(conv.visitor_token);
  await Promise.all(tokens.map((t) => broadcast(visitorTopic(t), event, payload)));
}
```

- [ ] **Step 2: 換掉兩處單頻道推播**

`:353`（request_human 的狀態推播）與 `:426`（助理回覆推播）都改成
`await broadcastToConversation(conv, "status" | "message", { … })`，payload 內容不變。

- [ ] **Step 3: 後台回覆也要推給所有裝置**

`src/pages/InboxPage.jsx` 的 `send()`（`:188-202`）目前只訂閱 `active.visitor_token` 一個頻道。
**這一步先不動**，等 Task 6 一起改（那裡要拿整組的 token）。在這裡留一個 TODO 註解是不夠的 —— 直接在 Task 6 完成。

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/chat/index.ts
git commit -m "feat: 客服訊息推給對話的所有裝置"
```

---

### Task 5: 商城端帶上登入憑證

**Files:**
- Modify: `shop/src/lib/chat.js`、`shop/src/app/ChatWidget.jsx`

**Interfaces:**
- Produces: `loadHistory({ …, accessToken })`、`sendMessage({ …, accessToken })`、`requestHuman({ …, accessToken })`

- [ ] **Step 1: `shop/src/lib/chat.js` 三支都收 accessToken**

`headers(accessToken)` 已經支援（`:28-34`），只要把參數傳進去：

```js
export async function loadHistory({ storeId, visitorToken, conversationId, sinceId = 0, accessToken }) {
  const qs = new URLSearchParams({ storeId: String(storeId), visitorToken, sinceId: String(sinceId) })
  if (conversationId) qs.set('conversationId', String(conversationId))
  const res = await fetch(`${FN_URL}?${qs}`, { headers: headers(accessToken) })
  return parse(res)
}

export async function sendMessage({ storeId, visitorToken, conversationId, text, turnstileToken, accessToken }) {
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: headers(accessToken),
    body: JSON.stringify({ action: 'send', storeId, visitorToken, conversationId, text, turnstileToken }),
  })
  return parse(res)
}

export async function requestHuman({ storeId, visitorToken, conversationId, accessToken }) {
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: headers(accessToken),
    body: JSON.stringify({ action: 'request_human', storeId, visitorToken, conversationId }),
  })
  return parse(res)
}
```

檔頭的說明補一句：登入時帶自己的 access token，Edge Function 據此把對話歸到「人」而不是「這台裝置」。

- [ ] **Step 2: `ChatWidget.jsx` 取得並傳入 token**

`ChatWidget` 已經在用 `supabase.auth.getSession()`（`:88`）。加一個 state 跟著登入狀態走：

```js
const [accessToken, setAccessToken] = useState(null)

useEffect(() => {
  if (!supabase) return
  let alive = true
  supabase.auth.getSession().then(({ data: { session } }) => {
    if (alive) setAccessToken(session?.access_token ?? null)
  })
  const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
    setAccessToken(session?.access_token ?? null)
  })
  return () => { alive = false; subscription?.unsubscribe() }
}, [])
```

把 `accessToken` 加進所有 `loadHistory` / `sendMessage` / `requestHuman` 的呼叫參數。
沒登入時是 `null`，`headers()` 會退回 anon key —— 與現行行為相同。

- [ ] **Step 3: 瀏覽器驗證**

```bash
cd shop && npm run dev     # :3000
```

1. 未登入 → 開聊天視窗發一則訊息 → 正常收到回覆
2. 登入 → 發一則 → 正常
3. Network 面板看 POST `/functions/v1/chat` 的 Authorization header：未登入是 anon key、登入是使用者的 token

- [ ] **Step 4: Commit**

```bash
git add shop/src/lib/chat.js shop/src/app/ChatWidget.jsx
git commit -m "feat: 商城聊天帶上登入憑證"
```

---

### Task 6: 後台分組顯示

**Files:**
- Modify: `src/pages/InboxPage.jsx`

**Interfaces:**
- Consumes: `groupConversations` / `sortGroups`（Task 2）、`conversation_devices` 唯讀（Task 1）

- [ ] **Step 1: 列表改跑分組**

import 換成：

```js
import {
  nextStatusOnHandback, nextStatusOnTakeover, groupConversations, sortGroups,
} from '../lib/customerInbox'
```

`activeId` 的語意從「哪一條對話」改成「哪一組」，改名為 `activeKey`：

```js
const [activeKey, setActiveKey] = useState(null)

const groups = useMemo(() => sortGroups(groupConversations(conversations)), [conversations])
const active = useMemo(() => groups.find(g => g.key === activeKey) ?? null, [groups, activeKey])
```

`fetchConversations` 的查詢不變（仍是單表、每 6 秒輪詢）。

推播點進來的 `?c=123`（`:57-60`）改成：找出含有該 conversationId 的那一組，選它。

```js
useEffect(() => {
  const c = Number(new URLSearchParams(window.location.search).get('c'))
  if (!Number.isInteger(c) || c <= 0) return
  const g = groups.find(x => x.conversationIds.includes(c))
  if (g) setActiveKey(g.key)
}, [groups])
```

- [ ] **Step 2: 訊息改成合併時間軸**

```js
async function fetchMessages(ids) {
  if (!ids?.length) { setMessages([]); return }
  const { data } = await supabase
    .from('messages')
    .select('id, conversation_id, sender, sender_user_id, content, created_at')
    .in('conversation_id', ids)
    .order('created_at', { ascending: true })
    .limit(500)
  setMessages(data ?? [])
}
```

渲染時，`conversation_id` 與前一則不同就插一條分隔線：

```jsx
{messages.map((m, i) => {
  const prev = messages[i - 1]
  const seam = prev && prev.conversation_id !== m.conversation_id
  return (
    <div key={m.id}>
      {seam && (
        <div className="inbox-seam">
          另一個裝置・{new Date(m.created_at).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' })} 起
        </div>
      )}
      <div className={`inbox-msg ${m.sender === 'consumer' ? 'them' : 'me'}`}>
        …（內容不變）…
      </div>
    </div>
  )
})}
```

樣式加進頁尾 `<style>`：

```css
.inbox-seam {
  text-align: center; font-size: 11px; color: var(--text-3);
  margin: 6px 0; position: relative;
}
.inbox-seam::before, .inbox-seam::after {
  content: ''; position: absolute; top: 50%; width: calc(50% - 60px);
  border-top: 0.5px solid var(--border-light);
}
.inbox-seam::before { left: 0; }
.inbox-seam::after { right: 0; }
```

- [ ] **Step 3: 動作套用整組**

`markRead`、`setStatus`（接管／交還／結束）都改成吃整組的 `conversationIds`：

```js
async function markRead(ids) {
  if (!canReply || !ids?.length) return
  await supabase.from('conversations').update({ unread_for_store: 0 }).in('id', ids)
  setConversations(prev => prev.map(c => ids.includes(c.id) ? { ...c, unread_for_store: 0 } : c))
}

async function setStatus(status, extra = {}) {
  if (!active || !canReply) return
  setBusy(true)
  // 客服的心智模型是「處理這個人」，不是「處理這條記錄」——
  // 只改其中一條會讓同一個人在列表上同時是「真人接管中」和「等待真人」
  const { error } = await supabase
    .from('conversations').update({ status, ...extra }).in('id', active.conversationIds)
  if (error) alert('更新失敗：' + error.message)
  else await fetchConversations()
  setBusy(false)
}
```

- [ ] **Step 4: 回覆寫進最新那條**

`send()` 需要一個「這一組裡最新的 conversation_id」。從 `conversations` 原始列算：

```js
const targetConvId = useMemo(() => {
  if (!active) return null
  const rows = conversations.filter(c => active.conversationIds.includes(c.id))
  rows.sort((a, b) => new Date(b.last_message_at ?? 0) - new Date(a.last_message_at ?? 0))
  return rows[0]?.id ?? null
}, [conversations, active])
```

`send()` 裡的 `active.id` 全部換成 `targetConvId`，`.eq('id', active.id)` 換成 `.eq('id', targetConvId)`，
清未讀改成 `markRead(active.conversationIds)`。

- [ ] **Step 5: Realtime 訂閱整組的裝置**

`:138-145` 的單頻道訂閱改成：

```js
// 這一組有幾台裝置就訂幾個頻道 —— 客服回的訊息要推到客人「正在看的那一台」，
// 而我們不知道是哪一台
useEffect(() => {
  channelsRef.current = []
  if (!active) return
  let cancelled = false
  const chans = []
  ;(async () => {
    const { data } = await supabase
      .from('conversation_devices')
      .select('visitor_token')
      .in('conversation_id', active.conversationIds)
    if (cancelled) return
    const tokens = [...new Set((data ?? []).map(r => r.visitor_token))]
    tokens.forEach(t => {
      const ch = supabase.channel(`chat:${t}`)
      ch.subscribe(status => {
        if (status === 'SUBSCRIBED' && !cancelled) channelsRef.current.push(ch)
      })
      chans.push(ch)
    })
  })()
  return () => {
    cancelled = true
    channelsRef.current = []
    chans.forEach(ch => supabase.removeChannel(ch))
  }
}, [active?.key])
```

`channelRef` 改名 `channelsRef`（初值 `useRef([])`），`send()` 裡改成對每個頻道各送一次：

```js
await Promise.all(channelsRef.current.map(ch => ch.send({
  type: 'broadcast', event: 'message',
  payload: { conversationId: targetConvId, message: data, status: active.status },
}).catch(e => console.error('broadcast failed', e))))
```

- [ ] **Step 6: 列表列顯示裝置數**

`.inbox-row-meta` 裡，只在 `g.conversationIds.length > 1` 時多一個細字：

```jsx
{g.conversationIds.length > 1 && (
  <span className="inbox-row-devices">{g.conversationIds.length} 段對話</span>
)}
```

`displayName` / `avatarText` 改成吃 group：`g.label` → 有就用；`g.consumerId` → `'會員'`；
否則 `訪客 #${g.conversationIds[0]}`。

- [ ] **Step 7: 端對端驗證**

前置 seed（同步腳本不含會員相關表）：
1. 商城註冊一個會員帳號並下一筆單（讓 `customer_label` 有值）
2. 用該帳號登入商城，開聊天視窗發一則訊息

驗收：

1. 未登入訪客發話 → 後台出現一列「訪客 #N」
2. 該訪客登入 → 後台顯示會員名字
3. **換另一個瀏覽器（或清 localStorage）登入同一帳號發話 → 後台仍是同一列，不是新的一列**
4. 點開該列 → 兩台裝置的訊息依時間排在同一條時間軸，接縫有「另一個裝置」分隔線
5. 客服回覆 → 兩個瀏覽器都收得到（一個靠 broadcast、一個靠 6 秒輪詢都算通過）
6. 按「接管」→ 用 psql 確認組內**所有**對話的 status 都變 `human`
7. 未登入的兩位訪客各自一列，彼此看不到對方
8. 推播點進來的 `?c=<某條對話 id>` 會開到正確的那一組

- [ ] **Step 8: 安全驗證（不可跳過）**

拿 A 的 conversationId 配 B 的 visitor_token 打 GET：

```bash
curl -s "http://127.0.0.1:54331/functions/v1/chat?storeId=1&visitorToken=<B的token>&conversationId=<A的對話id>&sinceId=0" \
  -H "apikey: <local anon key>"
```

Expected: `{"conversationId":null,…,"messages":[]}` —— 讀不到任何內容，也不是 403。

同樣的組合打 POST send：

```bash
curl -s -X POST "http://127.0.0.1:54331/functions/v1/chat" \
  -H "apikey: <local anon key>" -H "Content-Type: application/json" \
  -d '{"action":"send","storeId":1,"visitorToken":"<B的token>","conversationId":<A的對話id>,"text":"hi"}'
```

Expected: `{"error":"找不到這條對話"}`，HTTP 404。

- [ ] **Step 9: Commit**

```bash
git add src/pages/InboxPage.jsx
git commit -m "feat: 收件匣以會員為單位顯示對話"
```

---

### Task 7: 合併與上 remote

- [ ] **Step 1: 從頭跑一次完整驗收**

Task 2 的 vitest（`npm run test`）+ Task 6 的八項端對端 + Task 6 Step 8 的兩項安全驗證。

- [ ] **Step 2: 合併**

```bash
git checkout main
git merge feat/inbox-conversation-merge
```

- [ ] **Step 3: migration 上 remote**

用 MCP `apply_migration` 套用 `20260805120000_conversation_devices.sql`。
**不要**跑 `supabase db push`。

- [ ] **Step 4: 部署 Edge Function**

```bash
supabase functions deploy chat
```

部署後在正式環境重跑 Task 6 Step 7 的第 3 項（換裝置登入不會長新對話）與 Step 8 的安全驗證。
