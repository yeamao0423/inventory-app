# 行程訂單範圍可編輯 ＋ 客戶維度改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓使用者手動決定一趟行程涵蓋哪些訂單，並讓行程報表的客戶區塊看得到下單時間、買了什麼、以及該客戶的利潤。

**Architecture:** 在 `consumer_orders` 加 `trip_id` ＋ `trip_excluded` 兩個欄位，日期區間降級為「預設建議」；納入判定抽成純函式 `src/lib/tripScope.js`，客戶聚合抽成 `src/lib/tripCustomers.js`，兩者都不自己算財務 —— 一律透過既有的 `computeOrderFinance`。`TripsPage.jsx` 只負責撈資料與畫 UI。

**Tech Stack:** React 18 + Vite、Supabase (PostgREST + SQL migration)、vitest。

**Spec:** `docs/archive/trip-order-scope-and-customers-plan.md`

## Global Constraints

- 回覆與程式碼註解一律**繁體中文**
- **不新增任何 runtime 依賴**。需要小工具就手寫
- **絕不執行 `supabase db push`** —— remote 有 5 支 repo 沒有的 migration，push 會炸。
  local 套 migration 用 `psql -f`，remote 用 MCP `apply_migration`
- **不 push**，除非使用者明確允許
- 執行任何 git 或變更性指令**前先把內容列給使用者確認**
- commit message 簡潔，**不要加 `Co-Authored-By`**
- 範例資料**不得使用真實顧客資料／PII**
- 財務數字一律走 `src/lib/orderFinance.js`，頁面不自己 reduce 總額
- 測試指令：`npx vitest run <path>`（`npm test` 會進 watch mode）
- 商城 dev server 若在跑，**不要執行 `npm run build`**

---

### Task 1: Migration — `consumer_orders` 加行程歸屬欄位

**Files:**
- Create: `supabase/migrations/20260808120000_consumer_orders_trip_scope.sql`

**Interfaces:**
- Consumes: 既有 `trips(id)`、`consumer_orders(id)`
- Produces: `consumer_orders.trip_id bigint NULL`、`consumer_orders.trip_excluded boolean NOT NULL DEFAULT false`

- [ ] **Step 1: 寫 migration 檔**

建立 `supabase/migrations/20260808120000_consumer_orders_trip_scope.sql`：

```sql
-- ══════════════════════════════════════════════
-- 行程訂單歸屬
--
-- 問題：行程報表的訂單來源完全是日期區間（TripsPage 的 depart_date ~ return_date），
--       區間內只要不是「已取消」就一律算進拆帳。但區間內可能混進其他行程的單
--       （兩趟時間重疊），也可能有根本不屬於任何行程的常規訂單。
--       使用者沒有任何辦法把它們踢出去。
--
-- 做法：區間降級成「預設建議」，人工覆寫存在訂單上。
--
--   trip_id = NULL, trip_excluded = false  → 沒人管過，落在誰的區間就算誰的
--                                            （既有訂單全是這狀態，行為不變）
--   trip_id = NULL, trip_excluded = true   → 人工標記為常規訂單，不進任何行程
--   trip_id = X                            → 人工釘在 X 趟，區間不符也算 X 趟的
--
-- 第三種狀態是給「兩趟區間重疊」用的：在 A 趟勾掉會標成常規訂單，
-- 到 B 趟的清單勾回來就寫 trip_id = B，A 趟自動排除、B 趟納入。搬單即完成。
--
-- 行程刪除時用 SET NULL 而不是 CASCADE —— 訂單本身跟行程無關，
-- 不能因為行程被刪掉就跟著消失。
-- ══════════════════════════════════════════════

BEGIN;

ALTER TABLE consumer_orders
  ADD COLUMN IF NOT EXISTS trip_id       bigint REFERENCES trips(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS trip_excluded boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN consumer_orders.trip_id IS
  '人工釘住的行程。非 NULL 時無視日期區間，只算這趟。';
COMMENT ON COLUMN consumer_orders.trip_excluded IS
  'true = 人工標記為常規訂單，不屬於任何行程。只在 trip_id 為 NULL 時有意義。';

CREATE INDEX IF NOT EXISTS idx_consumer_orders_trip
  ON consumer_orders(trip_id) WHERE trip_id IS NOT NULL;

COMMIT;
```

- [ ] **Step 2: 套到 local**

先把指令列給使用者確認再跑：

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54332/postgres" \
  -f supabase/migrations/20260808120000_consumer_orders_trip_scope.sql
```

Expected：`ALTER TABLE` / `COMMENT` / `CREATE INDEX` / `COMMIT`，沒有 ERROR。

- [ ] **Step 3: 驗證欄位存在且既有資料不受影響**

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54332/postgres" -c \
  "select count(*) as total,
          count(trip_id) as pinned,
          count(*) filter (where trip_excluded) as excluded
     from consumer_orders;"
```

Expected：`pinned = 0`、`excluded = 0`、`total` 等於原本的訂單數 —— 既有訂單全部維持「沒人管過」狀態。

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260808120000_consumer_orders_trip_scope.sql
git commit -m "feat: consumer_orders 加 trip_id / trip_excluded，行程訂單可人工歸屬"
```

---

### Task 2: `src/lib/tripScope.js` — 納入規則純函式

**Files:**
- Create: `src/lib/tripScope.js`
- Create: `src/lib/tripScope.test.js`

**Interfaces:**
- Consumes: `taipeiDayStart` / `taipeiDayEnd`（`src/lib/orderFinance.js` 已 export）
- Produces:
  - `isWithinTripRange(createdAt: string, trip: {depart_date, return_date}) => boolean`
  - `isOrderInTrip(order: {trip_id, trip_excluded, created_at}, trip: {id, depart_date, return_date}) => boolean`
  - `splitOrdersByTrip(orders: object[], trip) => { included: object[], excluded: object[] }`

- [ ] **Step 1: 寫失敗的測試**

建立 `src/lib/tripScope.test.js`：

```js
import { describe, it, expect } from 'vitest'
import { isWithinTripRange, isOrderInTrip, splitOrdersByTrip } from './tripScope'

const tripA = { id: 1, depart_date: '2026-07-01', return_date: '2026-07-05' }
const tripB = { id: 2, depart_date: '2026-07-04', return_date: '2026-07-08' }

// 區間內的時間點，讓歸屬矩陣的六格只差在 trip_id / trip_excluded
const IN = '2026-07-03T10:00:00+08:00'
const OUT = '2026-07-20T10:00:00+08:00'

describe('isWithinTripRange', () => {
  it('用台北日界線，不是 UTC 午夜', () => {
    expect(isWithinTripRange('2026-06-30T23:59:59+08:00', tripA)).toBe(false)
    expect(isWithinTripRange('2026-07-01T00:00:00+08:00', tripA)).toBe(true)
    expect(isWithinTripRange('2026-07-05T23:59:59+08:00', tripA)).toBe(true)
    expect(isWithinTripRange('2026-07-06T00:00:00+08:00', tripA)).toBe(false)
  })

  it('DB 回傳的 UTC 字串也要判對', () => {
    // 台北 2026-06-30 23:59:59 → 出發日前一刻，不算
    expect(isWithinTripRange('2026-06-30T15:59:59Z', tripA)).toBe(false)
    // 台北 2026-07-01 00:00:00 → 出發日開始，算
    expect(isWithinTripRange('2026-06-30T16:00:00Z', tripA)).toBe(true)
  })

  it('資料不完整就回 false，不要炸', () => {
    expect(isWithinTripRange(null, tripA)).toBe(false)
    expect(isWithinTripRange('not-a-date', tripA)).toBe(false)
    expect(isWithinTripRange(IN, { id: 1 })).toBe(false)
  })
})

describe('isOrderInTrip 歸屬矩陣', () => {
  it('沒人管過 + 區間內 → 納入', () => {
    expect(isOrderInTrip({ trip_id: null, trip_excluded: false, created_at: IN }, tripA)).toBe(true)
  })
  it('沒人管過 + 區間外 → 不納入', () => {
    expect(isOrderInTrip({ trip_id: null, trip_excluded: false, created_at: OUT }, tripA)).toBe(false)
  })
  it('標成常規訂單 + 區間內 → 不納入', () => {
    expect(isOrderInTrip({ trip_id: null, trip_excluded: true, created_at: IN }, tripA)).toBe(false)
  })
  it('標成常規訂單 + 區間外 → 不納入', () => {
    expect(isOrderInTrip({ trip_id: null, trip_excluded: true, created_at: OUT }, tripA)).toBe(false)
  })
  it('釘在本趟 + 區間外 → 仍然納入', () => {
    expect(isOrderInTrip({ trip_id: 1, trip_excluded: false, created_at: OUT }, tripA)).toBe(true)
  })
  it('釘在別趟 + 區間內 → 不納入', () => {
    expect(isOrderInTrip({ trip_id: 2, trip_excluded: false, created_at: IN }, tripA)).toBe(false)
  })

  it('trip_id 型別不一致也要判對（PostgREST 可能回字串）', () => {
    expect(isOrderInTrip({ trip_id: '1', created_at: OUT }, tripA)).toBe(true)
  })

  it('欄位還沒建好（undefined）時退回純區間判定', () => {
    expect(isOrderInTrip({ created_at: IN }, tripA)).toBe(true)
    expect(isOrderInTrip({ created_at: OUT }, tripA)).toBe(false)
  })

  it('缺參數回 false', () => {
    expect(isOrderInTrip(null, tripA)).toBe(false)
    expect(isOrderInTrip({ created_at: IN }, null)).toBe(false)
  })
})

describe('區間重疊時的搬單', () => {
  const order = { id: 9, trip_id: null, trip_excluded: false, created_at: '2026-07-04T10:00:00+08:00' }

  it('沒人管過時，重疊區間的兩趟都會算到同一張單', () => {
    expect(isOrderInTrip(order, tripA)).toBe(true)
    expect(isOrderInTrip(order, tripB)).toBe(true)
  })

  it('釘給 B 之後，A 自動排除、B 納入', () => {
    const moved = { ...order, trip_id: 2, trip_excluded: false }
    expect(isOrderInTrip(moved, tripA)).toBe(false)
    expect(isOrderInTrip(moved, tripB)).toBe(true)
  })
})

describe('splitOrdersByTrip', () => {
  it('分成納入／排除兩組且不漏單', () => {
    const orders = [
      { id: 1, trip_id: null, trip_excluded: false, created_at: IN },
      { id: 2, trip_id: null, trip_excluded: true, created_at: IN },
      { id: 3, trip_id: 2, trip_excluded: false, created_at: IN },
      { id: 4, trip_id: 1, trip_excluded: false, created_at: OUT },
    ]
    const { included, excluded } = splitOrdersByTrip(orders, tripA)
    expect(included.map(o => o.id)).toEqual([1, 4])
    expect(excluded.map(o => o.id)).toEqual([2, 3])
  })

  it('空陣列不炸', () => {
    expect(splitOrdersByTrip([], tripA)).toEqual({ included: [], excluded: [] })
    expect(splitOrdersByTrip(undefined, tripA)).toEqual({ included: [], excluded: [] })
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run src/lib/tripScope.test.js`
Expected: FAIL，訊息類似 `Failed to resolve import "./tripScope"`。

- [ ] **Step 3: 寫最小實作**

建立 `src/lib/tripScope.js`：

```js
import { taipeiDayStart, taipeiDayEnd } from './orderFinance'

/**
 * 行程訂單納入規則 —— 唯一判定處。
 *
 * 訂單原本完全靠日期區間歸屬行程，但區間內可能混進別趟的單或常規訂單。
 * consumer_orders.trip_id / trip_excluded 讓使用者人工覆寫（見 20260808120000）：
 *
 *   trip_id === trip.id                → 人工釘住，區間不符也算
 *   trip_id 為 null 且未標常規          → 沒人管過，落在區間就算
 *   其餘                                → 不算（釘給別趟，或標成常規訂單）
 */

/** 訂單建立時間落在行程區間內嗎（台北日界線，跟報表查詢同一套） */
export function isWithinTripRange(createdAt, trip) {
  if (!createdAt || !trip?.depart_date || !trip?.return_date) return false
  const t = new Date(createdAt).getTime()
  if (Number.isNaN(t)) return false
  const start = new Date(taipeiDayStart(trip.depart_date)).getTime()
  const end = new Date(taipeiDayEnd(trip.return_date)).getTime()
  return t >= start && t <= end
}

export function isOrderInTrip(order, trip) {
  if (!order || !trip) return false
  // PostgREST 的 bigint 有可能回字串，兩邊都轉字串比
  if (order.trip_id != null) return String(order.trip_id) === String(trip.id)
  if (order.trip_excluded) return false
  return isWithinTripRange(order.created_at, trip)
}

/** 一次判定、兩邊共用：財務吃 included，勾選清單兩組都要畫 */
export function splitOrdersByTrip(orders = [], trip) {
  const included = []
  const excluded = []
  ;(orders || []).forEach(o => {
    if (isOrderInTrip(o, trip)) included.push(o)
    else excluded.push(o)
  })
  return { included, excluded }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run src/lib/tripScope.test.js`
Expected: PASS，全部 case 綠燈。

- [ ] **Step 5: Commit**

```bash
git add src/lib/tripScope.js src/lib/tripScope.test.js
git commit -m "feat: 行程訂單納入規則抽成 tripScope，區間降級為預設建議"
```

---

### Task 3: `src/lib/tripCustomers.js` — 客戶維度聚合

**Files:**
- Modify: `src/lib/orderFinance.js:50`（`function round2` → `export function round2`）
- Create: `src/lib/tripCustomers.js`
- Create: `src/lib/tripCustomers.test.js`

**Interfaces:**
- Consumes: `computeOrderFinance(order, ctx)`、`round2(n)`（皆來自 `src/lib/orderFinance.js`）
- Produces:
  - `buildCustomerSummaries(orders, ctx) => CustomerSummary[]`（依 `paidTotal` 由大到小）
  - `sortCustomers(customers, sortBy: 'amount'|'profit'|'recent') => CustomerSummary[]`（回新陣列，不改原陣列）
  - `CustomerSummary` 形狀：
    ```
    { key, name, email, isNew, paidTotal, profit, orderCount,
      firstOrderAt, lastOrderAt, unknownShippingCount,
      orders:   [{ id, createdAt, paidTotal, profit, lines }],
      products: [{ key, name, variantLabel, qty, netRevenue, grossProfit }] }
    ```
  - `ctx` 除了 `computeOrderFinance` 需要的 `productMap / variantMap / rateMap / costSnapshots`，
    另外吃 `historicalEmails: Set<string>`（小寫 email，該行程開始前下過單的人）

- [ ] **Step 1: 把 `round2` 開放給其他 lib 模組**

修改 `src/lib/orderFinance.js:50`：

```js
export function round2(n) {
  return Math.round(n * 100) / 100
}
```

只加 `export`，函式本體不動。理由：客戶聚合要跟財務用同一套四捨五入，複製一份遲早漂掉。

- [ ] **Step 2: 寫失敗的測試**

建立 `src/lib/tripCustomers.test.js`：

```js
import { describe, it, expect } from 'vitest'
import { buildCustomerSummaries, sortCustomers } from './tripCustomers'

// 成本都寫死在 productMap，測的是聚合不是成本軸
const ctx = {
  productMap: {
    1: { id: 1, cost: 100, currency: 'TWD' },
    2: { id: 2, cost: 300, currency: 'TWD' },
  },
  variantMap: {},
  rateMap: {},
  historicalEmails: new Set(['old@example.test']),
}

function order(over = {}) {
  return {
    id: 'o1',
    created_at: '2026-07-02T10:00:00+08:00',
    email: 'new@example.test',
    customer_name: '測試客甲',
    items_json: [{ id: 1, name: 'A 商品', qty: 2, price: 250 }],
    discount_amount: 0,
    shipping_fee: 60,
    shipping_cost: 60,
    total_amount: 560,
    paid_amount: 560,
    ...over,
  }
}

describe('buildCustomerSummaries 基本聚合', () => {
  it('利潤 = 商品毛利 + 運費淨額', () => {
    // 淨營收 500、成本 200 → 毛利 300；運費 60 收 60 付 → 淨額 0
    const [c] = buildCustomerSummaries([order()], ctx)
    expect(c.profit).toBe(300)
    expect(c.paidTotal).toBe(560)
    expect(c.orderCount).toBe(1)
  })

  it('免運單的運費是店家倒貼，要吃掉利潤', () => {
    const [c] = buildCustomerSummaries([order({ shipping_fee: 0, shipping_cost: 60, total_amount: 500 })], ctx)
    expect(c.profit).toBe(240) // 300 − 60
  })

  it('物流成本不明時運費淨額算 0，並計入 unknownShippingCount', () => {
    const [c] = buildCustomerSummaries([order({ shipping_cost: null })], ctx)
    expect(c.profit).toBe(300) // 不能變成 360
    expect(c.unknownShippingCount).toBe(1)
  })

  it('客戶利潤等於旗下各單利潤相加', () => {
    const orders = [
      order({ id: 'o1' }),
      order({ id: 'o2', shipping_fee: 0, shipping_cost: 60, total_amount: 500 }),
    ]
    const [c] = buildCustomerSummaries(orders, ctx)
    expect(c.profit).toBe(c.orders.reduce((s, o) => s + o.profit, 0))
    expect(c.profit).toBe(540)
  })
})

describe('buildCustomerSummaries 分組與時間', () => {
  it('同一 email 的多張單合併，記錄首末下單時間', () => {
    const orders = [
      order({ id: 'o1', created_at: '2026-07-02T10:00:00+08:00' }),
      order({ id: 'o2', created_at: '2026-07-04T10:00:00+08:00' }),
    ]
    const [c] = buildCustomerSummaries(orders, ctx)
    expect(c.orderCount).toBe(2)
    expect(c.firstOrderAt).toBe('2026-07-02T10:00:00+08:00')
    expect(c.lastOrderAt).toBe('2026-07-04T10:00:00+08:00')
  })

  it('客戶旗下訂單由新到舊排序', () => {
    const orders = [
      order({ id: 'old', created_at: '2026-07-02T10:00:00+08:00' }),
      order({ id: 'new', created_at: '2026-07-04T10:00:00+08:00' }),
    ]
    const [c] = buildCustomerSummaries(orders, ctx)
    expect(c.orders.map(o => o.id)).toEqual(['new', 'old'])
  })

  it('沒有 email 就用姓名當 key，兩者都沒有就跳過', () => {
    const orders = [
      order({ id: 'a', email: null, customer_name: '無信箱客' }),
      order({ id: 'b', email: null, customer_name: null }),
    ]
    const list = buildCustomerSummaries(orders, ctx)
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('無信箱客')
  })

  it('新客判定看行程開始前有沒有下過單', () => {
    const orders = [
      order({ id: 'a', email: 'new@example.test' }),
      order({ id: 'b', email: 'old@example.test', customer_name: '回頭客' }),
    ]
    const list = buildCustomerSummaries(orders, ctx)
    expect(list.find(c => c.email === 'new@example.test').isNew).toBe(true)
    expect(list.find(c => c.email === 'old@example.test').isNew).toBe(false)
  })

  it('品項全取消的訂單不產生客戶列', () => {
    const dead = order({ items_json: [{ id: 1, name: 'A 商品', qty: 2, price: 250, status: 'cancelled' }] })
    expect(buildCustomerSummaries([dead], ctx)).toHaveLength(0)
  })
})

describe('buildCustomerSummaries 買了什麼', () => {
  it('跨單合併同一商品的數量與毛利', () => {
    const orders = [
      order({ id: 'o1', items_json: [{ id: 1, name: 'A 商品', qty: 2, price: 250 }] }),
      order({ id: 'o2', items_json: [{ id: 1, name: 'A 商品', qty: 1, price: 250 }] }),
    ]
    const [c] = buildCustomerSummaries(orders, ctx)
    expect(c.products).toHaveLength(1)
    expect(c.products[0].qty).toBe(3)
    expect(c.products[0].netRevenue).toBe(750)
    expect(c.products[0].grossProfit).toBe(450)
  })

  it('同商品不同規格分開列', () => {
    const o = order({
      items_json: [
        { id: 1, name: 'A 商品', variantLabel: 'M', qty: 1, price: 250 },
        { id: 1, name: 'A 商品', variantLabel: 'L', qty: 1, price: 250 },
      ],
      total_amount: 560,
    })
    const [c] = buildCustomerSummaries([o], ctx)
    expect(c.products.map(p => p.variantLabel).sort()).toEqual(['L', 'M'])
  })
})

describe('sortCustomers', () => {
  const list = [
    { key: 'a', paidTotal: 100, profit: 90, lastOrderAt: '2026-07-01T00:00:00+08:00' },
    { key: 'b', paidTotal: 300, profit: 10, lastOrderAt: '2026-07-05T00:00:00+08:00' },
    { key: 'c', paidTotal: 200, profit: 50, lastOrderAt: '2026-07-03T00:00:00+08:00' },
  ]

  it('金額由大到小', () => {
    expect(sortCustomers(list, 'amount').map(c => c.key)).toEqual(['b', 'c', 'a'])
  })
  it('利潤由大到小', () => {
    expect(sortCustomers(list, 'profit').map(c => c.key)).toEqual(['a', 'c', 'b'])
  })
  it('最近下單由新到舊', () => {
    expect(sortCustomers(list, 'recent').map(c => c.key)).toEqual(['b', 'c', 'a'])
  })
  it('不認得的排序鍵退回金額，且不改動原陣列', () => {
    const before = list.map(c => c.key)
    expect(sortCustomers(list, 'nonsense').map(c => c.key)).toEqual(['b', 'c', 'a'])
    expect(list.map(c => c.key)).toEqual(before)
  })
})
```

- [ ] **Step 3: 跑測試確認失敗**

Run: `npx vitest run src/lib/tripCustomers.test.js`
Expected: FAIL，訊息類似 `Failed to resolve import "./tripCustomers"`。

- [ ] **Step 4: 寫最小實作**

建立 `src/lib/tripCustomers.js`：

```js
import { computeOrderFinance, round2 } from './orderFinance'

/**
 * 行程報表的客戶維度聚合。
 *
 * 財務不在這裡算 —— 每張單都丟給 computeOrderFinance，這裡只換一個聚合鍵。
 *
 * 利潤口徑刻意跟報表主數字不同：
 *   報表主數字 grossProfit = 淨營收(不含運費) − 商品成本，運費損益獨立一條，
 *   免運單才不會灌大營收分母。
 *   客戶維度問的是「這個人幫我賺了多少」，他付的運費與我們付的物流費都該算進去，
 *   所以 profit = grossProfit + shippingNet。
 *   兩個數字不會互相加總，看到不一樣不是 bug。
 *
 * shipping_cost 為 null 時 shippingNet 是 0（既有安全語意：成本不明就當收支相抵），
 * 這會讓利潤偏高，所以要把張數記在 unknownShippingCount 讓 UI 標出來。
 */
export function buildCustomerSummaries(orders = [], ctx = {}) {
  const historicalEmails = ctx.historicalEmails || new Set()
  const map = {}

  ;(orders || []).forEach(order => {
    const f = computeOrderFinance(order, ctx)
    if (f.isVoid) return // 品項全取消，等於沒這張單，跟 summarizeOrders 一致

    const key = (order.email || order.customer_name || '').toLowerCase()
    if (!key) return

    if (!map[key]) {
      map[key] = {
        key,
        name: order.customer_name || order.email || '',
        email: order.email || null,
        isNew: true,
        paidTotal: 0,
        profit: 0,
        orderCount: 0,
        firstOrderAt: null,
        lastOrderAt: null,
        unknownShippingCount: 0,
        orders: [],
        productAgg: {},
      }
    }
    const c = map[key]
    const profit = round2(f.grossProfit + f.shippingNet)

    c.paidTotal += f.totalAmount
    c.profit += profit
    c.orderCount += 1
    if (!f.shippingCostKnown) c.unknownShippingCount += 1

    const at = order.created_at || null
    if (at && (!c.firstOrderAt || at < c.firstOrderAt)) c.firstOrderAt = at
    if (at && (!c.lastOrderAt || at > c.lastOrderAt)) c.lastOrderAt = at

    c.orders.push({
      id: order.id,
      createdAt: at,
      paidTotal: f.totalAmount,
      profit,
      lines: f.lines,
    })

    f.lines.forEach(l => {
      // 同商品不同規格要分開列，客人買的是 M 還是 L 是有意義的
      const pk = `${l.productId ?? 'x'}|${l.variantLabel || ''}`
      if (!c.productAgg[pk]) {
        c.productAgg[pk] = {
          key: pk,
          name: l.name,
          variantLabel: l.variantLabel || '',
          qty: 0,
          netRevenue: 0,
          grossProfit: 0,
        }
      }
      const a = c.productAgg[pk]
      a.qty += l.qty
      a.netRevenue += l.netRevenue
      a.grossProfit += l.grossProfit
    })
  })

  return Object.values(map)
    .map(({ productAgg, ...c }) => ({
      ...c,
      paidTotal: round2(c.paidTotal),
      profit: round2(c.profit),
      isNew: !(c.email && historicalEmails.has(c.email.toLowerCase())),
      orders: c.orders.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')),
      products: Object.values(productAgg)
        .map(p => ({
          ...p,
          netRevenue: round2(p.netRevenue),
          grossProfit: round2(p.grossProfit),
        }))
        .sort((a, b) => b.netRevenue - a.netRevenue),
    }))
    .sort((a, b) => b.paidTotal - a.paidTotal)
}

/** 回新陣列，不動原本的（React state 直接餵進來也安全） */
export function sortCustomers(customers = [], sortBy = 'amount') {
  const list = [...(customers || [])]
  if (sortBy === 'profit') return list.sort((a, b) => b.profit - a.profit)
  if (sortBy === 'recent') return list.sort((a, b) => (b.lastOrderAt || '').localeCompare(a.lastOrderAt || ''))
  return list.sort((a, b) => b.paidTotal - a.paidTotal)
}
```

- [ ] **Step 5: 跑測試確認通過**

Run: `npx vitest run src/lib/tripCustomers.test.js`
Expected: PASS。

- [ ] **Step 6: 跑全部測試確認 `round2` 的 export 沒弄壞既有的**

Run: `npx vitest run`
Expected: 全綠，包含 `src/lib/orderFinance.test.js`。

- [ ] **Step 7: Commit**

```bash
git add src/lib/orderFinance.js src/lib/tripCustomers.js src/lib/tripCustomers.test.js
git commit -m "feat: 客戶維度聚合抽成 tripCustomers，利潤含運費淨額"
```

---

### Task 4: 行程報表改用 `tripScope` 決定訂單範圍 ＋ 訂單勾選 Sheet

**Files:**
- Modify: `src/pages/TripsPage.jsx`
  - `:1-8` import
  - `:196` state
  - `:215-253` `fetchReportData` 的訂單查詢與分組
  - `:370-386` `setData`
  - `:604` 附近新增「本趟訂單」區塊
  - `:690` 附近新增 `detailSheet === 'orders'` 的 sheet
  - 檔尾新增 `OrderScopeRow` 元件

**Interfaces:**
- Consumes: `splitOrdersByTrip(orders, trip)`（Task 2）
- Produces: `data.candidateOrders`、`data.excludedOrders`、`data.tripScopeReady`、`data.tripNameById`；
  `setOrderScope(orderId, include)` 供 sheet 呼叫

- [ ] **Step 1: 加 import**

修改 `src/pages/TripsPage.jsx` 開頭的 import 區塊：

```js
import {
  taipeiDayStart, taipeiDayEnd, summarizeOrders, computeTripFinance, buildCostSnapshotMap,
} from '../lib/orderFinance'
import { splitOrdersByTrip } from '../lib/tripScope'
```

- [ ] **Step 2: 訂單查詢改成「區間內全部 ∪ 釘在本趟」**

`fetchReportData` 的 `Promise.all` 目前有 11 個查詢（`:223-245`）。
**那 11 個一行都不要動**，只做兩件事：

1. 解構陣列的尾端（`members,` 之後）加兩個元素
2. `Promise.all([...])` 陣列的尾端（`fetchStoreMembers(storeId),` 之後）加兩個查詢

改完的解構長這樣：

```js
    const [
      { data: orders }, { data: products }, { data: variants }, { data: spProducts },
      { data: rates }, { data: allOrders }, { data: images }, { data: procurementBatches },
      { data: settlement }, { data: participants }, members,
      { data: pinnedOrders, error: pinnedErr }, { data: allTrips },
    ] = await Promise.all([
```

追加到陣列尾端的兩個查詢：

```js
      // 釘在本趟、但可能落在區間外的訂單。
      // 分兩支查詢而不是用 .or()：時間字串含 + 與 :，塞進 PostgREST 的 or 運算式
      // 要額外跳脫，分開查比較不會出事，反正本來就在 Promise.all 裡平行跑。
      supabase.from('consumer_orders').select('*')
        .eq('store_id', storeId)
        .eq('trip_id', trip.id)
        .neq('status', '已取消'),
      // 顯示「已歸 ⟨destination⟩」用的行程名對照
      supabase.from('trips').select('id, destination').eq('store_id', storeId),
    ])
```

- [ ] **Step 3: 合併去重，換成 `splitOrdersByTrip` 分組**

把 `:253` 原本這一行：

```js
const tripOrders = orders || []
```

換成：

```js
// trip_id 欄位還沒套 migration 時這支查詢會 400。此時安靜退回純區間模式，
// 報表照常出得來，只是不能編輯訂單範圍（跟成本快照的降級策略一致）。
const tripScopeReady = !pinnedErr

const byId = new Map()
;[...(orders || []), ...(pinnedOrders || [])].forEach(o => byId.set(o.id, o))
const candidateOrders = [...byId.values()]
  .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))

// 一次判定、兩邊共用：財務只吃 included，勾選清單兩組都要畫
const { included: tripOrders, excluded: excludedOrders } = splitOrdersByTrip(candidateOrders, trip)
// 勾選清單一列一列查歸屬，用 Set 才不會變成 O(n²)
const excludedOrderIds = new Set(excludedOrders.map(o => o.id))

const tripNameById = {}
;(allTrips || []).forEach(t => { tripNameById[t.id] = t.destination })
```

下游全部沿用 `tripOrders`，一行都不用改 —— 成本快照查詢、`summarizeOrders`、客戶聚合都是吃它。

- [ ] **Step 4: 把新資料放進 `setData`**

在 `setData({ ... })` 裡追加四個欄位：

```js
      candidateOrders,
      excludedOrders,
      excludedOrderIds,
      tripScopeReady,
      tripNameById,
```

- [ ] **Step 5: 寫勾選的寫入函式**

在 `TripReport` 內、`saveCost` 函式後面加：

```js
  // 已結算的行程不能改範圍：settle_trip 存的是當下算好的快照，
  // 改了訂單會讓報表跟結算對不起來。要改先作廢結算。
  const scopeLocked = !!data?.settlement

  async function setOrderScope(orderId, include) {
    if (scopeLocked) return
    // 勾回一律釘上 trip_id 而不是還原成 null：使用者親手勾回來的單就該固定住，
    // 之後改行程日期也不會又掉出去。
    const patch = include
      ? { trip_id: trip.id, trip_excluded: false }
      : { trip_id: null, trip_excluded: true }
    const { error } = await supabase.from('consumer_orders').update(patch).eq('id', orderId)
    if (error) {
      alert('更新失敗：' + error.message)
      return
    }
    fetchReportData()
  }
```

- [ ] **Step 6: 加「本趟訂單」區塊**

在「Section 3: Customer Insights」那段（`:604`）**之前**插入：

```jsx
          {/* ── Section 2.5: 本趟訂單範圍 ── */}
          <div className="sec row-sb">
            <span>本趟訂單</span>
            <button className="link-btn" onClick={() => setDetailSheet('orders')}>
              納入 {data.orderCount} 張
              {data.excludedOrders.length > 0 && ` / 排除 ${data.excludedOrders.length} 張`} →
            </button>
          </div>
```

- [ ] **Step 7: 加訂單勾選 Sheet**

在 `detailSheet === 'customers'` 那個 sheet（`:690` 結尾）**之後**插入：

```jsx
      {detailSheet === 'orders' && (
        <div className="sheet-overlay" onClick={e => e.target === e.currentTarget && setDetailSheet(null)}>
          <div className="sheet" style={{ maxHeight: '85dvh' }}>
            <div className="sheet-handle" />
            <div className="row-sb" style={{ marginBottom: 8 }}>
              <div className="sheet-title" style={{ margin: 0 }}>
                本趟訂單（納入 {data.orderCount} / 排除 {data.excludedOrders.length}）
              </div>
              <button onClick={() => setDetailSheet(null)} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-3)' }}>×</button>
            </div>

            {!data.tripScopeReady && (
              <div className="notice notice-warn">
                資料庫還沒套 20260808120000，訂單範圍暫時只能靠日期區間，無法手動勾選。
              </div>
            )}
            {scopeLocked && (
              <div className="notice notice-warn">
                本趟已完成拆賬，訂單範圍鎖定。要調整請先作廢拆賬結果。
              </div>
            )}
            {data.tripScopeReady && !scopeLocked && (
              <div className="muted fs13" style={{ marginBottom: 8 }}>
                取消勾選＝這張是常規訂單，不屬於任何行程。若它其實屬於別趟，到那趟的清單勾回來即可。
              </div>
            )}

            <div style={{ overflowY: 'auto', flex: 1 }}>
              {data.candidateOrders.length === 0 ? (
                <div className="muted fs13">此區間無訂單</div>
              ) : (
                data.candidateOrders.map(o => (
                  <OrderScopeRow
                    key={o.id}
                    order={o}
                    included={!data.excludedOrderIds.has(o.id)}
                    otherTripName={
                      o.trip_id != null && String(o.trip_id) !== String(trip.id)
                        ? (data.tripNameById[o.trip_id] || '其他行程')
                        : null
                    }
                    disabled={!data.tripScopeReady || scopeLocked}
                    onToggle={setOrderScope}
                  />
                ))
              )}
            </div>
          </div>
        </div>
      )}
```

- [ ] **Step 8: 加 `OrderScopeRow` 元件**

在檔案裡 `CustomerRow`（`:1354`）**之前**插入：

```jsx
// ─── 訂單範圍勾選列 ──────────────────────────────────────────────
function OrderScopeRow({ order, included, otherTripName, disabled, onToggle }) {
  const at = order.created_at ? new Date(order.created_at) : null
  const stamp = at
    ? `${at.getMonth() + 1}/${at.getDate()} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
    : ''
  // 釘在別趟的單只能到那趟操作，這裡不給改，免得兩邊互搶
  const lockedByOther = !!otherTripName

  return (
    <div className="lrow row-sb" style={{ opacity: included ? 1 : 0.5 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, cursor: disabled || lockedByOther ? 'default' : 'pointer' }}>
        <input
          type="checkbox"
          checked={included}
          disabled={disabled || lockedByOther}
          onChange={e => onToggle(order.id, e.target.checked)}
          style={{ flexShrink: 0 }}
        />
        <div style={{ minWidth: 0 }}>
          <div className="fs13" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {order.customer_name || order.email || '（無名）'}
          </div>
          <div className="muted num" style={{ fontSize: 11 }}>
            {stamp}
            {lockedByOther && <span style={{ marginLeft: 6 }}>已歸 {otherTripName}</span>}
          </div>
        </div>
      </label>
      <span className="fw600 fs13 num" style={{ flexShrink: 0 }}>
        ${Number(order.total_amount || 0).toLocaleString()}
      </span>
    </div>
  )
}
```

- [ ] **Step 9: 手動驗證**

啟動後台 dev server（若尚未啟動）：`npm run dev`。
用本機帳號 `owner@daigogo.dev` / `localdev123` 登入，進「行程」→ 挑一個有訂單的行程開報表。

逐項確認：

1. 「本趟訂單」區塊出現，數字等於報表上方的訂單數
2. 點開 sheet，列出區間內全部訂單，全部預設打勾
3. 取消勾一張 → sheet 那列變半透明、報表營收與毛利同步下降
4. 重新整理頁面 → 該張仍維持未勾（有寫進 DB）
5. 勾回來 → 數字復原
6. 建一個與此行程日期重疊的第二趟行程 → 同一張單在兩邊都看得到；
   在第二趟把它勾回（釘住）→ 第一趟該列變成「已歸 ⟨第二趟名稱⟩」且不可勾

- [ ] **Step 10: 跑全部測試**

Run: `npx vitest run`
Expected: 全綠。

- [ ] **Step 11: Commit**

```bash
git add src/pages/TripsPage.jsx
git commit -m "feat: 行程報表可手動勾選涵蓋哪些訂單"
```

---

### Task 5: 客戶列表排序 ＋ 客戶詳情 Sheet

**Files:**
- Modify: `src/pages/TripsPage.jsx`
  - import 區塊
  - `:196` 附近 state
  - `:340-361` 客戶聚合改用 `buildCustomerSummaries`
  - `:604-621` Top 客戶區塊
  - `:673-690` 全部客戶 sheet
  - `CustomerRow`（`:1354`）
  - 檔尾新增 `CustomerDetailSheet` 元件

**Interfaces:**
- Consumes: `buildCustomerSummaries(orders, ctx)`、`sortCustomers(customers, sortBy)`（Task 3）
- Produces: `data.customers` 改為 `CustomerSummary[]`（欄位見 Task 3）

> Task 4 已經在這支檔案插入過程式碼，**下面的行號都會往後漂**。
> 定位請認註解標記（`{/* ── Section 3: Customer Insights ── */}`、`function CustomerRow`）
> 而不是行號。

- [ ] **Step 1: 加 import**

```js
import { buildCustomerSummaries, sortCustomers } from '../lib/tripCustomers'
```

- [ ] **Step 2: 客戶聚合改用新模組**

把 `fetchReportData` 裡 `// Customer insights` 那整段（`:340-361`，從 `const customerMap = {}` 到
`c.isNew = true` 那個 `forEach` 結束）換成：

```js
    // Customer insights：財務走 computeOrderFinance，這裡只換聚合鍵
    const customers = buildCustomerSummaries(tripOrders, {
      productMap, variantMap, rateMap, costSnapshots, historicalEmails,
    })
    const newCount = customers.filter(c => c.isNew).length
    const returnCount = customers.length - newCount
```

`historicalEmails`（`:254`）與 `customerPaidTotal` / `avgOrderValue`（`:363-365`）原封不動。

- [ ] **Step 3: 加排序與詳情的 state**

在 `TripReport` 的 state 區（`:196` 附近）加：

```js
  const [customerSort, setCustomerSort] = useState('amount') // 'amount' | 'profit' | 'recent'
  const [selectedCustomer, setSelectedCustomer] = useState(null)
```

- [ ] **Step 4: 換掉 Top 客戶區塊**

把 `:604-621` 那段換成：

```jsx
          {/* ── Section 3: Customer Insights ── */}
          {data.customers.length > 0 && (
            <>
              <div className="sec row-sb">
                <span>Top 客戶</span>
                {data.customers.length > 5 && (
                  <button className="link-btn" onClick={() => setDetailSheet('customers')}>
                    全部 {data.customers.length} 位 →
                  </button>
                )}
              </div>
              <CustomerSortTabs value={customerSort} onChange={setCustomerSort} />
              <div>
                {sortCustomers(data.customers, customerSort).slice(0, 5).map((c, i) => (
                  <CustomerRow key={c.key} c={c} i={i} onSelect={setSelectedCustomer} />
                ))}
              </div>
            </>
          )}
```

- [ ] **Step 5: 全部客戶 sheet 也套排序與點擊**

把 `:681-687` 的內層換成：

```jsx
            <CustomerSortTabs value={customerSort} onChange={setCustomerSort} />
            <div style={{ overflowY: 'auto', flex: 1 }}>
              <div>
                {sortCustomers(data.customers, customerSort).map((c, i) => (
                  <CustomerRow key={c.key} c={c} i={i} onSelect={setSelectedCustomer} />
                ))}
              </div>
            </div>
```

- [ ] **Step 6: 掛上客戶詳情 sheet**

在 `selectedProduct` 的 sheet（`:693`）**之前**插入：

```jsx
      {selectedCustomer && (
        <CustomerDetailSheet c={selectedCustomer} onClose={() => setSelectedCustomer(null)} />
      )}
```

- [ ] **Step 7: 改寫 `CustomerRow`，新增 `CustomerSortTabs` 與 `CustomerDetailSheet`**

把 `:1354-1370` 的 `CustomerRow` 整個換成下面三個元件：

```jsx
// ─── 客戶排序切換 ────────────────────────────────────────────────
const CUSTOMER_SORTS = [
  { key: 'amount', label: '金額' },
  { key: 'profit', label: '利潤' },
  { key: 'recent', label: '最近下單' },
]

function CustomerSortTabs({ value, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
      {CUSTOMER_SORTS.map(s => (
        <button
          key={s.key}
          className="chip-btn"
          onClick={() => onChange(s.key)}
          style={{
            fontSize: 12,
            background: value === s.key ? 'var(--text)' : 'var(--card)',
            color: value === s.key ? 'var(--bg)' : 'var(--text-3)',
          }}
        >{s.label}</button>
      ))}
    </div>
  )
}

// ─── 客戶列 ──────────────────────────────────────────────────────
function formatMonthDay(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function CustomerRow({ c, i, onSelect }) {
  return (
    <div
      className="lrow row-sb"
      onClick={() => onSelect?.(c)}
      style={{ cursor: onSelect ? 'pointer' : 'default' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span className="lrow-rank fs13" style={{ minWidth: 16, margin: 0 }}>{i + 1}</span>
        <span className="fs13" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {c.name}
        </span>
        {c.isNew && <span className="badge badge-blue" style={{ flexShrink: 0 }}>新客</span>}
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div>
          <span className="fw600 fs13 num">${c.paidTotal.toLocaleString()}</span>
          <span className="muted num" style={{ fontSize: 11, marginLeft: 6 }}>{c.orderCount} 單</span>
        </div>
        <div className="muted num" style={{ fontSize: 11 }}>
          利潤 ${Math.round(c.profit).toLocaleString()} · {formatMonthDay(c.lastOrderAt)}
        </div>
      </div>
    </div>
  )
}

// ─── 客戶詳情 ────────────────────────────────────────────────────
function CustomerDetailSheet({ c, onClose }) {
  return (
    <div className="sheet-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="sheet" style={{ maxHeight: '85dvh' }}>
        <div className="sheet-handle" />
        <div className="row-sb" style={{ marginBottom: 16 }}>
          <div className="sheet-title" style={{ margin: 0 }}>{c.name}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-3)' }}>×</button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1 }}>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-row row-sb">
              <span className="fs13">實付</span>
              <span className="fs13 num">${c.paidTotal.toLocaleString()}</span>
            </div>
            <div className="card-row row-sb">
              <span className="fs13">利潤</span>
              <span className="fw600 fs15 num">${Math.round(c.profit).toLocaleString()}</span>
            </div>
            <div className="card-row row-sb">
              <span className="fs13">訂單數</span>
              <span className="fs13 num">{c.orderCount}</span>
            </div>
          </div>

          {c.unknownShippingCount > 0 && (
            <div className="notice notice-warn">
              {c.unknownShippingCount} 張訂單沒有物流成本資料，運費損益以 0 計算，這裡的利潤偏高。
            </div>
          )}

          <div className="sec">買了什麼</div>
          <div className="card" style={{ marginBottom: 16 }}>
            {c.products.map(p => (
              <div key={p.key} className="card-row row-sb">
                <span className="fs13" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.name}{p.variantLabel && ` · ${p.variantLabel}`}
                  <span className="muted num" style={{ marginLeft: 6 }}>×{p.qty}</span>
                </span>
                <span className="fs13 num" style={{ flexShrink: 0 }}>
                  ${Math.round(p.netRevenue).toLocaleString()}
                  <span className="muted" style={{ marginLeft: 6 }}>毛利 ${Math.round(p.grossProfit).toLocaleString()}</span>
                </span>
              </div>
            ))}
          </div>

          <div className="sec">訂單紀錄</div>
          <div className="card" style={{ marginBottom: 24 }}>
            {c.orders.map(o => (
              <div key={o.id} className="card-row">
                <div className="row-sb">
                  <span className="fs13 num">
                    {o.createdAt ? new Date(o.createdAt).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}
                  </span>
                  <span className="fs13 num">
                    ${Number(o.paidTotal).toLocaleString()}
                    <span className="muted" style={{ marginLeft: 6 }}>利潤 ${Math.round(o.profit).toLocaleString()}</span>
                  </span>
                </div>
                <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                  {o.lines.map(l => `${l.name}${l.variantLabel ? ` · ${l.variantLabel}` : ''} ×${l.qty}`).join('、')}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 8: 手動驗證**

在後台行程報表：

1. Top 客戶上方出現「金額 / 利潤 / 最近下單」三個切換，點下去順序會變
2. 每一列右下多了「利潤 $X · M/D」
3. 點任一客戶 → 開出詳情，三個數字、買了什麼、訂單紀錄都在
4. 找一張 `shipping_cost` 為 null 的訂單所屬客戶 → 詳情裡出現運費成本未知的警語
5. 「全部客戶」sheet 裡的排序切換與點擊行為一致

- [ ] **Step 9: 跑全部測試**

Run: `npx vitest run`
Expected: 全綠。

- [ ] **Step 10: Commit**

```bash
git add src/pages/TripsPage.jsx
git commit -m "feat: 行程客戶清單加排序與詳情，顯示利潤與購買明細"
```

---

## 收尾（需要使用者授權才做）

1. **套 migration 到 remote**：用 MCP `apply_migration`，名稱 `consumer_orders_trip_scope`，
   內容同 Task 1 的 SQL。**不可以跑 `supabase db push`**。
2. **push**：確認使用者同意後才 `git push`。
3. **更新文件**：`docs/architecture.md` 的行程／財務段落補一句「行程訂單範圍由
   `consumer_orders.trip_id` / `trip_excluded` 決定，判定在 `src/lib/tripScope.js`」；
   `docs/TODO.md` 把「行程訂單範圍可編輯＋客戶維度改造」那一項刪掉（做完就刪，不留 ✅）。
