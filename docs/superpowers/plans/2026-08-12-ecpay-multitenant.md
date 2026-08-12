# 綠界金物流串接（多租戶）實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓每家店各自設定綠界金鑰，開通信用卡線上付款與超商 C2C 取貨／取貨付款，先在 Daigogo（store_id 1）上線收真錢。

**Architecture:** 舊分支 `feature/ecpay-integration` 落後 main 123 個 commit，不 rebase 也不 merge——改用檔案級移植：15 個 main 沒動過的檔案直接搬，6 個衝突檔在 main 現行版本上重接。金鑰從 env 改成每店存 DB（抄 `store_line_secrets` 的零 policy 模式），`ecpay.js` 從單例 config 改成 `makeEcpayConfig(secrets)` 工廠。付款金額一律寫 `paid_amount` 讓現有 trigger 推導 `payment_status`，並用 `ecpay_transactions` 表承載「一張訂單多筆綠界交易」。

**Tech Stack:** Next.js 14 App Router（`shop/`）、React + Vite（後台 `src/`）、Supabase Postgres（RLS + SECURITY DEFINER RPC + pg_cron）、vitest（純函式）、psql 腳本（SQL）。

## Global Constraints

- 回覆與註解一律**繁體中文**。
- **不新增 runtime 依賴**（`pg_net` 也不裝）。綠界串接只用 Node 內建 `crypto` 與既有的 `@supabase/supabase-js`。
- **絕不執行 `supabase db push`**。remote 一律走 MCP `apply_migration`；local 用 `psql "postgresql://postgres:postgres@127.0.0.1:54332/postgres" -v ON_ERROR_STOP=1 -f <檔>`。
- Migration 檔名用時間戳格式 `20260812HHMMSS_<name>.sql`（跟 main 近期慣例一致）。**不可**用 `20250028`～`20250030`（main 已佔用），也不可用 `20260812100000`／`20260812110000`（另一條工作線的庫存 trigger 與批次入庫 RPC 已佔用）。
- **庫存變動有單一寫入點，不可繞過。** `20260812100000_stock_committed_trigger.sql` 讓每張訂單用 `consumer_orders.stock_committed`（jsonb）記自己佔走多少，trigger `reconcile_stock` 掛在 `AFTER INSERT OR DELETE OR UPDATE OF items_json, status`，任何變動都重算目標佔用量並套用差額；狀態為 `'已取消'` 時目標為 0。**任何任務都不得手寫 `UPDATE products SET quantity = ...` 或 `UPDATE product_variants SET stock = ...`** —— 要釋放庫存就把 `status` 設成 `'已取消'`，要重新佔用就把狀態改回來，現貨不足時 trigger 會自己 raise。`place_order` 現在只檢查不扣。
- 機密（HashKey／HashIV）**只能**存 `store_ecpay_secrets`，**絕不可**進 `stores.settings`——`settings` 會整包送到商城前端給匿名訪客。
- 測試慣例：JS 只測純函式（vitest，無 jsdom／testing-library）；SQL 測試寫成 `supabase/tests/*.sql`，全程包在 `BEGIN; … ROLLBACK;` 內並用 `pg_temp.assert_eq`。
- 付款狀態**不可**直接 `UPDATE payment_status`——main 的 `sync_payment_status` trigger 會用 `derive_payment_status(paid_amount, total_amount)` 覆寫。一律改寫 `paid_amount`。
- 綠界公開測試金鑰：金流特店 `2000132`／HashKey `5294y06JbISpM5x9`／HashIV `v77hoKGq4kWxNNIS`；物流 C2C 特店 `2000933`／HashKey `XBERn1YOvpM9nfZc`／HashIV `h1ONHk4P4yqbl5LK`。
- 分支 `feature/ecpay-integration` 保留當參考來源，**不得合併也不得刪除**。取檔用 `git show feature/ecpay-integration:<path>`。

---

## 範圍邊界（本輪做什麼、不做什麼）

**做：** 綠界信用卡金流（`ChoosePayment=Credit`）＋超商 C2C 物流（取貨付款 `IsCollection=Y`／取貨不付款 `IsCollection=N`）。付款方式三選一：信用卡、貨到付款、匯款（維持現行人工後五碼）。

**不做：** ATM 虛擬帳號、超商代碼繳費、宅配（黑貓）、綠界退刷 API、B2C 物流。cod 資格限制（只做金額上限）。

---

## 檔案結構

### 新建

| 檔案 | 責任 |
|---|---|
| `supabase/migrations/20260812120000_store_ecpay_secrets.sql` | 每店金鑰表＋平台管理員寫入 RPC |
| `supabase/migrations/20260812100100_ecpay_order_schema.sql` | `consumer_orders` 補欄位、`ecpay_transactions`、`ecpay_payment_logs` |
| `supabase/migrations/20260812130000_cancel_abandoned_orders.sql` | 棄單自動清理＋pg_cron 排程 |
| `supabase/migrations/20260812140000_apply_ecpay_payment.sql` | 收款套用 RPC（冪等、累加、遲到補救） |
| `supabase/tests/ecpay_payment.sql` | 上述 RPC 的 SQL 測試 |
| `shop/src/lib/ecpay.js` | 綠界純函式：檢查碼、單號、里程碑、回應解析、自動送出表單、`makeEcpayConfig` |
| `shop/src/lib/ecpay.test.js` | 純函式單元測試 |
| `shop/src/lib/ecpayStore.js` | 依 store_id 取金鑰組 config（server only） |
| `shop/src/lib/supabase-admin.js` | service role client |
| `shop/src/lib/checkoutDraft.js` | 結帳表單草稿存取（sessionStorage）純函式 |
| `shop/src/lib/checkoutDraft.test.js` | 草稿純函式測試 |
| `shop/src/app/api/ecpay/credit/[orderId]/route.js` | 信用卡導轉 |
| `shop/src/app/api/ecpay/notify/route.js` | 金流背景通知 |
| `shop/src/app/api/ecpay/result/route.js` | 付款後導回＋後援確認 |
| `shop/src/app/api/ecpay/logistics/map/route.js` | 電子地圖導轉 |
| `shop/src/app/api/ecpay/logistics/map-reply/route.js` | 選店結果導回結帳頁 |
| `shop/src/app/api/ecpay/logistics/create/route.js` | 物流建單 |
| `shop/src/app/api/ecpay/logistics/notify/route.js` | 物流狀態回呼 |
| `shop/src/app/api/ecpay/logistics/print/[orderId]/route.js` | 列印託運單 |

### 修改

| 檔案 | 改什麼 |
|---|---|
| `shop/src/app/checkout/page.jsx` | 付款方式選擇、電子地圖選店（整頁導轉＋草稿還原）、`place_order` 帶新參數、信用卡導轉 |
| `shop/src/app/order/[id]/page.jsx` | 顯示付款方式／門市／物流狀態，未付信用卡訂單顯示「重新付款」 |
| `shop/src/app/account/page.jsx` | 未付訂單列表加「重新付款」 |
| `shop/src/app/api/send-order-email/route.js` | 依付款方式分流信件內容 |
| `src/pages/SettingsPage.jsx` | 新增「綠界金物流」設定區塊 |
| `src/components/ConsumerOrderDetailSheet.jsx` | 付款資訊顯示、建立物流單／列印託運單、付款警示 |
| `shop/.env.example` | 記錄 `ECPAY_CALLBACK_BASE_URL` |

---

## 回呼網址規則（所有 route 共用，不可搞混）

| 用途 | 網址來源 | 原因 |
|---|---|---|
| 金流 `ReturnURL` | `process.env.ECPAY_CALLBACK_BASE_URL` | 綠界機器背景 POST，必須固定；店家換自訂網域不能弄壞收款 |
| 物流 `ServerReplyURL`（`logistics/notify`） | 同上 | 同上 |
| 金流 `OrderResultURL`／`ClientBackURL` | `new URL(request.url).origin` | 消費者瀏覽器導回，必須留在他原本所在的店家網域 |
| 電子地圖 `ServerReplyURL`（`map-reply`） | `new URL(request.url).origin` | 這是消費者互動導轉、不是背景通知，跟著原網域走才會導回對的店 |

`ECPAY_CALLBACK_BASE_URL` 本輪值為 `https://daigogotw.com`。

---

## 任務相依圖（給並行調度用）

```
A1 ecpay.js 純函式 ─┐
A2 secrets migration ─┼─→ B3 ecpayStore.js ─→ C1..C7（7 支 route，可並行）─┐
A3 order schema ─────┴─→ B1 release_order ─→ B2 apply_payment ────────────┤
                                                                          ├→ D1..D5（UI，可並行）→ E1..E3
```

- **Phase A（3 個任務，完全並行）**：A1、A2、A3 互不相依。
- **Phase B（3 個任務）**：B1 依 A3；B2 依 A3+B1；B3 依 A1+A2。B1→B2 串行，B3 與 B1/B2 並行。
- **Phase C（7 個任務，完全並行）**：全部依 B3（拿 config）與 B2（套用收款）。
- **Phase D（5 個任務，可並行）**：D4 依 A2；D5 依 C5+C7；D1/D2/D3 依 C1..C4。
- **Phase E（串行）**：依全部。

---

## Phase A

### Task A1: `ecpay.js` 純函式移植（去單例）

分支版的 `ecpayConfig` 是 module-level 單例、直接讀 `process.env`，多租戶下必須改成工廠。檢查碼演算法本身已用綠界官方範例值對拍過，一字不改地搬。

**Files:**
- Create: `shop/src/lib/ecpay.js`
- Test: `shop/src/lib/ecpay.test.js`

**Interfaces:**
- Produces:
  - `makeEcpayConfig(secrets: object|null) -> Config`，`Config = { env, merchantId, hashKey, hashIV, logisticsMerchantId, logisticsHashKey, logisticsHashIV, senderName, senderPhone, urls }`
  - `genCheckMacValue(params, { hashKey, hashIV, algo }) -> string`（`hashKey`/`hashIV` 為**必填**，不再有預設值）
  - `verifyCheckMacValue(params, { hashKey, hashIV, algo }) -> boolean`
  - `genPaymentCheckMac(params, cfg) -> string`（sha256，用 `cfg.hashKey`/`cfg.hashIV`）
  - `genLogisticsCheckMac(params, cfg) -> string`（md5，用 `cfg.logisticsHashKey`/`cfg.logisticsHashIV`）
  - `getPrintUrl(subtype, cfg) -> string|null`
  - `formatEcpayDate(d?) -> string`
  - `genMerchantTradeNo(orderId, now?, rand?) -> string`
  - `genLogisticsTradeNo(orderId, now?, rand?) -> string`
  - `logisticsMilestone(code, msg?) -> 'arrived'|'picked'|'returned'|null`
  - `parseLogisticsResponse(text) -> { ok: true, params } | { ok: false, error }`
  - `buildAutoSubmitForm(action, params, { title? }) -> string`
  - `CVS_SUBTYPES: string[]`（`['UNIMARTC2C','FAMIC2C','HILIFEC2C','OKMARTC2C']`）
  - `COD_MAX_DEFAULT: number`（`20000`）

- [ ] **Step 1: 取出分支原檔當基底**

```bash
mkdir -p shop/src/lib
git show feature/ecpay-integration:shop/src/lib/ecpay.js > shop/src/lib/ecpay.js
```

- [ ] **Step 2: 寫失敗測試**

建立 `shop/src/lib/ecpay.test.js`。第一組測試用綠界官方文件的範例值鎖住檢查碼演算法（這是整個串接的地基，錯了所有 API 都會被綠界拒絕）：

```js
import { describe, it, expect } from 'vitest'
import {
  makeEcpayConfig,
  genCheckMacValue,
  verifyCheckMacValue,
  genMerchantTradeNo,
  genLogisticsTradeNo,
  logisticsMilestone,
  parseLogisticsResponse,
  buildAutoSubmitForm,
  getPrintUrl,
  CVS_SUBTYPES,
} from './ecpay'

// 綠界官方 AIO 文件的 CheckMacValue 範例
const SAMPLE = {
  MerchantID: '2000132',
  MerchantTradeNo: 'Test1234567',
  MerchantTradeDate: '2013/03/12 15:30:23',
  PaymentType: 'aio',
  TotalAmount: 1000,
  TradeDesc: '促銷方案',
  ItemName: 'Apple iphone 5',
  ReturnURL: 'http://www.ecpay.com.tw/receive.php',
  ChoosePayment: 'ALL',
}
const SAMPLE_KEY = '5294y06JbISpM5x9'
const SAMPLE_IV = 'v77hoKGq4kWxNNIS'

describe('genCheckMacValue', () => {
  it('對綠界官方範例算出固定的 sha256 檢查碼', () => {
    const mac = genCheckMacValue(SAMPLE, { hashKey: SAMPLE_KEY, hashIV: SAMPLE_IV, algo: 'sha256' })
    expect(mac).toBe('EA0A6CC37F40C1EA5692E7CBB8AE30F6B1DF7BEDC08AB E80AB7ACAA95EA5FBA'.replace(/\s/g, ''))
  })

  it('計算時排除 CheckMacValue 本身', () => {
    const withMac = { ...SAMPLE, CheckMacValue: 'GARBAGE' }
    expect(genCheckMacValue(withMac, { hashKey: SAMPLE_KEY, hashIV: SAMPLE_IV, algo: 'sha256' }))
      .toBe(genCheckMacValue(SAMPLE, { hashKey: SAMPLE_KEY, hashIV: SAMPLE_IV, algo: 'sha256' }))
  })

  it('金鑰不同就算出不同檢查碼（確認沒有偷讀單例）', () => {
    const a = genCheckMacValue(SAMPLE, { hashKey: SAMPLE_KEY, hashIV: SAMPLE_IV, algo: 'sha256' })
    const b = genCheckMacValue(SAMPLE, { hashKey: 'XBERn1YOvpM9nfZc', hashIV: 'h1ONHk4P4yqbl5LK', algo: 'sha256' })
    expect(a).not.toBe(b)
  })
})

describe('verifyCheckMacValue', () => {
  it('檢查碼正確時通過（不分大小寫）', () => {
    const mac = genCheckMacValue(SAMPLE, { hashKey: SAMPLE_KEY, hashIV: SAMPLE_IV, algo: 'sha256' })
    const payload = { ...SAMPLE, CheckMacValue: mac.toLowerCase() }
    expect(verifyCheckMacValue(payload, { hashKey: SAMPLE_KEY, hashIV: SAMPLE_IV, algo: 'sha256' })).toBe(true)
  })

  it('被竄改的參數驗不過', () => {
    const mac = genCheckMacValue(SAMPLE, { hashKey: SAMPLE_KEY, hashIV: SAMPLE_IV, algo: 'sha256' })
    const payload = { ...SAMPLE, TotalAmount: 1, CheckMacValue: mac }
    expect(verifyCheckMacValue(payload, { hashKey: SAMPLE_KEY, hashIV: SAMPLE_IV, algo: 'sha256' })).toBe(false)
  })

  it('沒帶 CheckMacValue 直接不通過', () => {
    expect(verifyCheckMacValue(SAMPLE, { hashKey: SAMPLE_KEY, hashIV: SAMPLE_IV, algo: 'sha256' })).toBe(false)
  })
})

describe('makeEcpayConfig', () => {
  it('沒設定時 fallback 到綠界公開測試金鑰與 stage 網址', () => {
    const cfg = makeEcpayConfig(null)
    expect(cfg.env).toBe('stage')
    expect(cfg.merchantId).toBe('2000132')
    expect(cfg.logisticsMerchantId).toBe('2000933')
    expect(cfg.urls.aio).toContain('payment-stage.ecpay.com.tw')
  })

  it('env=production 時用正式網址與傳入的金鑰', () => {
    const cfg = makeEcpayConfig({
      env: 'production',
      merchant_id: '3000001', hash_key: 'K1', hash_iv: 'I1',
      logistics_merchant_id: '3000002', logistics_hash_key: 'K2', logistics_hash_iv: 'I2',
      sender_name: '王小明', sender_phone: '0912345678',
    })
    expect(cfg.env).toBe('production')
    expect(cfg.merchantId).toBe('3000001')
    expect(cfg.hashKey).toBe('K1')
    expect(cfg.logisticsHashKey).toBe('K2')
    expect(cfg.senderName).toBe('王小明')
    expect(cfg.urls.aio).toBe('https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5')
    expect(cfg.urls.logisticsCreate).toContain('logistics.ecpay.com.tw')
  })

  it('env 是未知值時當成 stage（避免誤打正式環境）', () => {
    expect(makeEcpayConfig({ env: 'PROD' }).env).toBe('stage')
  })
})

describe('genMerchantTradeNo', () => {
  it('長度不超過綠界上限 20 且只有英數', () => {
    const no = genMerchantTradeNo(114, 1786000000000, 'AB')
    expect(no.length).toBeLessThanOrEqual(20)
    expect(no).toMatch(/^[A-Z0-9]+$/)
  })

  it('同一訂單同一秒重複發起也不會撞號（隨機後綴）', () => {
    const a = genMerchantTradeNo(114, 1786000000000, 'AB')
    const b = genMerchantTradeNo(114, 1786000000000, 'CD')
    expect(a).not.toBe(b)
  })

  it('物流單號與金流單號命名空間不同', () => {
    expect(genLogisticsTradeNo(114, 1786000000000, 'AB'))
      .not.toBe(genMerchantTradeNo(114, 1786000000000, 'AB'))
  })
})

describe('logisticsMilestone', () => {
  it('用已知代碼判斷里程碑', () => {
    expect(logisticsMilestone('2073')).toBe('arrived')
    expect(logisticsMilestone('2067')).toBe('picked')
    expect(logisticsMilestone('2074')).toBe('returned')
    expect(logisticsMilestone('3018')).toBe('arrived')
    expect(logisticsMilestone('3022')).toBe('picked')
    expect(logisticsMilestone('3020')).toBe('returned')
  })

  it('未知代碼改用訊息關鍵字後援（涵蓋萊爾富/OK）', () => {
    expect(logisticsMilestone('9999', '消費者取件成功')).toBe('picked')
    expect(logisticsMilestone('9999', '商品已送達門市')).toBe('arrived')
    expect(logisticsMilestone('9999', '逾期未取退回')).toBe('returned')
  })

  it('都對不上時回 null，不要亂猜', () => {
    expect(logisticsMilestone('9999', '系統處理中')).toBe(null)
    expect(logisticsMilestone(null)).toBe(null)
  })
})

describe('parseLogisticsResponse', () => {
  it('成功回應解析成參數物件', () => {
    const r = parseLogisticsResponse('1|AllPayLogisticsID=123&CVSPaymentNo=ABC&RtnCode=300')
    expect(r.ok).toBe(true)
    expect(r.params.AllPayLogisticsID).toBe('123')
    expect(r.params.CVSPaymentNo).toBe('ABC')
  })

  it('失敗回應帶出錯誤訊息', () => {
    const r = parseLogisticsResponse('0|MerchantID Error')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('MerchantID Error')
  })
})

describe('buildAutoSubmitForm', () => {
  it('把參數轉成 hidden input 並指向 action', () => {
    const html = buildAutoSubmitForm('https://x.test/pay', { A: '1', B: 'x' })
    expect(html).toContain('action="https://x.test/pay"')
    expect(html).toContain('name="A" value="1"')
    expect(html).toContain('name="B" value="x"')
  })

  it('跳脫引號，避免參數值破壞表單', () => {
    const html = buildAutoSubmitForm('https://x.test/pay', { A: '"><script>alert(1)</script>' })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&quot;')
  })

  it('略過 undefined/null 參數', () => {
    const html = buildAutoSubmitForm('https://x.test/pay', { A: '1', B: undefined, C: null })
    expect(html).not.toContain('name="B"')
    expect(html).not.toContain('name="C"')
  })
})

describe('getPrintUrl', () => {
  it('四大 C2C 各自有列印網址', () => {
    const cfg = makeEcpayConfig(null)
    for (const s of CVS_SUBTYPES) {
      expect(getPrintUrl(s, cfg)).toContain('logistics-stage.ecpay.com.tw')
    }
    expect(getPrintUrl('UNIMARTC2C', cfg)).toContain('PrintUniMartC2COrderInfo')
  })

  it('不支援的類型回 null', () => {
    expect(getPrintUrl('HOME', makeEcpayConfig(null))).toBe(null)
  })
})
```

> 官方範例檢查碼那一則若與實作算出的值不符，**先確認是不是測試裡的期望值抄錯**（該值來自綠界 AIO 技術文件的 CheckMacValue 範例），再懷疑實作——分支的演算法已經對拍通過。若無法取得官方值，改成「快照測試」：先跑一次記下實際值，寫死進測試當回歸鎖。

- [ ] **Step 3: 跑測試確認失敗**

Run: `npx vitest run shop/src/lib/ecpay.test.js`
Expected: FAIL —— `makeEcpayConfig is not a function`、`getPrintUrl` 參數不符等。

- [ ] **Step 4: 改寫 `ecpay.js` 去除單例**

依序做這五項改動：

1. 刪掉 `const ENV = process.env.ECPAY_ENV === 'production' ? ...` 與整個 `export const ecpayConfig = {...}` 區塊，以及檔頭那段列出 `ECPAY_MERCHANT_ID` 等環境變數的註解（改成說明金鑰來自 `store_ecpay_secrets`）。
2. 新增工廠：

```js
/**
 * 依某店的金鑰列組出綠界設定。
 * secrets 為 store_ecpay_secrets 的一列；null/未設定時 fallback 到綠界公開測試金鑰。
 */
export function makeEcpayConfig(secrets) {
  const env = secrets?.env === 'production' ? 'production' : 'stage'
  return {
    env,
    merchantId: secrets?.merchant_id || STAGE_MERCHANT_ID,
    hashKey: secrets?.hash_key || STAGE_HASH_KEY,
    hashIV: secrets?.hash_iv || STAGE_HASH_IV,
    logisticsMerchantId: secrets?.logistics_merchant_id || STAGE_LOGISTICS_MERCHANT_ID,
    logisticsHashKey: secrets?.logistics_hash_key || STAGE_LOGISTICS_HASH_KEY,
    logisticsHashIV: secrets?.logistics_hash_iv || STAGE_LOGISTICS_HASH_IV,
    senderName: secrets?.sender_name || '',
    senderPhone: secrets?.sender_phone || '',
    urls: URLS[env],
  }
}

export const CVS_SUBTYPES = ['UNIMARTC2C', 'FAMIC2C', 'HILIFEC2C', 'OKMARTC2C']
export const COD_MAX_DEFAULT = 20000
```

3. `genCheckMacValue` 拿掉對 `ecpayConfig` 的預設值——`hashKey`/`hashIV` 改為必填，缺少時丟錯（讓漏傳在開發期就爆，而不是被綠界靜靜拒絕）：

```js
export function genCheckMacValue(params, opts = {}) {
  const { hashKey, hashIV, algo = 'sha256' } = opts
  if (!hashKey || !hashIV) throw new Error('genCheckMacValue 需要 hashKey 與 hashIV')
  // …以下排序、串接、ecpayUrlEncode、雜湊的邏輯完全不動…
}
```

4. 兩個包裝函式改成吃 config：

```js
/** 金流用：sha256 */
export function genPaymentCheckMac(params, cfg) {
  return genCheckMacValue(params, { hashKey: cfg.hashKey, hashIV: cfg.hashIV, algo: 'sha256' })
}

/** 物流用：md5（物流金鑰與金流不同，是綠界另外申請的一組） */
export function genLogisticsCheckMac(params, cfg) {
  return genCheckMacValue(params, { hashKey: cfg.logisticsHashKey, hashIV: cfg.logisticsHashIV, algo: 'md5' })
}
```

5. `getPrintUrl` 改吃 config，`genMerchantTradeNo`／`genLogisticsTradeNo` 加隨機後綴：

```js
export function getPrintUrl(subtype, cfg) {
  const path = PRINT_PATHS[subtype]
  if (!path) return null
  return `${cfg.urls.printBase}${path}`
}

// 兩碼 base36 隨機，避免同一訂單同一秒重複發起付款時撞號
function rand2() {
  return Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0')
}

export function genMerchantTradeNo(orderId, now = Date.now(), rand = rand2()) {
  const oid = Number(orderId).toString(36).toUpperCase()
  const ts = Math.floor(now / 1000).toString(36).toUpperCase()
  return `DG${oid}T${ts}${rand}`.slice(0, 20)
}

export function genLogisticsTradeNo(orderId, now = Date.now(), rand = rand2()) {
  const oid = Number(orderId).toString(36).toUpperCase()
  const ts = Math.floor(now / 1000).toString(36).toUpperCase()
  return `L${oid}T${ts}${rand}`.slice(0, 20)
}
```

`URLS` 裡的 `printBase` 欄位分支已有，保留不動。`ecpayUrlEncode`、`formatEcpayDate`、`logisticsMilestone`、`parseLogisticsResponse`、`buildAutoSubmitForm`、`LOGISTICS_MILESTONE_CODES`、`PRINT_PATHS` 全部原樣保留。

- [ ] **Step 5: 跑測試確認通過**

Run: `npx vitest run shop/src/lib/ecpay.test.js`
Expected: PASS（全部案例）

- [ ] **Step 6: 跑全套測試確認沒打壞既有的**

Run: `npx vitest run`
Expected: 19+ 個檔案全過

- [ ] **Step 7: Commit**

```bash
git add shop/src/lib/ecpay.js shop/src/lib/ecpay.test.js
git commit -m "feat: 綠界純函式移植，設定改成每店工廠而非單例"
```

---

### Task A2: `store_ecpay_secrets` 金鑰表與寫入 RPC

抄 `20250051_store_line_secrets.sql` 的模式：機密獨立表、啟用 RLS 但**故意不建任何 policy**（anon／authenticated 完全碰不到，只有 service role 繞得過），寫入走 `SECURITY DEFINER` RPC，另在 `stores.settings` 併入布林旗標供後台顯示。

與 LINE 那支的差別：**寫入權限只給平台管理員**（`is_platform_admin()`），不給店主——綠界金鑰填錯的代價是錢收不到或進錯帳戶。

**Files:**
- Create: `supabase/migrations/20260812120000_store_ecpay_secrets.sql`

**Interfaces:**
- Produces:
  - 表 `public.store_ecpay_secrets(store_id bigint PK → stores.id, env text, merchant_id text, hash_key text, hash_iv text, logistics_merchant_id text, logistics_hash_key text, logistics_hash_iv text, sender_name text, sender_phone text, cod_max integer, updated_at timestamptz)`
  - `public.set_store_ecpay_credentials(p_store_id bigint, p_env text, p_merchant_id text, p_hash_key text, p_hash_iv text, p_logistics_merchant_id text, p_logistics_hash_key text, p_logistics_hash_iv text, p_sender_name text, p_sender_phone text, p_cod_max integer) RETURNS void`
    - 任一 hash 欄位傳 `NULL` 或空字串＝**維持原值不變**（讓後台可以只改寄件人而不用重打金鑰）
    - `p_merchant_id` 傳空字串＝**清除整列**並把旗標設回 false
  - `stores.settings` 併入 `{ "ecpay_set": bool, "ecpay_env": text, "ecpay_cod_max": int }`（皆為非機密，可送前端）

- [ ] **Step 1: 讀既有模式，確認可用的授權函式**

```bash
cat supabase/migrations/20250051_store_line_secrets.sql
grep -rn "is_platform_admin\|has_store_role" supabase/migrations/*.sql | head -5
```

確認 `public.is_platform_admin()` 存在且無參數。若簽名不同，以實際簽名為準。

- [ ] **Step 2: 寫 migration**

建立 `supabase/migrations/20260812120000_store_ecpay_secrets.sql`：

```sql
-- 每店綠界金鑰（機密）：獨立表、零 client policy
-- stores.settings 會整包送到商城前端（含匿名訪客），HashKey/HashIV 不能放那裡；
-- 此表啟用 RLS 且故意不建任何 policy → anon/authenticated 完全碰不到，
-- 只有商城的 API route（service role，繞過 RLS）讀得到。
--
-- 金流與物流是綠界分開申請的兩組特店編號與金鑰，故各存三欄。
create table if not exists public.store_ecpay_secrets (
  store_id                bigint primary key references public.stores(id) on delete cascade,
  env                     text not null default 'stage',   -- 'stage' | 'production'
  merchant_id             text not null,
  hash_key                text not null,
  hash_iv                 text not null,
  logistics_merchant_id   text,
  logistics_hash_key      text,
  logistics_hash_iv       text,
  sender_name             text,
  sender_phone            text,
  cod_max                 integer not null default 20000,  -- 貨到付款金額上限
  updated_at              timestamptz not null default now()
);
alter table public.store_ecpay_secrets enable row level security;

comment on table public.store_ecpay_secrets is
  '每店綠界金鑰。RLS 開啟且無任何 policy，僅 service role 可讀；寫入走 set_store_ecpay_credentials。';

-- 店主寫入口（寫得進、讀不出）：僅平台管理員可設定。
-- 綠界金鑰填錯的代價是收款失敗或進錯帳戶，本輪不開放店主自助設定。
-- hash 類欄位傳 null/空字串＝維持原值（後台只改寄件人時不必重打金鑰）。
create or replace function public.set_store_ecpay_credentials(
  p_store_id              bigint,
  p_env                   text default 'stage',
  p_merchant_id           text default null,
  p_hash_key              text default null,
  p_hash_iv               text default null,
  p_logistics_merchant_id text default null,
  p_logistics_hash_key    text default null,
  p_logistics_hash_iv     text default null,
  p_sender_name           text default null,
  p_sender_phone          text default null,
  p_cod_max               integer default 20000
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_env text := case when p_env = 'production' then 'production' else 'stage' end;
  v_cod integer := greatest(1, least(coalesce(p_cod_max, 20000), 20000));
begin
  if not public.is_platform_admin() then
    raise exception '僅平台管理員可設定綠界金鑰';
  end if;

  -- 特店編號傳空＝整組清除
  if p_merchant_id is not null and length(trim(p_merchant_id)) = 0 then
    delete from public.store_ecpay_secrets where store_id = p_store_id;
    update public.stores
    set settings = coalesce(settings, '{}'::jsonb)
                   || jsonb_build_object('ecpay_set', false, 'ecpay_env', v_env, 'ecpay_cod_max', v_cod)
    where id = p_store_id;
    return;
  end if;

  insert into public.store_ecpay_secrets as s (
    store_id, env, merchant_id, hash_key, hash_iv,
    logistics_merchant_id, logistics_hash_key, logistics_hash_iv,
    sender_name, sender_phone, cod_max, updated_at
  ) values (
    p_store_id, v_env,
    coalesce(nullif(trim(p_merchant_id), ''), ''),
    coalesce(nullif(trim(p_hash_key), ''), ''),
    coalesce(nullif(trim(p_hash_iv), ''), ''),
    nullif(trim(p_logistics_merchant_id), ''),
    nullif(trim(p_logistics_hash_key), ''),
    nullif(trim(p_logistics_hash_iv), ''),
    nullif(trim(p_sender_name), ''),
    nullif(trim(p_sender_phone), ''),
    v_cod, now()
  )
  on conflict (store_id) do update set
    env                   = v_env,
    merchant_id           = coalesce(nullif(trim(p_merchant_id), ''), s.merchant_id),
    hash_key              = coalesce(nullif(trim(p_hash_key), ''), s.hash_key),
    hash_iv               = coalesce(nullif(trim(p_hash_iv), ''), s.hash_iv),
    logistics_merchant_id = coalesce(nullif(trim(p_logistics_merchant_id), ''), s.logistics_merchant_id),
    logistics_hash_key    = coalesce(nullif(trim(p_logistics_hash_key), ''), s.logistics_hash_key),
    logistics_hash_iv     = coalesce(nullif(trim(p_logistics_hash_iv), ''), s.logistics_hash_iv),
    sender_name           = coalesce(nullif(trim(p_sender_name), ''), s.sender_name),
    sender_phone          = coalesce(nullif(trim(p_sender_phone), ''), s.sender_phone),
    cod_max               = v_cod,
    updated_at            = now();

  -- 非機密旗標進 settings，讓後台顯示「已設定/未設定」、讓結帳頁決定要不要出現綠界選項
  update public.stores
  set settings = coalesce(settings, '{}'::jsonb)
                 || jsonb_build_object('ecpay_set', true, 'ecpay_env', v_env, 'ecpay_cod_max', v_cod)
  where id = p_store_id;
end;
$$;

revoke all on function public.set_store_ecpay_credentials(bigint, text, text, text, text, text, text, text, text, text, integer) from public, anon;
grant execute on function public.set_store_ecpay_credentials(bigint, text, text, text, text, text, text, text, text, text, integer) to authenticated;
```

- [ ] **Step 3: 套用到 local 並驗證隔離有效**

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54332/postgres" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260812120000_store_ecpay_secrets.sql
```

驗證 RLS 真的擋住一般角色（這是這支 migration 的核心價值，必須實測）：

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54332/postgres" -c "
  insert into public.store_ecpay_secrets (store_id, merchant_id, hash_key, hash_iv)
  values (1, '2000132', 'K', 'I') on conflict (store_id) do nothing;
  set role authenticated;
  select count(*) as should_be_zero from public.store_ecpay_secrets;
  reset role;
"
```

Expected: `should_be_zero` 為 `0`（RLS 無 policy → authenticated 讀不到任何列）

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260812120000_store_ecpay_secrets.sql
git commit -m "feat: 每店綠界金鑰表與平台管理員寫入 RPC"
```

---

### Task A3: 訂單端 schema（交易表、通知記錄、補欄位）

remote 目前只有 `payment_method`／`shipping_subtype`／`cvs_store_id`／`cvs_store_name`／`cvs_address` 五欄（`20260709053821` 補的），其餘全缺。

與分支的差別：**不在 `consumer_orders` 上放 `ecpay_trade_no` 單欄**——一張訂單要能有多筆綠界交易（棄單重付、加購補差額），交易資訊改放 `ecpay_transactions` 一筆一列。

**Files:**
- Create: `supabase/migrations/20260812100100_ecpay_order_schema.sql`

**Interfaces:**
- Produces:
  - `consumer_orders` 新增：`stock_released_at timestamptz`、`payment_alert text`、`ecpay_logistics_trade_no text`、`allpay_logistics_id text`、`cvs_payment_no text`、`cvs_validation_no text`、`logistics_status text`、`logistics_status_msg text`、`logistics_status_at timestamptz`
  - 表 `public.ecpay_transactions(id bigint PK, order_id bigint → consumer_orders, store_id bigint, trade_no text UNIQUE, amount numeric, status text, payment_type text, paid_at timestamptz, created_at timestamptz)`
  - 表 `public.ecpay_payment_logs(id bigint PK, order_id bigint, source text, trade_no text, rtn_code text, rtn_msg text, mac_valid boolean, raw jsonb, created_at timestamptz)`

- [ ] **Step 1: 寫 migration**

建立 `supabase/migrations/20260812100100_ecpay_order_schema.sql`：

```sql
-- 綠界訂單端 schema
-- 註：payment_method / shipping_subtype / cvs_* 五欄已由 20260709053821 補過，這裡不重複加。

-- ========== 1) consumer_orders 補欄位 ==========
alter table public.consumer_orders
  -- 棄單釋放的冪等旗標（release_order 用）
  add column if not exists stock_released_at        timestamptz,
  -- 需要店家人工處理的付款異常（例如已付款但庫存不足無法補回）
  add column if not exists payment_alert            text,
  -- 物流單（Express/Create 後回填）
  add column if not exists ecpay_logistics_trade_no text,
  add column if not exists allpay_logistics_id      text,
  add column if not exists cvs_payment_no           text,
  add column if not exists cvs_validation_no        text,
  add column if not exists logistics_status         text,
  add column if not exists logistics_status_msg     text,
  add column if not exists logistics_status_at      timestamptz;

comment on column public.consumer_orders.payment_alert is
  '付款異常待人工處理的說明；null 表示正常。後台訂單詳情會顯示。';

create index if not exists consumer_orders_allpay_logistics_id_idx
  on public.consumer_orders(allpay_logistics_id);

-- ========== 2) ecpay_transactions：一次付款嘗試一列 ==========
-- 一張訂單可以有多筆（棄單後重付、加購後補差額），金額累加進 consumer_orders.paid_amount。
create table if not exists public.ecpay_transactions (
  id           bigint generated always as identity primary key,
  order_id     bigint not null references public.consumer_orders(id) on delete cascade,
  store_id     bigint not null references public.stores(id),
  trade_no     text not null unique,          -- 綠界 MerchantTradeNo，冪等鍵
  amount       numeric not null,
  status       text not null default 'pending', -- 'pending' | 'paid' | 'failed'
  payment_type text,                          -- 綠界回傳的實際付款方式
  paid_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists ecpay_transactions_order_id_idx on public.ecpay_transactions(order_id);

alter table public.ecpay_transactions enable row level security;
-- 消費者不需要讀這張表（訂單頁只看 consumer_orders）；後台走 service role 或另開 policy。
revoke all on public.ecpay_transactions from anon, authenticated;

-- ========== 3) ecpay_payment_logs：綠界原始通知留底 ==========
-- 驗章失敗也要留（對帳與查弊都靠它）。
create table if not exists public.ecpay_payment_logs (
  id         bigint generated always as identity primary key,
  order_id   bigint references public.consumer_orders(id) on delete set null,
  source     text not null,   -- 'payment_notify' | 'payment_result' | 'logistics_create' | 'logistics_reply' | 'map_reply'
  trade_no   text,
  rtn_code   text,
  rtn_msg    text,
  mac_valid  boolean,
  raw        jsonb,
  created_at timestamptz not null default now()
);
create index if not exists ecpay_payment_logs_order_id_idx on public.ecpay_payment_logs(order_id);
create index if not exists ecpay_payment_logs_trade_no_idx on public.ecpay_payment_logs(trade_no);

alter table public.ecpay_payment_logs enable row level security;
revoke all on public.ecpay_payment_logs from anon, authenticated;
```

- [ ] **Step 2: 套用到 local 並驗證**

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54332/postgres" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260812100100_ecpay_order_schema.sql
psql "postgresql://postgres:postgres@127.0.0.1:54332/postgres" -c "
  select column_name from information_schema.columns
  where table_name='consumer_orders' and column_name in
    ('stock_released_at','payment_alert','allpay_logistics_id','cvs_payment_no');
  select to_regclass('public.ecpay_transactions'), to_regclass('public.ecpay_payment_logs');
"
```

Expected: 四個欄位都在、兩張表都不是 null

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260812100100_ecpay_order_schema.sql
git commit -m "feat: 綠界訂單端 schema——交易表、通知留底、物流欄位"
```

---

## Phase B

### Task B1: 棄單自動清理（順著 stock_committed trigger）

**動手前必讀 —— 庫存機制已經換掉了。** `supabase/migrations/20260812100000_stock_committed_trigger.sql`
把庫存變動收斂成單一寫入點：每張訂單用 `consumer_orders.stock_committed`（jsonb，鍵為 `"productId:variantId"`）
記自己佔走多少，trigger `reconcile_stock` 掛在 `AFTER INSERT OR DELETE OR UPDATE OF items_json, status`，
任何變動都重算目標佔用量並套用差額。**狀態為 `'已取消'` 時目標一律 0**，庫存自動回補；
差額為 0 時什麼都不做，所以冪等是結構性的，不需要任何旗標。

因此：

- **絕對不要手寫 `UPDATE products SET quantity = quantity + ...` 或 `UPDATE product_variants SET stock = ...`。**
  trigger 已經做了，再加一次就是重複回補。
- 釋放庫存的正確做法就是把 `status` 設成 `'已取消'`，其餘交給 trigger。
- 不需要 `release_order` 這支函式，也不需要 `stock_released_at` 旗標。
- `place_order` 現在只檢查庫存、不扣庫存（扣的動作歸 trigger）。

後台取消訂單的路徑（`src/components/ConsumerOrderDetailSheet.jsx:436`）已經會呼叫 `refund_coupon`，
不必重做；這支排程要自己補呼叫，因為它繞過了後台 UI。

**Files:**
- Create: `supabase/migrations/20260812130000_cancel_abandoned_orders.sql`
- Create: `supabase/tests/ecpay_payment.sql`

**Interfaces:**
- Consumes: 既有的 `public.refund_coupon(p_order_id bigint)`；`reconcile_stock` trigger
- Produces:
  - `public.cancel_abandoned_credit_orders(p_minutes int DEFAULT 30) RETURNS int` —— 回傳被清掉的筆數
  - pg_cron job `ecpay-abandon-sweep`，每 5 分鐘跑一次

- [ ] **Step 1: 先把 trigger 讀懂**

```bash
sed -n '1,60p' supabase/migrations/20260812100000_stock_committed_trigger.sql
grep -n "CREATE OR REPLACE FUNCTION public.refund_coupon" supabase/migrations/*.sql
```

確認 `refund_coupon` 的實際簽名（預期 `refund_coupon(p_order_id bigint)`）。若不同，以實際為準。

- [ ] **Step 2: 寫失敗測試**

建立 `supabase/tests/ecpay_payment.sql`：

```sql
-- 綠界收款/棄單清理的 RPC 測試。可重複執行：全程在一個交易內，最後 ROLLBACK。
-- 跑法：psql "postgresql://postgres:postgres@127.0.0.1:54332/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/ecpay_payment.sql
\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_eq(actual anyelement, expected anyelement, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL  %  — 預期 %，實際 %', label, expected, actual;
  END IF;
  RAISE NOTICE 'PASS  %', label;
END $$;

-- 建測試商品與訂單。注意：不手動扣庫存——reconcile_stock trigger 會在 INSERT 時扣。
CREATE OR REPLACE FUNCTION pg_temp.setup_order(p_qty int, p_stock int, p_total numeric)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_pid bigint; v_oid bigint;
BEGIN
  INSERT INTO public.products (store_id, name, quantity, cost, currency)
  VALUES (1, 'TEST綠界商品', p_stock, 0, 'TWD') RETURNING id INTO v_pid;

  INSERT INTO public.consumer_orders (
    store_id, customer_name, email, phone, items, items_json,
    total_amount, paid_amount, payment_method, status
  ) VALUES (
    1, 'TEST客', 't@test.local', '0900000000', 'TEST綠界商品',
    jsonb_build_array(jsonb_build_object('id', v_pid, 'qty', p_qty)),
    p_total, 0, 'credit', '處理中'
  ) RETURNING id INTO v_oid;

  RETURN v_oid;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.pid_of(p_oid bigint)
RETURNS bigint LANGUAGE sql AS $$
  SELECT (items_json->0->>'id')::bigint FROM public.consumer_orders WHERE id = p_oid;
$$;

CREATE OR REPLACE FUNCTION pg_temp.stock_of(p_oid bigint)
RETURNS int LANGUAGE sql AS $$
  SELECT quantity FROM public.products WHERE id = pg_temp.pid_of(p_oid);
$$;

-- ── trigger 前提：建單即佔用庫存 ──
DO $$
DECLARE v_oid bigint;
BEGIN
  v_oid := pg_temp.setup_order(2, 10, 500);
  PERFORM pg_temp.assert_eq(pg_temp.stock_of(v_oid), 8, '建單時 trigger 已扣庫存');
END $$;

-- ── cancel_abandoned_credit_orders ──
DO $$
DECLARE v_oid bigint; v_status text;
BEGIN
  v_oid := pg_temp.setup_order(1, 5, 300);

  -- 才剛建立 → 不該被掃
  PERFORM public.cancel_abandoned_credit_orders(30);
  SELECT status INTO v_status FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_status, '處理中', '30 分鐘內的未付訂單不被清理');
  PERFORM pg_temp.assert_eq(pg_temp.stock_of(v_oid), 4, '未被清理時庫存維持佔用');

  -- 假裝是 31 分鐘前建立的 → 該被掃，且 trigger 要把庫存還回去
  UPDATE public.consumer_orders SET created_at = now() - interval '31 minutes' WHERE id = v_oid;
  PERFORM public.cancel_abandoned_credit_orders(30);
  SELECT status INTO v_status FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_status, '已取消', '逾時未付的信用卡訂單被取消');
  PERFORM pg_temp.assert_eq(pg_temp.stock_of(v_oid), 5, '取消後 trigger 把庫存還回，且只還一次');

  -- 重複執行不可以再還一次
  PERFORM public.cancel_abandoned_credit_orders(30);
  PERFORM pg_temp.assert_eq(pg_temp.stock_of(v_oid), 5, '重複清理不重複回補庫存');
END $$;

-- ── 不該被波及的訂單 ──
DO $$
DECLARE v_oid bigint; v_status text;
BEGIN
  -- 匯款訂單
  v_oid := pg_temp.setup_order(1, 5, 300);
  UPDATE public.consumer_orders
    SET payment_method = 'remittance', created_at = now() - interval '10 hours' WHERE id = v_oid;
  PERFORM public.cancel_abandoned_credit_orders(30);
  SELECT status INTO v_status FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_status, '處理中', '匯款訂單不被信用卡棄單清理波及');

  -- 已收到錢的訂單（例如 notify 已經進來過）
  v_oid := pg_temp.setup_order(1, 5, 300);
  UPDATE public.consumer_orders
    SET paid_amount = 300, created_at = now() - interval '10 hours' WHERE id = v_oid;
  PERFORM public.cancel_abandoned_credit_orders(30);
  SELECT status INTO v_status FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_status, '處理中', '已收款的訂單不被當棄單清掉');

  -- 已建物流單的訂單
  v_oid := pg_temp.setup_order(1, 5, 300);
  UPDATE public.consumer_orders
    SET allpay_logistics_id = 'L123', created_at = now() - interval '10 hours' WHERE id = v_oid;
  PERFORM public.cancel_abandoned_credit_orders(30);
  SELECT status INTO v_status FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_status, '處理中', '已建物流單的訂單不被當棄單清掉');
END $$;

ROLLBACK;
```

> 若 `products` 或 `consumer_orders` 有本測試沒帶到的 NOT NULL 欄位，補進 `pg_temp.setup_order` 的 INSERT。
> 先跑 `psql ... -c "\d public.consumer_orders"` 確認。

- [ ] **Step 3: 跑測試確認失敗**

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54332/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/ecpay_payment.sql
```
Expected: FAIL —— `function public.cancel_abandoned_credit_orders(integer) does not exist`

- [ ] **Step 4: 寫 migration**

建立 `supabase/migrations/20260812130000_cancel_abandoned_orders.sql`：

```sql
-- 信用卡棄單自動清理
--
-- 導轉綠界後沒付款的訂單會一直壓著庫存。匯款是填完後五碼才送出（等於已成交意圖），
-- 信用卡是跳走後可能直接關掉，棄單率完全不同量級，所以只掃信用卡。
--
-- 庫存回補交給 reconcile_stock trigger（20260812100000）：狀態設成「已取消」，
-- 目標佔用量即為 0，trigger 自己算差額還庫存。此處不可手動改 products.quantity。
create or replace function public.cancel_abandoned_credit_orders(p_minutes int default 30)
returns int
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id bigint;
  v_n  int := 0;
begin
  for v_id in
    select id from public.consumer_orders
    where payment_method = 'credit'
      and coalesce(paid_amount, 0) <= 0           -- 收到任何錢就不是棄單
      and status not in ('已取消', '完成', '已出貨')
      and allpay_logistics_id is null             -- 已建物流單就不是棄單
      and created_at < now() - make_interval(mins => p_minutes)
  loop
    -- 狀態改成已取消 → reconcile_stock trigger 把佔用量歸零，庫存自動回補
    update public.consumer_orders set status = '已取消' where id = v_id;
    -- 排程繞過了後台 UI，優惠券要自己退（refund_coupon 對無券/已退自身安全）
    perform public.refund_coupon(v_id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

revoke all on function public.cancel_abandoned_credit_orders(int) from public, anon;
grant execute on function public.cancel_abandoned_credit_orders(int) to authenticated;

-- 每 5 分鐘掃一次（pg_cron 已裝，版本 1.6.4）
-- 30 分鐘足以涵蓋「開了付款頁去找卡片」，又不會讓熱門商品被殭屍訂單壓住。
select cron.unschedule('ecpay-abandon-sweep')
where exists (select 1 from cron.job where jobname = 'ecpay-abandon-sweep');

select cron.schedule(
  'ecpay-abandon-sweep',
  '*/5 * * * *',
  $$select public.cancel_abandoned_credit_orders(30)$$
);
```

- [ ] **Step 5: 套用並跑測試確認通過**

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54332/postgres" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260812130000_cancel_abandoned_orders.sql
psql "postgresql://postgres:postgres@127.0.0.1:54332/postgres" -v ON_ERROR_STOP=1 \
  -f supabase/tests/ecpay_payment.sql
```
Expected: 全部 `PASS`，最後 `ROLLBACK`

- [ ] **Step 6: 確認排程真的建起來**

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54332/postgres" -c \
  "select jobname, schedule, command from cron.job where jobname='ecpay-abandon-sweep';"
```

---

### Task B2: 收款套用 RPC（冪等、累加、遲到補救）

這是整個串接最關鍵的一支。三件事必須同時成立：

1. **不直接寫 `payment_status`** —— 寫 `paid_amount`，讓 `sync_payment_status` trigger 推導。
   直接 `UPDATE payment_status='已付清'` 會被 trigger 用 `derive_payment_status(paid_amount, total_amount)` 靜靜蓋回「未付」。
2. **冪等** —— 綠界的 `notify` 會重試，`result` 也做同一件事，同一筆 `trade_no` 重複進來只能算一次錢。
3. **遲到補救** —— 通知晚於棄單清理時，訂單已被取消、庫存已回補。要把訂單復活；
   庫存不足就標 `payment_alert` 讓店家人工處理，**絕不能默默把錢吃掉**。

**動手前必讀 —— 庫存機制：** 見 Task B1 開頭那段。重點是**不要手寫任何庫存 UPDATE**。
遲到補救「重新佔用庫存」的正確做法是把 `status` 從 `'已取消'` 改回 `'處理中'`——
`reconcile_stock` trigger 會重新計算佔用量並套用，**現貨不足時它自己會 raise exception**，
你只要用 `BEGIN … EXCEPTION` 接住並改標警示即可。這比手寫「先檢查再扣」少了一整段迴圈，
而且擋單規則（預購可負、現貨不可負）自動與商城一致。

**Files:**
- Create: `supabase/migrations/20260812140000_apply_ecpay_payment.sql`
- Modify: `supabase/tests/ecpay_payment.sql`（追加測試，接在 B1 的測試之後、`ROLLBACK;` 之前）

**Interfaces:**
- Consumes: A3 的 `ecpay_transactions`／`payment_alert`；B1 的 `cancel_abandoned_credit_orders`；`reconcile_stock` trigger
- Produces:
  - `public.create_ecpay_transaction(p_order_id bigint, p_trade_no text, p_amount numeric) RETURNS jsonb`
  - `public.apply_ecpay_payment(p_trade_no text, p_rtn_code text, p_payment_type text DEFAULT NULL) RETURNS jsonb`
    —— 回 `{ok, already, paid, order_id, alert, error}`
  - `public.apply_cod_payment(p_order_id bigint) RETURNS jsonb`

- [ ] **Step 1: 寫失敗測試**

在 `supabase/tests/ecpay_payment.sql` 的 `ROLLBACK;` 之前插入：

```sql
-- ── apply_ecpay_payment：正常收款 ──
DO $$
DECLARE v_oid bigint; v_paid numeric; v_pstatus text; v_r jsonb;
BEGIN
  v_oid := pg_temp.setup_order(1, 5, 1000);
  PERFORM public.create_ecpay_transaction(v_oid, 'TESTTRADE001', 1000);

  v_r := public.apply_ecpay_payment('TESTTRADE001', '1', 'Credit_CreditCard');
  PERFORM pg_temp.assert_eq((v_r->>'ok')::boolean, true, 'apply 回報成功');

  SELECT paid_amount, payment_status INTO v_paid, v_pstatus
    FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_paid, 1000::numeric, '付款金額寫進 paid_amount');
  PERFORM pg_temp.assert_eq(v_pstatus, '已付清', 'payment_status 由 trigger 推導成已付清');

  -- 冪等：同一筆 trade_no 再進來一次，錢不可以算兩次
  v_r := public.apply_ecpay_payment('TESTTRADE001', '1', 'Credit_CreditCard');
  PERFORM pg_temp.assert_eq((v_r->>'already')::boolean, true, '重複通知被識別為已處理');
  SELECT paid_amount INTO v_paid FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_paid, 1000::numeric, '重複通知不重複累加金額');
END $$;

-- ── 部分付款：加購後補差額 ──
DO $$
DECLARE v_oid bigint; v_paid numeric; v_pstatus text;
BEGIN
  v_oid := pg_temp.setup_order(1, 5, 1000);
  PERFORM public.create_ecpay_transaction(v_oid, 'TESTTRADE00A', 600);
  PERFORM public.apply_ecpay_payment('TESTTRADE00A', '1', 'Credit');
  SELECT paid_amount, payment_status INTO v_paid, v_pstatus
    FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_paid, 600::numeric, '第一筆收 600');
  PERFORM pg_temp.assert_eq(v_pstatus, '部分付款', '未收滿時狀態為部分付款');

  PERFORM public.create_ecpay_transaction(v_oid, 'TESTTRADE00B', 400);
  PERFORM public.apply_ecpay_payment('TESTTRADE00B', '1', 'Credit');
  SELECT paid_amount, payment_status INTO v_paid, v_pstatus
    FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_paid, 1000::numeric, '第二筆累加到 1000');
  PERFORM pg_temp.assert_eq(v_pstatus, '已付清', '收滿後狀態為已付清');
END $$;

-- ── 付款失敗不動錢 ──
DO $$
DECLARE v_oid bigint; v_paid numeric; v_tstatus text;
BEGIN
  v_oid := pg_temp.setup_order(1, 5, 500);
  PERFORM public.create_ecpay_transaction(v_oid, 'TESTTRADE002', 500);
  PERFORM public.apply_ecpay_payment('TESTTRADE002', '0', NULL);

  SELECT paid_amount INTO v_paid FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_paid, 0::numeric, '付款失敗不累加金額');
  SELECT status INTO v_tstatus FROM public.ecpay_transactions WHERE trade_no = 'TESTTRADE002';
  PERFORM pg_temp.assert_eq(v_tstatus, 'failed', '失敗交易標記為 failed');
END $$;

-- ── 未知 trade_no ──
DO $$
DECLARE v_r jsonb;
BEGIN
  v_r := public.apply_ecpay_payment('NO_SUCH_TRADE', '1', 'Credit');
  PERFORM pg_temp.assert_eq((v_r->>'ok')::boolean, false, '未知交易編號回報失敗而非默默吞掉');
END $$;

-- ── 遲到補救：訂單已被當棄單取消，庫存夠 → 復活並重新佔用 ──
DO $$
DECLARE v_oid bigint; v_status text; v_paid numeric; v_alert text; v_r jsonb;
BEGIN
  v_oid := pg_temp.setup_order(2, 10, 800);
  PERFORM public.create_ecpay_transaction(v_oid, 'TESTTRADE003', 800);
  PERFORM pg_temp.assert_eq(pg_temp.stock_of(v_oid), 8, '建單已佔用 2 件');

  -- 模擬棄單清理跑過了
  UPDATE public.consumer_orders SET created_at = now() - interval '31 minutes' WHERE id = v_oid;
  PERFORM public.cancel_abandoned_credit_orders(30);
  PERFORM pg_temp.assert_eq(pg_temp.stock_of(v_oid), 10, '棄單清理已把庫存還回');
  SELECT status INTO v_status FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_status, '已取消', '棄單已被取消');

  -- 綠界通知遲到才進來
  v_r := public.apply_ecpay_payment('TESTTRADE003', '1', 'Credit_CreditCard');
  PERFORM pg_temp.assert_eq((v_r->>'ok')::boolean, true, '遲到通知仍被接受');

  PERFORM pg_temp.assert_eq(pg_temp.stock_of(v_oid), 8, '遲到補救讓 trigger 重新佔用庫存');
  SELECT status, paid_amount, payment_alert INTO v_status, v_paid, v_alert
    FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_status, '處理中', '訂單從已取消復活');
  PERFORM pg_temp.assert_eq(v_paid, 800::numeric, '遲到補救仍記錄收款');
  PERFORM pg_temp.assert_eq(v_alert, NULL::text, '庫存夠時不該標警示');
END $$;

-- ── 遲到補救：庫存不足 → 收錢但標警示，絕不默默吞掉 ──
DO $$
DECLARE v_oid bigint; v_pid bigint; v_alert text; v_paid numeric; v_status text;
BEGIN
  v_oid := pg_temp.setup_order(2, 2, 800);   -- 建單後庫存歸零
  v_pid := pg_temp.pid_of(v_oid);
  PERFORM public.create_ecpay_transaction(v_oid, 'TESTTRADE004', 800);

  -- 這件商品要是「現貨」才會擋單：確保它在商城上架且不跳過庫存檢查
  INSERT INTO public.storefront_products (store_id, product_id, shop_price, skip_stock_check)
  VALUES (1, v_pid, 400, false)
  ON CONFLICT (store_id, product_id) DO UPDATE SET skip_stock_check = false, collection_end = NULL;

  UPDATE public.consumer_orders SET created_at = now() - interval '31 minutes' WHERE id = v_oid;
  PERFORM public.cancel_abandoned_credit_orders(30);
  -- 庫存被還回後立刻被別人買光
  UPDATE public.products SET quantity = 0 WHERE id = v_pid;

  PERFORM public.apply_ecpay_payment('TESTTRADE004', '1', 'Credit_CreditCard');

  SELECT payment_alert, paid_amount, status INTO v_alert, v_paid, v_status
    FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_paid, 800::numeric, '庫存不足仍要記錄已收款');
  PERFORM pg_temp.assert_eq(v_alert IS NOT NULL, true, '庫存不足時標記 payment_alert 讓店家處理');
  PERFORM pg_temp.assert_eq(v_status, '已取消', '復活失敗時狀態維持已取消，不可假裝成功');
END $$;

-- ── apply_cod_payment ──
DO $$
DECLARE v_oid bigint; v_paid numeric; v_pstatus text;
BEGIN
  v_oid := pg_temp.setup_order(1, 5, 600);
  UPDATE public.consumer_orders SET payment_method = 'cod' WHERE id = v_oid;

  PERFORM public.apply_cod_payment(v_oid);
  SELECT paid_amount, payment_status INTO v_paid, v_pstatus
    FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_paid, 600::numeric, '貨到付款取件後補滿金額');
  PERFORM pg_temp.assert_eq(v_pstatus, '已付清', '貨到付款取件後狀態為已付清');

  -- 冪等
  PERFORM public.apply_cod_payment(v_oid);
  SELECT paid_amount INTO v_paid FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_paid, 600::numeric, '重複取件通知不重複加錢');
END $$;
```

> `storefront_products` 的欄位名稱與唯一鍵請先用 `\d public.storefront_products` 確認再寫；
> 若唯一鍵不是 `(store_id, product_id)`，把 `ON CONFLICT` 改成實際的。

- [ ] **Step 2: 跑測試確認失敗**

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54332/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/ecpay_payment.sql
```
Expected: FAIL —— `function public.create_ecpay_transaction(...) does not exist`

- [ ] **Step 3: 寫 migration**

建立 `supabase/migrations/20260812140000_apply_ecpay_payment.sql`：

```sql
-- 綠界收款套用。三個不變量：
-- 1) 不直接寫 payment_status——寫 paid_amount，由 sync_payment_status trigger 推導
-- 2) 冪等——綠界 notify 會重試，result 也做同一件事，同一 trade_no 只能算一次錢
-- 3) 遲到補救——通知晚於棄單清理時要把訂單復活；庫存不足就標警示，不默默吃錢
--
-- 庫存一律交給 reconcile_stock trigger（20260812100000）：這裡只改 status，
-- 佔用量的增減由 trigger 依 stock_committed 差額處理。切勿手寫庫存 UPDATE。

-- ========== 建立 pending 交易 ==========
create or replace function public.create_ecpay_transaction(
  p_order_id bigint, p_trade_no text, p_amount numeric
) returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare v_store_id bigint;
begin
  select store_id into v_store_id from public.consumer_orders where id = p_order_id;
  if v_store_id is null then
    return jsonb_build_object('ok', false, 'error', '訂單不存在');
  end if;

  insert into public.ecpay_transactions (order_id, store_id, trade_no, amount, status)
  values (p_order_id, v_store_id, p_trade_no, p_amount, 'pending')
  on conflict (trade_no) do nothing;

  return jsonb_build_object('ok', true, 'trade_no', p_trade_no);
end $$;

-- ========== 套用付款結果 ==========
create or replace function public.apply_ecpay_payment(
  p_trade_no text, p_rtn_code text, p_payment_type text default null
) returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_txn   record;
  v_order record;
  v_alert text := null;
begin
  select * into v_txn from public.ecpay_transactions
    where trade_no = p_trade_no for update;
  if v_txn is null then
    return jsonb_build_object('ok', false, 'error', '未知的交易編號');
  end if;

  -- 冪等：已處理過就直接回報
  if v_txn.status = 'paid' then
    return jsonb_build_object('ok', true, 'already', true, 'order_id', v_txn.order_id);
  end if;

  -- 付款失敗：標記後結束，不動訂單金額
  if p_rtn_code is distinct from '1' then
    update public.ecpay_transactions set status = 'failed' where id = v_txn.id;
    return jsonb_build_object('ok', true, 'already', false, 'paid', false,
                              'order_id', v_txn.order_id);
  end if;

  select * into v_order from public.consumer_orders where id = v_txn.order_id for update;
  if v_order is null then
    return jsonb_build_object('ok', false, 'error', '訂單不存在');
  end if;

  -- 遲到補救：通知晚於棄單清理，訂單已被取消、庫存也已回補。
  -- 把狀態改回處理中即可——reconcile_stock trigger 會重新佔用庫存，
  -- 現貨不足時它自己會 raise，這裡接住並改標警示，絕不默默把錢吃掉。
  if v_order.status = '已取消' then
    begin
      update public.consumer_orders set status = '處理中' where id = v_order.id;
    exception when others then
      v_alert := '已收款但庫存不足，訂單先前已被當棄單取消，請人工確認出貨或退款（'
                 || sqlerrm || '）';
    end;
  end if;

  -- 記帳：只動 paid_amount 與 payment_alert，不碰 status/items_json，
  -- 因此不會再次觸發 reconcile_stock（它只監看那兩欄）。
  update public.consumer_orders
    set paid_amount   = coalesce(paid_amount, 0) + v_txn.amount,
        payment_alert = coalesce(v_alert, payment_alert)
    where id = v_order.id;

  update public.ecpay_transactions
    set status = 'paid', paid_at = now(), payment_type = p_payment_type
    where id = v_txn.id;

  return jsonb_build_object('ok', true, 'already', false, 'paid', true,
                            'order_id', v_order.id, 'alert', v_alert);
end $$;

-- ========== 貨到付款：取件完成＝綠界代收完成 ==========
create or replace function public.apply_cod_payment(p_order_id bigint)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare v_order record;
begin
  select * into v_order from public.consumer_orders where id = p_order_id for update;
  if v_order is null then
    return jsonb_build_object('ok', false, 'error', '訂單不存在');
  end if;

  -- 冪等：已收滿就不再加
  if coalesce(v_order.paid_amount, 0) >= coalesce(v_order.total_amount, 0) then
    return jsonb_build_object('ok', true, 'already', true);
  end if;

  update public.consumer_orders
    set paid_amount = coalesce(total_amount, 0)
    where id = p_order_id;

  return jsonb_build_object('ok', true, 'already', false);
end $$;

-- 權限：這三支只由商城 API route（service role）呼叫，不開給 anon/authenticated
revoke all on function public.create_ecpay_transaction(bigint, text, numeric) from public, anon, authenticated;
revoke all on function public.apply_ecpay_payment(text, text, text) from public, anon, authenticated;
revoke all on function public.apply_cod_payment(bigint) from public, anon, authenticated;
```

- [ ] **Step 4: 套用並跑測試確認通過**

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54332/postgres" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260812140000_apply_ecpay_payment.sql
psql "postgresql://postgres:postgres@127.0.0.1:54332/postgres" -v ON_ERROR_STOP=1 \
  -f supabase/tests/ecpay_payment.sql
```
Expected: 全部 `PASS`

- [ ] **Step 5: 確認既有的庫存測試沒被打壞**

```bash
npm run test:sql
```
Expected: 既有的 `stock_reconcile.sql` 仍全過

---


### Task B3: server 端金鑰取用（`supabase-admin.js` ＋ `ecpayStore.js`）

**Files:**
- Create: `shop/src/lib/supabase-admin.js`
- Create: `shop/src/lib/ecpayStore.js`
- Modify: `shop/.env.example`

**Interfaces:**
- Consumes: A1 的 `makeEcpayConfig`；A2 的 `store_ecpay_secrets`
- Produces:
  - `supabaseAdmin` —— service role client，未設定 secret key 時為 `null`
  - `getEcpayConfigForStore(storeId) -> Promise<Config|null>` —— 該店沒設金鑰時回 `null`
  - `loadOrderForEcpay(orderId, columns) -> Promise<{ order, cfg } | { error }>` —— 一次取訂單＋該店 config，兩者缺一即回錯誤
  - `callbackBaseUrl() -> string` —— 讀 `ECPAY_CALLBACK_BASE_URL`

- [ ] **Step 1: 搬 admin client（分支原檔可直接用）**

```bash
git show feature/ecpay-integration:shop/src/lib/supabase-admin.js > shop/src/lib/supabase-admin.js
```

- [ ] **Step 2: 寫 `ecpayStore.js`**

```js
// 依店家取綠界設定（server only）。
// 金鑰存在 store_ecpay_secrets，該表 RLS 開啟且無任何 policy，
// 只有這裡用的 service role client 讀得到——切勿在 client component import。
import { supabaseAdmin } from './supabase-admin'
import { makeEcpayConfig } from './ecpay'

/** 綠界背景通知（金流 ReturnURL、物流 ServerReplyURL）用的固定網址 */
export function callbackBaseUrl() {
  return process.env.ECPAY_CALLBACK_BASE_URL || ''
}

/** 取某店的綠界設定；該店沒設金鑰回 null（結帳頁據此隱藏綠界付款方式） */
export async function getEcpayConfigForStore(storeId) {
  if (!supabaseAdmin || storeId == null) return null
  const { data, error } = await supabaseAdmin
    .from('store_ecpay_secrets')
    .select('*')
    .eq('store_id', storeId)
    .maybeSingle()
  if (error || !data) return null
  return makeEcpayConfig(data)
}

/**
 * 一次載入訂單與該店綠界設定。
 * 回 { order, cfg } 或 { error }——呼叫端只要判斷 error 就好。
 * columns 需自行包含 store_id。
 */
export async function loadOrderForEcpay(orderId, columns) {
  if (!supabaseAdmin) return { error: '伺服器未設定（缺少 service key）' }

  const { data: order, error } = await supabaseAdmin
    .from('consumer_orders')
    .select(columns)
    .eq('id', orderId)
    .maybeSingle()

  if (error || !order) return { error: '找不到訂單' }

  const cfg = await getEcpayConfigForStore(order.store_id)
  if (!cfg) return { error: '此店家尚未設定綠界金鑰' }

  return { order, cfg }
}
```

- [ ] **Step 3: 記錄環境變數**

在 `shop/.env.example` 加入（若檔案不存在就建立）：

```bash
# ── 綠界 ECPay ──
# 金鑰本身存在 DB（store_ecpay_secrets），由後台「設定 → 綠界金物流」填寫，不放這裡。
# 這裡只放綠界背景通知要打回來的固定網址（金流 ReturnURL、物流 ServerReplyURL）。
# 消費者導回的網址一律用請求當下的 origin，不看這個值。
ECPAY_CALLBACK_BASE_URL=https://daigogotw.com

# server 端 Supabase service role key（回呼繞過 RLS 用）
SUPABASE_SECRET_KEY=
```

同時把同樣兩行加進本機的 `shop/.env.local`（`SUPABASE_SECRET_KEY` 若已存在就不動）。

- [ ] **Step 4: 驗證能真的讀到金鑰**

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54332/postgres" -c "
  insert into public.store_ecpay_secrets
    (store_id, env, merchant_id, hash_key, hash_iv,
     logistics_merchant_id, logistics_hash_key, logistics_hash_iv, sender_name, sender_phone)
  values (1, 'stage', '2000132', '5294y06JbISpM5x9', 'v77hoKGq4kWxNNIS',
          '2000933', 'XBERn1YOvpM9nfZc', 'h1ONHk4P4yqbl5LK', '測試寄件人', '0900000000')
  on conflict (store_id) do update set updated_at = now();
  update public.stores set settings = coalesce(settings,'{}'::jsonb) || '{\"ecpay_set\":true,\"ecpay_env\":\"stage\",\"ecpay_cod_max\":20000}'::jsonb where id = 1;
"
```

- [ ] **Step 5: Commit**

```bash
git add shop/src/lib/supabase-admin.js shop/src/lib/ecpayStore.js shop/.env.example
git commit -m "feat: 商城 server 端依店取綠界金鑰"
```

---

## Phase C —— 七支 API route（可完全並行）

所有 route 共通規則：

- `export const dynamic = 'force-dynamic'`
- 用 `loadOrderForEcpay(orderId, columns)` 取訂單＋config，**不可** import 任何單例設定
- 背景通知類（`notify`、`logistics/notify`）：驗章失敗回 `0|CheckMacValue Error`，成功回 `1|OK`，且**驗章失敗也要寫 `ecpay_payment_logs`**
- 消費者導轉類：錯誤回可讀的 HTML，不要回 JSON

### Task C1: 信用卡導轉 `api/ecpay/credit/[orderId]`

**Files:**
- Create: `shop/src/app/api/ecpay/credit/[orderId]/route.js`
- Reference: `git show 'feature/ecpay-integration:shop/src/app/api/ecpay/credit/[orderId]/route.js'`

**Interfaces:**
- Consumes: B3 的 `loadOrderForEcpay`／`callbackBaseUrl`；A1 的 `genPaymentCheckMac`／`genMerchantTradeNo`／`formatEcpayDate`／`buildAutoSubmitForm`；B2 的 `create_ecpay_transaction`
- Produces: `GET /api/ecpay/credit/:orderId` → 自動送出的 HTML 表單，POST 到綠界 AIO

- [ ] **Step 1: 取分支原檔當基底**

```bash
mkdir -p 'shop/src/app/api/ecpay/credit/[orderId]'
git show 'feature/ecpay-integration:shop/src/app/api/ecpay/credit/[orderId]/route.js' \
  > 'shop/src/app/api/ecpay/credit/[orderId]/route.js'
```

- [ ] **Step 2: 改成多租戶＋多筆交易**

七項改動：

1. import 改成 `import { loadOrderForEcpay, callbackBaseUrl } from '../../../../../lib/ecpayStore'`，並從 `../../../../../lib/ecpay` 取 `genPaymentCheckMac, formatEcpayDate, genMerchantTradeNo, buildAutoSubmitForm`。刪掉 `ecpayConfig` 與 `supabaseAdmin` 的 import、刪掉 `BASE_URL`／`SITE_URL` 兩個 module 常數。
2. 取訂單改成：

```js
const { order, cfg, error } = await loadOrderForEcpay(params.orderId,
  'id, store_id, total_amount, paid_amount, payment_method, payment_status, items')
if (error) return htmlError(error)
```

3. 金額改成**未付餘額**，而不是訂單總額——這是「一張訂單多筆交易」的關鍵，棄單重付與加購補差額都靠它：

```js
const amount = Math.round(Number(order.total_amount || 0) - Number(order.paid_amount || 0))
if (amount <= 0) return htmlError('此訂單已無待付金額')
```

4. 刪掉 `if (order.payment_status === '已付清') return htmlError(...)`——已由上一步的餘額檢查涵蓋，且加購後的補款不該被擋。
5. 交易編號改成寫進 `ecpay_transactions`，不再 `update consumer_orders.ecpay_trade_no`：

```js
const tradeNo = genMerchantTradeNo(order.id)
const { error: txnErr } = await supabaseAdmin.rpc('create_ecpay_transaction', {
  p_order_id: order.id, p_trade_no: tradeNo, p_amount: amount,
})
if (txnErr) return htmlError('建立交易失敗：' + txnErr.message)
```

（此處仍需 `import { supabaseAdmin } from '../../../../../lib/supabase-admin'`。）

6. 網址三個各按規則取：

```js
const origin = new URL(request.url).origin        // 消費者當下所在的店家網域
const callbackBase = callbackBaseUrl() || origin  // 綠界背景通知的固定網域
// …
ReturnURL:       `${callbackBase}/api/ecpay/notify`,
OrderResultURL:  `${origin}/api/ecpay/result`,
ClientBackURL:   `${origin}/order/${order.id}`,
```

`ClientBackURL` 從分支的 `/cart` 改成訂單頁——購物車在下單時已清空，導回去會是空車。

7. 檢查碼與 AIO 網址改吃 config：`genPaymentCheckMac(ecpayParams, cfg)`、`buildAutoSubmitForm(cfg.urls.aio, ...)`，`MerchantID: cfg.merchantId`。`TradeDesc` 從寫死的 `'Daigogo Order'` 改成 `'Order'`（多租戶下不該寫死品牌名）。

- [ ] **Step 3: 語法檢查**

Run: `cd shop && npx next build --no-lint 2>&1 | tail -20`
Expected: 編譯通過（若商城 dev server 正在跑，**先停掉再 build**，否則會炸 `.next`）

> 若不確定 dev 是否在跑：`lsof -i :3000`。有東西就先別 build，改用 `node --input-type=module -e "…"` 之類的方式做語法檢查，或等 dev 停下。

- [ ] **Step 4: Commit**

```bash
git add 'shop/src/app/api/ecpay/credit/[orderId]/route.js'
git commit -m "feat: 信用卡導轉——每店金鑰、按未付餘額建交易"
```

---

### Task C2: 金流背景通知 `api/ecpay/notify`

**Files:**
- Create: `shop/src/app/api/ecpay/notify/route.js`
- Reference: `git show feature/ecpay-integration:shop/src/app/api/ecpay/notify/route.js`

**Interfaces:**
- Consumes: A1 `verifyCheckMacValue`；B3 `getEcpayConfigForStore`；B2 `apply_ecpay_payment`
- Produces: `POST /api/ecpay/notify` → 純文字 `1|OK` 或 `0|CheckMacValue Error`

**驗章的雞生蛋問題：** 綠界 POST 進來時還不知道是哪家店，但驗章需要該店的 HashKey。解法是先用 `MerchantTradeNo` 從 `ecpay_transactions` 反查 `store_id`（該表的 `trade_no` 有唯一索引），拿到 store 再取金鑰驗章。`CustomField1` 只當備援。

- [ ] **Step 1: 取分支原檔當基底**

```bash
mkdir -p shop/src/app/api/ecpay/notify
git show feature/ecpay-integration:shop/src/app/api/ecpay/notify/route.js \
  > shop/src/app/api/ecpay/notify/route.js
```

- [ ] **Step 2: 改成先反查店家再驗章、改走 RPC 記帳**

```js
// 金流 ReturnURL：綠界背景 POST 付款結果 → 反查店家 → 驗章 → 記帳 → 回 1|OK
// 付款金額一律經 apply_ecpay_payment 寫進 paid_amount，payment_status 由 trigger 推導。
// 直接 UPDATE payment_status 會被 sync_payment_status trigger 蓋掉。
import { supabaseAdmin } from '../../../../lib/supabase-admin'
import { getEcpayConfigForStore } from '../../../../lib/ecpayStore'
import { verifyCheckMacValue } from '../../../../lib/ecpay'

export const dynamic = 'force-dynamic'

function text(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}

export async function POST(request) {
  const form = await request.formData()
  const data = Object.fromEntries(form)
  const tradeNo = data.MerchantTradeNo || null

  if (!supabaseAdmin) return text('0|server not configured')

  // 綠界不會告訴我們是哪家店 —— 用交易編號反查（trade_no 有唯一索引）
  const { data: txn } = await supabaseAdmin
    .from('ecpay_transactions')
    .select('order_id, store_id')
    .eq('trade_no', tradeNo)
    .maybeSingle()

  const cfg = txn ? await getEcpayConfigForStore(txn.store_id) : null
  const macValid = cfg
    ? verifyCheckMacValue(data, { hashKey: cfg.hashKey, hashIV: cfg.hashIV, algo: 'sha256' })
    : false

  // 留底（驗章失敗也要記，對帳與查弊都靠它）
  await supabaseAdmin.from('ecpay_payment_logs').insert({
    order_id: txn?.order_id ?? null,
    source: 'payment_notify',
    trade_no: tradeNo,
    rtn_code: data.RtnCode != null ? String(data.RtnCode) : null,
    rtn_msg: data.RtnMsg || null,
    mac_valid: macValid,
    raw: data,
  })

  if (!macValid) return text('0|CheckMacValue Error')

  await supabaseAdmin.rpc('apply_ecpay_payment', {
    p_trade_no: tradeNo,
    p_rtn_code: data.RtnCode != null ? String(data.RtnCode) : null,
    p_payment_type: data.PaymentType || null,
  })

  return text('1|OK')
}
```

- [ ] **Step 3: Commit**

```bash
git add shop/src/app/api/ecpay/notify/route.js
git commit -m "feat: 金流背景通知——反查店家驗章、經 RPC 記帳"
```

---

### Task C3: 付款後導回 `api/ecpay/result`

`notify` 是付款狀態的主要真相，但它可能延遲或漏送。這支在消費者被導回時做同樣的驗章與記帳當後援——`apply_ecpay_payment` 本身冪等，兩邊都做也只會算一次錢。

**Files:**
- Create: `shop/src/app/api/ecpay/result/route.js`
- Reference: `git show feature/ecpay-integration:shop/src/app/api/ecpay/result/route.js`

**Interfaces:** 同 C2，另 Produces: `POST|GET /api/ecpay/result` → 303 導向 `/order/:id?paid=0|1`

- [ ] **Step 1: 取分支原檔當基底**

```bash
mkdir -p shop/src/app/api/ecpay/result
git show feature/ecpay-integration:shop/src/app/api/ecpay/result/route.js \
  > shop/src/app/api/ecpay/result/route.js
```

- [ ] **Step 2: 套用與 C2 相同的四項改動**

1. 刪掉 `SITE_URL` module 常數；導回網址改用 `new URL(request.url).origin`（消費者原本所在的店家網域）。
2. 反查店家取 config、驗章，與 C2 完全相同的寫法（用 `MerchantTradeNo` 查 `ecpay_transactions`）。
3. 留底的 `source` 用 `'payment_result'` 以區隔 `notify`。
4. 把「驗章通過就 `update payment_status='已付清'`」整段換成呼叫 `apply_ecpay_payment`（參數同 C2）。
5. `orderId` 改用反查到的 `txn.order_id` 為主、`data.CustomField1` 為備援；導向改成 `${origin}/order/${orderId}?paid=${paid}`。

- [ ] **Step 3: Commit**

```bash
git add shop/src/app/api/ecpay/result/route.js
git commit -m "feat: 付款導回頁——同樣驗章記帳當 notify 後援"
```

---

### Task C4: 電子地圖 `logistics/map` 與 `logistics/map-reply`

分支用彈窗＋`postMessage`，本專案改成**整頁導轉＋sessionStorage 草稿**（LINE 內建瀏覽器與手機常擋彈窗，被擋就是結帳直接卡死）。`map-reply` 從「回一段 postMessage 的 HTML」改成「302 導回結帳頁並把門市資訊帶在 query」。

這兩支的 `ServerReplyURL` 用**請求當下的 origin**，不是固定回呼網域——這是消費者互動導轉，跟著原網域走才會導回對的店。

**Files:**
- Create: `shop/src/app/api/ecpay/logistics/map/route.js`
- Create: `shop/src/app/api/ecpay/logistics/map-reply/route.js`
- Create: `shop/src/lib/checkoutDraft.js`
- Test: `shop/src/lib/checkoutDraft.test.js`

**Interfaces:**
- Produces:
  - `GET /api/ecpay/logistics/map?subtype=<X>&storeId=<N>` → 自動送出表單導到綠界電子地圖
  - `POST /api/ecpay/logistics/map-reply` → 303 導回 `/checkout?cvs_store_id=…&cvs_store_name=…&cvs_address=…&cvs_subtype=…`
  - `CHECKOUT_DRAFT_KEY: string`
  - `saveCheckoutDraft(storage, form) -> void`
  - `readCheckoutDraft(storage) -> object|null`（讀完即清除，避免殘留舊資料）
  - `cvsFromSearchParams(searchParams) -> { cvs_store_id, cvs_store_name, cvs_address, shipping_subtype }|null`

- [ ] **Step 1: 寫草稿純函式的失敗測試**

建立 `shop/src/lib/checkoutDraft.test.js`：

```js
import { describe, it, expect, beforeEach } from 'vitest'
import {
  CHECKOUT_DRAFT_KEY, saveCheckoutDraft, readCheckoutDraft, cvsFromSearchParams,
} from './checkoutDraft'

function fakeStorage() {
  const m = new Map()
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    _map: m,
  }
}

describe('checkout 草稿', () => {
  let s
  beforeEach(() => { s = fakeStorage() })

  it('存了之後讀得回來', () => {
    saveCheckoutDraft(s, { name: '王小明', phone: '0912' })
    expect(readCheckoutDraft(s)).toEqual({ name: '王小明', phone: '0912' })
  })

  it('讀完就清掉，避免下次結帳被舊資料汙染', () => {
    saveCheckoutDraft(s, { name: '王小明' })
    readCheckoutDraft(s)
    expect(readCheckoutDraft(s)).toBe(null)
    expect(s.getItem(CHECKOUT_DRAFT_KEY)).toBe(null)
  })

  it('沒有草稿時回 null', () => {
    expect(readCheckoutDraft(s)).toBe(null)
  })

  it('草稿壞掉時回 null 而不是丟例外', () => {
    s.setItem(CHECKOUT_DRAFT_KEY, '{壞掉的 JSON')
    expect(readCheckoutDraft(s)).toBe(null)
  })

  it('storage 不可用時不炸（SSR / 隱私模式）', () => {
    expect(() => saveCheckoutDraft(null, { a: 1 })).not.toThrow()
    expect(readCheckoutDraft(null)).toBe(null)
  })
})

describe('cvsFromSearchParams', () => {
  it('帶了門市代碼就解析出門市資訊', () => {
    const p = new URLSearchParams({
      cvs_store_id: '131386', cvs_store_name: '龍安門市',
      cvs_address: '台北市…', cvs_subtype: 'UNIMARTC2C',
    })
    expect(cvsFromSearchParams(p)).toEqual({
      cvs_store_id: '131386',
      cvs_store_name: '龍安門市',
      cvs_address: '台北市…',
      shipping_subtype: 'UNIMARTC2C',
    })
  })

  it('沒有門市代碼就回 null', () => {
    expect(cvsFromSearchParams(new URLSearchParams({ foo: 'bar' }))).toBe(null)
  })

  it('子類型不在白名單時不採信（避免被塞任意值）', () => {
    const p = new URLSearchParams({ cvs_store_id: '1', cvs_subtype: 'EVIL' })
    expect(cvsFromSearchParams(p).shipping_subtype).toBe(null)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run shop/src/lib/checkoutDraft.test.js`
Expected: FAIL —— 找不到模組

- [ ] **Step 3: 寫 `checkoutDraft.js`**

```js
// 結帳表單草稿：去綠界選門市要整頁導轉，離開前把表單存起來，回來再還原。
// （不用彈窗——LINE 內建瀏覽器與手機常擋彈窗，被擋就是結帳直接卡死。）
import { CVS_SUBTYPES } from './ecpay'

export const CHECKOUT_DRAFT_KEY = 'daigogo-checkout-draft'

export function saveCheckoutDraft(storage, form) {
  try {
    storage?.setItem(CHECKOUT_DRAFT_KEY, JSON.stringify(form))
  } catch {
    // 隱私模式或配額滿：選門市仍可進行，只是回來要重填，不該讓整頁爆掉
  }
}

/** 讀取並清除草稿（一次性，避免下次結帳被舊資料汙染） */
export function readCheckoutDraft(storage) {
  try {
    const raw = storage?.getItem(CHECKOUT_DRAFT_KEY)
    if (!raw) return null
    storage.removeItem(CHECKOUT_DRAFT_KEY)
    return JSON.parse(raw)
  } catch {
    try { storage?.removeItem(CHECKOUT_DRAFT_KEY) } catch {}
    return null
  }
}

/** 從導回的 query 解析門市資訊；沒有門市代碼就回 null */
export function cvsFromSearchParams(searchParams) {
  const id = searchParams.get('cvs_store_id')
  if (!id) return null
  const subtype = searchParams.get('cvs_subtype')
  return {
    cvs_store_id: id,
    cvs_store_name: searchParams.get('cvs_store_name') || '',
    cvs_address: searchParams.get('cvs_address') || '',
    shipping_subtype: CVS_SUBTYPES.includes(subtype) ? subtype : null,
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run shop/src/lib/checkoutDraft.test.js`
Expected: PASS

- [ ] **Step 5: 寫 `map` route**

```bash
mkdir -p shop/src/app/api/ecpay/logistics/map shop/src/app/api/ecpay/logistics/map-reply
```

`shop/src/app/api/ecpay/logistics/map/route.js`：

```js
// 電子地圖：回自動送出表單，整頁導轉到綠界門市地圖讓消費者選店。
// 選完綠界會 POST 到 map-reply，那支再把消費者導回結帳頁。
// ServerReplyURL 用請求當下的 origin（這是消費者互動導轉，不是背景通知），
// 才會導回消費者原本所在的店家網域。
import { getEcpayConfigForStore } from '../../../../../lib/ecpayStore'
import { buildAutoSubmitForm, CVS_SUBTYPES } from '../../../../../lib/ecpay'

export const dynamic = 'force-dynamic'

export async function GET(request) {
  const url = new URL(request.url)
  const subtype = url.searchParams.get('subtype') || 'UNIMARTC2C'
  const storeId = url.searchParams.get('storeId')
  const device = url.searchParams.get('device') === '1' ? 1 : 0

  if (!CVS_SUBTYPES.includes(subtype)) {
    return new Response('invalid subtype', { status: 400 })
  }

  const cfg = await getEcpayConfigForStore(storeId)
  if (!cfg) return new Response('此店家尚未設定綠界金鑰', { status: 400 })

  // 電子地圖需要唯一 MerchantTradeNo（此時尚未建單，用臨時值）
  const tradeNo = `MAP${Date.now().toString(36).toUpperCase()}`.slice(0, 20)
  const origin = new URL(request.url).origin

  const params = {
    MerchantID: cfg.logisticsMerchantId,
    MerchantTradeNo: tradeNo,
    LogisticsType: 'CVS',
    LogisticsSubType: subtype,
    IsCollection: 'N',   // 是否代收於建立物流單時才決定，此處僅選店
    ServerReplyURL: `${origin}/api/ecpay/logistics/map-reply`,
    Device: device,
  }

  const html = buildAutoSubmitForm(cfg.urls.logisticsMap, params, { title: '開啟門市地圖...' })
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}
```

- [ ] **Step 6: 寫 `map-reply` route**

`shop/src/app/api/ecpay/logistics/map-reply/route.js`：

```js
// 電子地圖 ServerReplyURL：綠界選完門市後 POST 回門市資訊。
// 導回結帳頁並把門市資訊帶在 query，結帳頁再從 sessionStorage 還原表單。
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST(request) {
  const form = await request.formData()
  const origin = new URL(request.url).origin

  const q = new URLSearchParams({
    cvs_store_id: form.get('CVSStoreID') || '',
    cvs_store_name: form.get('CVSStoreName') || '',
    cvs_address: form.get('CVSAddress') || '',
    cvs_subtype: form.get('LogisticsSubType') || '',
  })

  return NextResponse.redirect(`${origin}/checkout?${q.toString()}`, 303)
}
```

- [ ] **Step 7: Commit**

```bash
git add shop/src/lib/checkoutDraft.js shop/src/lib/checkoutDraft.test.js \
        shop/src/app/api/ecpay/logistics/map shop/src/app/api/ecpay/logistics/map-reply
git commit -m "feat: 電子地圖選店改整頁導轉，表單草稿存 sessionStorage"
```

---

### Task C5: 物流建單 `logistics/create`

由後台按鈕觸發（代購是先收單後調貨，下單當下未必有貨，不可自動建單）。**這支會實際扣綠界帳戶餘額。**

**Files:**
- Create: `shop/src/app/api/ecpay/logistics/create/route.js`
- Reference: `git show feature/ecpay-integration:shop/src/app/api/ecpay/logistics/create/route.js`

**Interfaces:**
- Produces: `POST /api/ecpay/logistics/create` body `{ orderId }` → `{ ok, allPayLogisticsID, cvsPaymentNo, cvsValidationNo, rtnCode, rtnMsg }` 或 `{ ok: false, error }`

- [ ] **Step 1: 取分支原檔當基底**

```bash
mkdir -p shop/src/app/api/ecpay/logistics/create
git show feature/ecpay-integration:shop/src/app/api/ecpay/logistics/create/route.js \
  > shop/src/app/api/ecpay/logistics/create/route.js
```

- [ ] **Step 2: 改成多租戶**

六項改動：

1. 取訂單改用 `loadOrderForEcpay(orderId, 'id, store_id, total_amount, payment_method, shipping_subtype, cvs_store_id, customer_name, phone, email, items, allpay_logistics_id')`。
2. 刪掉 `SENDER_NAME`／`SENDER_PHONE`／`BASE_URL` 三個 module 常數，改用 `cfg.senderName`／`cfg.senderPhone`／`callbackBaseUrl()`。寄件人缺一即擋下：

```js
if (!cfg.senderName || !cfg.senderPhone) {
  return fail('此店家尚未設定綠界寄件人資訊')
}
```

3. `COD_MAX` 改讀該店設定（`stores.settings.ecpay_cod_max`，預設 20000）。取法：在 `loadOrderForEcpay` 的 columns 加不上，改為額外查一次 `stores`，或直接用 `cfg` 上新增的欄位——**採後者**，在 A1 的 `makeEcpayConfig` 已把 `cod_max` 帶進來的話用 `cfg.codMax`；若 A1 沒帶，在此 route 內用 `secrets.cod_max`。為避免相依歧義，本任務統一改成：在 `makeEcpayConfig` 回傳物件補一行 `codMax: Number(secrets?.cod_max) || COD_MAX_DEFAULT`，並在 A1 的測試補一則斷言（`makeEcpayConfig(null).codMax === 20000`）。
4. `ServerReplyURL` 用 `${callbackBaseUrl() || new URL(request.url).origin}/api/ecpay/logistics/notify`——這是**背景通知**，用固定網域。
5. `MerchantID: cfg.logisticsMerchantId`、`genLogisticsCheckMac(params, cfg)`、`fetch(cfg.urls.logisticsCreate, …)`。
6. 建單成功後回填的欄位不變（`allpay_logistics_id`／`cvs_payment_no`／`cvs_validation_no`／`ecpay_logistics_trade_no`），但**訂單狀態不要動**——狀態機的決策是物流只在取件完成時推「完成」，建單本身不改主狀態。若分支原檔有 `status: '已出貨'` 之類的寫入，刪掉。

- [ ] **Step 3: 確認 CORS**

後台（Vite，不同網域）會跨域呼叫這支。確認 route 有 `OPTIONS` handler 與 `Access-Control-Allow-Origin`。分支原檔已加過 CORS，若被上述改動弄丟就補回；`Allow-Origin` 讀 `process.env.ADMIN_ORIGIN`，未設定則回 `*`（此端點不吐機密，只吐物流編號）。

- [ ] **Step 4: Commit**

```bash
git add shop/src/app/api/ecpay/logistics/create/route.js shop/src/lib/ecpay.js shop/src/lib/ecpay.test.js
git commit -m "feat: 物流建單改用每店金鑰與寄件人"
```

---

### Task C6: 物流狀態回呼 `logistics/notify`

依狀態機決策：**只在取件完成時把主狀態推到「完成」**，不新增「待取貨」「退貨/未取」兩個狀態值（那會波及六個檔案與報表）。到店與退回只寫進物流欄位。

**Files:**
- Create: `shop/src/app/api/ecpay/logistics/notify/route.js`
- Reference: `git show feature/ecpay-integration:shop/src/app/api/ecpay/logistics/notify/route.js`

**Interfaces:**
- Consumes: A1 `logisticsMilestone`／`verifyCheckMacValue`；B2 `apply_cod_payment`
- Produces: `POST /api/ecpay/logistics/notify` → `1|OK` / `0|CheckMacValue Error`

- [ ] **Step 1: 取分支原檔當基底**

```bash
mkdir -p shop/src/app/api/ecpay/logistics/notify
git show feature/ecpay-integration:shop/src/app/api/ecpay/logistics/notify/route.js \
  > shop/src/app/api/ecpay/logistics/notify/route.js
```

- [ ] **Step 2: 改成多租戶＋收斂狀態機**

1. 用 `AllPayLogisticsID` 或 `MerchantTradeNo` 反查 `consumer_orders`（`allpay_logistics_id` 已有索引）拿到 `store_id`，再 `getEcpayConfigForStore` 取 config，用 `verifyCheckMacValue(data, { hashKey: cfg.logisticsHashKey, hashIV: cfg.logisticsHashIV, algo: 'md5' })` 驗章。**物流用 md5，不是 sha256。**
2. 留底 `source: 'logistics_reply'`，驗章失敗也要寫。
3. 狀態推進改成：

```js
const update = {
  logistics_status: data.RtnCode != null ? String(data.RtnCode) : null,
  logistics_status_msg: data.RtnMsg || null,
  logistics_status_at: new Date().toISOString(),
}

const milestone = logisticsMilestone(data.RtnCode, data.RtnMsg)
// 到店/退回只寫物流欄位，不動訂單主狀態——後台會據此亮警示，由店家決定
if (milestone === 'picked') {
  update.status = '完成'
}
await supabaseAdmin.from('consumer_orders').update(update).eq('id', order.id)

// 貨到付款：消費者取件＝綠界代收完成 → 補滿 paid_amount（冪等）
if (milestone === 'picked' && order.payment_method === 'cod') {
  await supabaseAdmin.rpc('apply_cod_payment', { p_order_id: order.id })
}
```

刪掉分支原檔裡寫 `'待取貨'`／`'退貨/未取'` 的兩個分支，以及直接 `update.payment_status = '已付清'` 那行（會被 trigger 蓋掉）。

- [ ] **Step 3: Commit**

```bash
git add shop/src/app/api/ecpay/logistics/notify/route.js
git commit -m "feat: 物流回呼——取件才推完成，貨到付款經 RPC 記帳"
```

---

### Task C7: 列印託運單 `logistics/print/[orderId]`

**Files:**
- Create: `shop/src/app/api/ecpay/logistics/print/[orderId]/route.js`
- Reference: `git show 'feature/ecpay-integration:shop/src/app/api/ecpay/logistics/print/[orderId]/route.js'`

**Interfaces:**
- Produces: `GET /api/ecpay/logistics/print/:orderId` → 自動送出表單，在新分頁開啟綠界產生的單據

- [ ] **Step 1: 取分支原檔當基底**

```bash
mkdir -p 'shop/src/app/api/ecpay/logistics/print/[orderId]'
git show 'feature/ecpay-integration:shop/src/app/api/ecpay/logistics/print/[orderId]/route.js' \
  > 'shop/src/app/api/ecpay/logistics/print/[orderId]/route.js'
```

- [ ] **Step 2: 改成多租戶**

三項改動：取訂單改用 `loadOrderForEcpay(params.orderId, 'id, store_id, shipping_subtype, allpay_logistics_id, cvs_payment_no, cvs_validation_no')`；`MerchantID: cfg.logisticsMerchantId`、`genLogisticsCheckMac(printParams, cfg)`；`getPrintUrl(order.shipping_subtype, cfg)`。其餘（7-ELEVEN 才帶 `CVSValidationNo`、不可用 iframe）不動。

- [ ] **Step 3: Commit**

```bash
git add 'shop/src/app/api/ecpay/logistics/print/[orderId]/route.js'
git commit -m "feat: 列印託運單改用每店物流金鑰"
```

---

## Phase D —— UI（D1/D2/D3 可並行，D4 依 A2，D5 依 C5+C7）

### Task D1: 結帳頁

在 main 現行的 `checkout/page.jsx`（763 行，已含加購併單與組合折扣）上重接，**不要 merge 分支版**。

**Files:**
- Modify: `shop/src/app/checkout/page.jsx`

**Interfaces:**
- Consumes: C4 的 `saveCheckoutDraft`／`readCheckoutDraft`／`cvsFromSearchParams`；A1 的 `CVS_SUBTYPES`

- [ ] **Step 1: 讀懂現況再動手**

```bash
sed -n '1,140p' shop/src/app/checkout/page.jsx     # state 與 store 設定
sed -n '230,360p' shop/src/app/checkout/page.jsx   # validate 與 place_order 呼叫
sed -n '530,620p' shop/src/app/checkout/page.jsx   # 表單欄位渲染
```

現行只有超商取貨一種配送方式，且是手填 `store_name`／`store_number`。**這兩個欄位必須保留**——沒設綠界金鑰的店家（另外兩家）只剩這條路，拿掉就是功能退化。

- [ ] **Step 2: 擴充 form state 與付款/配送選項**

`form` 初始值加入：

```js
payment_method: 'remittance',    // 'credit' | 'cod' | 'remittance'
shipping_subtype: 'UNIMARTC2C',
cvs_store_id: '', cvs_store_name: '', cvs_address: '',
```

依店家設定決定可選項（沒設綠界就完全不出現綠界相關選項）：

```js
const ecpayReady = !!store?.settings?.ecpay_set
const codMax = Number(store?.settings?.ecpay_cod_max) || 20000
const remitConfigured = !!store?.settings?.remit_account

const payOptions = [
  ...(ecpayReady ? [{ value: 'credit', zh: '信用卡線上付款', en: 'Credit card' }] : []),
  ...(ecpayReady ? [{ value: 'cod', zh: '貨到付款', en: 'Cash on delivery' }] : []),
  ...(remitConfigured ? [{ value: 'remittance', zh: '銀行匯款', en: 'Bank transfer' }] : []),
]
```

`payOptions` 為空時（店家兩者都沒設）維持現行匯款流程，不可讓消費者無法結帳。預設值取 `payOptions[0]?.value ?? 'remittance'`。

- [ ] **Step 3: 選門市：整頁導轉＋草稿還原**

```js
function goPickStore() {
  saveCheckoutDraft(window.sessionStorage, form)
  const isMobile = /Mobi|Android/i.test(navigator.userAgent)
  window.location.href =
    `/api/ecpay/logistics/map?subtype=${form.shipping_subtype}&storeId=${storeId}&device=${isMobile ? 1 : 0}`
}

// 從綠界選完店導回：還原草稿並套上門市
useEffect(() => {
  const cvs = cvsFromSearchParams(new URLSearchParams(window.location.search))
  if (!cvs) return
  const draft = readCheckoutDraft(window.sessionStorage)
  setForm(f => ({
    ...f, ...(draft || {}),
    cvs_store_id: cvs.cvs_store_id,
    cvs_store_name: cvs.cvs_store_name,
    cvs_address: cvs.cvs_address,
    shipping_subtype: cvs.shipping_subtype || f.shipping_subtype,
  }))
  window.history.replaceState({}, '', '/checkout')   // 清掉 query，重整不會重跑
}, [])
```

換超商子類型時要清掉已選門市（不同通路的門市代碼不通用）。

- [ ] **Step 4: 驗證規則**

- `remittance`：維持現行的後五碼必填（5 位數字）
- `credit`／`cod`：後五碼不必填
- `credit`／`cod`：`cvs_store_id` 必填（走綠界選店）
- 未走綠界（`payment_method === 'remittance'` 且沒選門市）：維持現行 `store_name`／`store_number` 必填
- `cod` 且 `total > codMax`：擋下並提示改用其他付款方式

- [ ] **Step 5: 送單與導轉**

`place_order` 的呼叫**保留現有全部參數**（加購、組合折扣、優惠券那些都不能動），只追加五個：

```js
p_payment_method: form.payment_method,
p_shipping_subtype: form.cvs_store_id ? form.shipping_subtype : null,
p_cvs_store_id: form.cvs_store_id || null,
p_cvs_store_name: form.cvs_store_name || null,
p_cvs_address: form.cvs_address || null,
```

走綠界選店時，`p_store_name`／`p_store_number`／`p_address` 改帶門市資訊（沿用既有欄位，後台與通知信不必改）；沒走綠界則維持手填值。

送出後：

```js
clearCart()
if (form.payment_method === 'credit') {
  window.location.href = `/api/ecpay/credit/${orderId}`
} else {
  router.push(`/order/${orderId}`)
}
```

**不要**移植分支的 `/api/revalidate-stock` 呼叫——main 已用 `api/revalidate` ＋ `useFreshStock` 解決同一件事。

- [ ] **Step 6: 跑測試＋手動驗證**

Run: `npx vitest run`
Expected: 全過

手動：`cd shop && npm run dev`，走一次匯款結帳確認沒被打壞（這是回歸重點——現行唯一的結帳路徑）。

- [ ] **Step 7: Commit**

```bash
git add shop/src/app/checkout/page.jsx
git commit -m "feat: 結帳頁支援綠界付款方式與電子地圖選店"
```

---

### Task D2: 訂單頁與會員中心（重新付款）

**Files:**
- Modify: `shop/src/app/order/[id]/page.jsx`
- Modify: `shop/src/app/account/page.jsx`

- [ ] **Step 1: 訂單頁顯示付款/物流資訊**

顯示付款方式（`credit`→信用卡、`cod`→貨到付款、`remittance`→銀行匯款）、超商門市（`cvs_store_name` + `cvs_store_id`）、物流狀態（`logistics_status_msg`）。匯款訂單維持現行的匯款帳戶顯示。

- [ ] **Step 2: 未付訂單顯示「重新付款」**

條件：`payment_method === 'credit'` 且 `paid_amount < total_amount` 且 `status !== '已取消'`。按鈕導向 `/api/ecpay/credit/${orderId}`（該 route 會自己算未付餘額，前端不必算）。

這同時涵蓋兩個場景：棄單後想再付、加購後補差額。

- [ ] **Step 3: 會員中心同樣加按鈕**

`account/page.jsx` 的訂單列表，未付信用卡訂單加同一個入口。

- [ ] **Step 4: Commit**

```bash
git add 'shop/src/app/order/[id]/page.jsx' shop/src/app/account/page.jsx
git commit -m "feat: 訂單頁與會員中心顯示付款資訊並支援重新付款"
```

---

### Task D3: 訂單確認信依付款方式分流

**Files:**
- Modify: `shop/src/app/api/send-order-email/route.js`

- [ ] **Step 1: 依付款方式給不同指示**

- `remittance`：維持現行——顯示匯款帳戶（用下單當下的店家設定快照，避免店家日後改帳戶影響舊信）與後五碼回報提示
- `credit`：顯示「已完成線上付款」或「尚未付款，可從訂單頁重新付款」（依 `paid_amount` 判斷）
- `cod`：顯示「取貨時付現」與門市資訊，**不要**顯示匯款帳戶

門市資訊（`cvs_store_name`／`cvs_address`）在有值時一律顯示。

- [ ] **Step 2: Commit**

```bash
git add shop/src/app/api/send-order-email/route.js
git commit -m "feat: 訂單確認信依付款方式分流"
```

---

### Task D4: 後台綠界設定區塊

抄 `SettingsPage.jsx` 裡 LINE 那個區塊的既有寫法：一般欄位存 `settings`、機密走 RPC 且**存後不回顯**（placeholder 顯示「已設定」／「未設定」）。

**Files:**
- Modify: `src/pages/SettingsPage.jsx`

- [ ] **Step 1: 讀既有 LINE 區塊當範本**

```bash
sed -n '20,40p;95,120p;425,470p' src/pages/SettingsPage.jsx
```

- [ ] **Step 2: 加「綠界金物流」區塊**

只有平台管理員看得到（沿用該頁既有的權限判斷方式；若頁面沒有現成的平台管理員旗標，用 `useAuth()` 取得的角色判斷）。欄位：

| 欄位 | 型態 | 說明 |
|---|---|---|
| 環境 | select | 測試（stage）／正式（production） |
| 金流特店編號 | text | |
| 金流 HashKey | password，寫入型 | 已設定時 placeholder 顯示「已設定（輸入新值可更新，留空維持不變）」 |
| 金流 HashIV | password，寫入型 | 同上 |
| 物流特店編號 | text | 與金流不同，綠界另外申請 |
| 物流 HashKey | password，寫入型 | |
| 物流 HashIV | password，寫入型 | |
| 寄件人姓名 | text | 物流建單必填 |
| 寄件人手機 | text | 物流建單必填 |
| 貨到付款上限 | number | 預設 20000，綠界 C2C 代收上限 |

儲存時呼叫：

```js
const { error } = await supabase.rpc('set_store_ecpay_credentials', {
  p_store_id: storeId,
  p_env: ecpayForm.env,
  p_merchant_id: ecpayForm.merchant_id,
  p_hash_key: ecpayForm.hash_key,          // 留空＝維持原值
  p_hash_iv: ecpayForm.hash_iv,
  p_logistics_merchant_id: ecpayForm.logistics_merchant_id,
  p_logistics_hash_key: ecpayForm.logistics_hash_key,
  p_logistics_hash_iv: ecpayForm.logistics_hash_iv,
  p_sender_name: ecpayForm.sender_name,
  p_sender_phone: ecpayForm.sender_phone,
  p_cod_max: Number(ecpayForm.cod_max) || 20000,
})
```

儲存後把四個機密欄位的 input 清空（值只進不出），並依 `settings.ecpay_set` 更新「已設定」標示。

區塊底部加一行說明：金流與物流是綠界分開申請的兩組金鑰；正式環境請確認已在綠界後台完成撥款帳戶設定。

- [ ] **Step 3: 手動驗證**

`npm run dev` → 登入後台 → 設定頁 → 填入綠界公開測試金鑰 → 儲存 → 重整後應顯示「已設定」且欄位為空。

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54332/postgres" -c \
  "select store_id, env, merchant_id, sender_name, cod_max from public.store_ecpay_secrets;"
```

- [ ] **Step 4: Commit**

```bash
git add src/pages/SettingsPage.jsx
git commit -m "feat: 後台綠界金物流設定區塊"
```

---

### Task D5: 後台訂單詳情——物流操作與付款資訊

分支把這段寫在 `OrdersPage.jsx`，但 main 已把 `ConsumerOrderDetailSheet` 抽成獨立元件（`InboxPage` 也在用），所以要搬到新位置。

**Files:**
- Modify: `src/components/ConsumerOrderDetailSheet.jsx`
- Reference: `git diff $(git merge-base main feature/ecpay-integration) feature/ecpay-integration -- src/pages/OrdersPage.jsx`

- [ ] **Step 1: 加付款資訊顯示**

付款方式標籤（`{ credit: '信用卡', cod: '貨到付款', remittance: '銀行匯款' }`）、綠界交易編號、物流狀態訊息。付款狀態徽章對 `cod` 未收款時顯示「貨到付款」而非誤導的「未付」。

`payment_alert` 不為空時，在詳情最上方顯示紅色警示條（這是「已收款但庫存不足」的人工處理入口，不能藏在下面）。

- [ ] **Step 2: 加「建立物流單」按鈕**

顯示條件：有 `cvs_store_id` 且尚無 `allpay_logistics_id`。

```js
const SHOP_URL = import.meta.env.VITE_SHOP_URL || 'http://localhost:3000'
// 建單會實際扣綠界帳戶餘額，必須二次確認
if (!window.confirm('確定向綠界建立物流單？建立後物流費將從綠界帳戶餘額扣除。')) return
const res = await fetch(`${SHOP_URL}/api/ecpay/logistics/create`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ orderId: o.id }),
})
```

- [ ] **Step 3: 加「列印託運單」按鈕**

顯示條件：已有 `allpay_logistics_id`。`window.open(`${SHOP_URL}/api/ecpay/logistics/print/${o.id}`, '_blank')`（不可用 iframe，會被綠界的導轉阻擋）。

- [ ] **Step 4: 取消訂單時的退款提醒**

沿用分支的做法：取消已付款訂單時，依付款方式提示不同的退款途徑（信用卡→綠界後台退刷、匯款→手動匯款、貨到付款→尚未收款不必退），並要求二次確認。系統不會自動退款。

- [ ] **Step 5: 手動驗證**

後台開一筆有門市資訊的測試訂單，確認按鈕出現／隱藏的條件正確。**先不要真的按建單**（會扣綠界餘額），留到 Phase E 的端對端測試。

- [ ] **Step 6: Commit**

```bash
git add src/components/ConsumerOrderDetailSheet.jsx
git commit -m "feat: 後台訂單詳情加物流建單/列印與付款警示"
```

---

## Phase E —— 上線

### Task E1: 套用 migration 到 remote

- [ ] **Step 1: 先比對 remote 現況**

```
mcp__supabase__list_migrations
```

確認四支新 migration 都不在 remote。**注意 remote 有 5 支 repo 沒有的 migration，這是已知漂移，不要試圖「修正」。**

- [ ] **Step 2: 逐支用 MCP 套用**

用 `mcp__supabase__apply_migration`，依序套 `20260812100000` → `100100` → `100200` → `100300`。**絕不執行 `supabase db push`。**

- [ ] **Step 3: 驗證**

```sql
select to_regclass('public.store_ecpay_secrets'),
       to_regclass('public.ecpay_transactions'),
       to_regclass('public.ecpay_payment_logs');
select jobname, schedule from cron.job where jobname = 'ecpay-abandon-sweep';
select proname from pg_proc where proname in
  ('release_order','cancel_abandoned_credit_orders','apply_ecpay_payment','apply_cod_payment','create_ecpay_transaction','set_store_ecpay_credentials');
```

- [ ] **Step 4: 確認 RLS 在 remote 也有效**

```
mcp__supabase__get_advisors  (type: security)
```

確認沒有針對 `store_ecpay_secrets` 的新警告。

---

### Task E2: stage 端對端測試

- [ ] **Step 1: 設定環境**

Vercel 商城專案加環境變數 `ECPAY_CALLBACK_BASE_URL=https://daigogotw.com`，確認 `SUPABASE_SECRET_KEY` 已設定。部署。

後台設定頁填入綠界**公開測試金鑰**（金流 2000132／物流 2000933），環境選「測試」。

- [ ] **Step 2: 信用卡成功路徑**

下單 → 導轉綠界 → 用綠界測試卡付款 → 確認：訂單 `paid_amount` 等於訂單金額、`payment_status` 為「已付清」、`ecpay_transactions` 有一列 `status='paid'`、`ecpay_payment_logs` 有 `payment_notify` 且 `mac_valid=true`。

- [ ] **Step 3: 棄單與遲到補救**

下單信用卡但不付款 → 等排程（或手動 `select public.cancel_abandoned_credit_orders(0)`）→ 確認訂單被取消、庫存還原。再從訂單頁按「重新付款」完成付款 → 確認訂單復活、庫存重新扣除、金額正確。

- [ ] **Step 4: 重複通知冪等**

手動重送一次 `notify`（或觀察綠界自動重試）→ 確認 `paid_amount` 沒有變成兩倍。

- [ ] **Step 5: 超商選店與物流**

結帳選門市 → 確認整頁導轉後表單有還原、門市有帶回。後台建立物流單（stage 環境不扣真錢）→ 列印託運單 → 確認頁面能開。

- [ ] **Step 6: 貨到付款**

下 cod 訂單 → 建物流單確認 `IsCollection=Y` 與 `CollectionAmount` 正確 → 模擬取件回呼 → 確認 `paid_amount` 補滿、狀態變「完成」。

- [ ] **Step 7: 未設金鑰的店家不受影響**

用 `daigoking` 或 `spirit` 的網址進結帳頁 → 確認完全看不到綠界選項，手填店名店號＋匯款的流程照常可用。**這是最重要的回歸測試**——另外兩家客戶還沒申請綠界，不能被這次改動波及。

---

### Task E3: 換正式金鑰上線

- [ ] **Step 1: 後台填入 Daigogo 的正式金鑰**

設定頁 → 環境改「正式」→ 填入正式的金流與物流金鑰。**金鑰只在瀏覽器到 DB 之間流動，不進 git、不進對話、不寫進任何檔案。**

- [ ] **Step 2: 小額真實測試**

用最低金額（例如 1 元商品）下一筆真實信用卡訂單，走完整流程並確認綠界後台看得到該筆交易。確認後在綠界後台退刷。

- [ ] **Step 3: 更新文件**

- `docs/architecture.md` 補綠界串接的機制說明（金鑰存放、回呼網址規則、收款記帳的三個不變量）
- `docs/TODO.md` 刪掉 `feature/ecpay-integration` 那一項，改成剩餘待辦（另外兩家店開通、ATM 虛擬帳號、宅配）
- 這份計畫檔標記完成

- [ ] **Step 4: 合併回 main**

依 superpowers:finishing-a-development-branch 決定合併方式。合併後舊分支 `feature/ecpay-integration` 才可刪除。

---

## 自我檢查

**範圍覆蓋：** 金流信用卡（C1/C2/C3）、超商 C2C 物流含取貨付款（C4/C5/C6/C7）、多租戶金鑰（A2/B3/D4）、棄單與漏款防護（B1/B2）、一張訂單多筆交易（A3/B2/C1/D2）、狀態機收斂（C6）、cod 金額上限（A2 的 `cod_max` → C5/D1）、結帳整頁導轉（C4/D1）、回呼網址規則（貫穿 Phase C）、上線（E1/E2/E3）。共識中的每一項都有對應任務。

**已知的跨任務相依（實作時要注意）：** C5 需要 `makeEcpayConfig` 回傳 `codMax`，該欄位在 A1 的規格中沒列出——C5 的 Step 2 第 3 點已指明要回頭補進 A1 的檔案與測試。若 A1 與 C5 由不同 agent 並行執行，C5 負責這次補寫。

**未涵蓋（刻意排除）：** ATM 虛擬帳號、超商代碼繳費、宅配、綠界退刷 API、B2C 物流、cod 資格限制、另外兩家店的開通。
