# TODO

> 這是專案唯一的待辦清單。2026-08-01 從八份計畫文件挖掘整併，逐項對照程式碼與 migration 驗證過，
> 已完成的都拿掉了。原始文件在 `docs/archive/`，只保留決策脈絡。
>
> **維護規則**：做完就從這裡刪掉，不要留「✅ 已完成」—— 那會讓清單越長越沒人想看。
> 需要保留脈絡的，寫進 `docs/architecture.md` 或該功能的 commit message。

---

## 〇、進行中：2026-08-05 這一批

四項使用者回饋拆成五份 spec，三條 track 平行開發，各自 git worktree。
設計在 `docs/superpowers/specs/`，檔名前綴對應下表：

| | 內容 | 分支 | 相依 |
|---|---|---|---|
| S1 | 客服收件匣的訂單詳情 popup | `feat/inbox-order-detail` | — |
| S2 | 客服對話依會員彙整（多裝置併成一列） | `feat/inbox-conversation-merge` | 等 S1 合併 |
| S3 | 組合商品：規格連動照片＋缺貨呈現 | `feat/bundle-variant-images` | — |
| S4 | 賣完的不能再被選（庫存新鮮度＋結帳前檢查） | `feat/stock-freshness` | 等 S3 合併 |
| S5 | 商品頁編排改用欄容器版面模型 | `feat/product-page-columns` | — |

S5 第一階段不做預覽 iframe 內的直接拖放，那留成後續。
五支全部驗收通過並合併回 `main` 之後，這一節整個刪掉。

---

## 一、做完但沒上線的分支

四個分支有未合併的工作。這是目前最大的一塊 —— 程式碼已經存在，價值卡在合併這一步。

### 1. `feature/ecpay-integration` — 綠界金流＋物流（12 commits，最後 2026-06-25）

main **完全沒有** ECPay 程式碼，但 `shop/.env.local` 的 `ECPAY_*` 已經設好了。分支上有完整的
API routes（`shop/src/app/api/ecpay/` 八支：付款 notify/result、超商電子地圖、物流建單/回呼/列印）、
`shop/src/lib/ecpay.js` 檢查碼實作、金流 rollback（`release_order`／棄單清理）。

- **合併前必須處理 migration 撞號**：分支有 `20250028_ecpay_payment_logistics.sql`，
  main 有 `20250028_accept_invitation_by_email.sql`。同編號不同內容，直接合會亂。要重新編號到 `20250060+`。
- 分支落後 main 一個多月（其間 main 改了付款狀態設計、訂單加購、行程拆賬），衝突不會小。
- 合併後仍需真機測試：綠界回呼要對外網址，本機得用 ngrok 之類的隧道。

### 2. `feat/threads-line-integration` — Threads 收單串接（2 commits，最後 2026-07-14）

有 `Threads 留言 +1 收單串接（OAuth／webhook／token 刷新＋後台綁定）` 的實作。

- **但 `docs/archive/threads-order-intake-plan.md` 在 2026-07-13 改版**成「身分中樞 + 確認閘門不可繞過」架構，
  綁定從 consumers 欄位改成 `consumer_channel_bindings` 表。分支是 7-14 的東西，**需要先確認它符不符合新設計**，
  不符合就是砍掉重練，別直接合。
- 分支另含 `LINE 免密碼登入（id_token 換 Supabase session）`，但 main 後來用 `841b2ae`／`225e6c6`
  重做了一套完整的 LINE 登入（含 email 擁有權驗證）。**這部分應該已作廢**。

### 3. `feat/line-phase-de` — LINE 以圖搜商品＋對話下單（2 commits，最後 2026-07-10）

- 「以圖找商品」（roadmap Phase D）可用。
- 「對話下單」（`stage_order` 暫存＋按鈕確認 postback）**設計已被推翻** —— roadmap 2026-07-13 把
  「全對話成單」作廢，改成連結制（bot 回預填結帳連結，走商城既有結帳）。這部分要重做。
- 也含 `consumer_orders` 的 ECPay 欄位補課，與第 1 項有重疊，一併處理。

### 4. `feat/collection-mechanism` — 2026-04 舊分支（2 commits）

內容是品牌更名、logo、物流單號、prerender 修正，四個月前的東西，看起來早被 main 蓋過了。
**建議確認後刪除分支**，別讓它繼續佔位。

---

## 二、程式碼問題（2026-07-01 review 的殘留）

那次 review 找出 26 個問題，一個月後**大部分還在**。以下每一項我都重新讀過原始碼確認仍存在。

已修的只有 P0-1、P0-2（commit `71dab40` 把 email API 改成只收 `public_token`、server 端重建內容，並加了 `escapeHtml`）。

### 會賠錢或算錯帳的

| 問題 | 位置 | 症狀 |
|---|---|---|
| 免運訂單被偷加 NT$60 | `src/pages/OrdersPage.jsx:931` | `o.shipping_fee \|\| DEFAULT_SHIPPING_FEE`，免運（0）是 falsy → 變 60。管理員只改付款狀態存檔就靜默溢收 |
| 特價空字串 → NT$0 開賣 | `src/lib/pricing.js:72,81` | `sale_price != null` 對 `''` 為真，`Number('')=0` 且 `0 < 原價` → 整店以 0 元開賣 |
| 購物車運費寫死 | `shop/src/app/cart/page.jsx:11-12` | 寫死 3800/60，但結帳讀 `store.settings`。自訂運費的店兩頁對不上 |
| 匯率缺該幣別 → 墊付算 NT$0 | `src/components/ProcurementBatchTab.jsx:78,289` | `rates[cur] \|\| 0`，未設匯率的幣別應還款低估為 0 |
| 墊付單價清空存 `''` | `src/components/ProcurementBatchTab.jsx:458` | numeric 欄位收到 `''` 會被 PostgREST 拒絕，但 save 沒檢查 error 就關閉，使用者以為存好了 |
| 入庫非原子 | `src/components/ProcurementBatchTab.jsx:589` `syncInventory` | 讀-改-寫，連點或兩人同時操作會重複計數。應改 DB 端 `stock = stock + n` + 防重入旗標 |

### 會弄丟資料的

| 問題 | 位置 | 症狀 |
|---|---|---|
| 編輯行程先刪支出再重插 | `src/pages/TripsPage.jsx:1447` | delete 無條件先跑，re-insert 失敗沒檢查 → 整筆行程支出被清空且無提示 |
| 會員等級 default 先清後寫 | `src/pages/MemberLevelsPage.jsx:54,75` | `clearDefaultExcept` 先把全部 `is_default` 設 false，後續寫入失敗 → 全店零預設等級 |
| 上架流程無 rollback | `src/components/QuickListSheet.jsx:308` | `storefront_products` insert 失敗只停 loading，重按產生第二筆商品＋重複圖片，第一筆變孤兒 |

### 會壞畫面的

| 問題 | 位置 | 症狀 |
|---|---|---|
| 整站卡在載入畫面 | `src/hooks/useAuth.jsx:28-51` | `fetchProfile` 的 `Promise.all` 無 try/catch，離線或 Supabase 不可達時 `setLoading(false)` 永不執行 |
| 商品搜尋 null 崩潰 | `src/pages/OrdersPage.jsx:1953` | `p.sku.toLowerCase()` 未防 null（同檔 1521 行有防，這行漏了） |
| 會員中心看不到規格 | `shop/src/app/account/page.jsx:431` | 守衛用 `item.color \|\| item.size`，實際欄位是 `variantLabel`，永遠不顯示 |
| 結帳摘要 key 衝突 | `shop/src/app/checkout/page.jsx:505` | 仍用 `${item.id}-${item.color}-${item.size}`（332 行已修成 `variantLabel`，這行漏了） |
| 密碼重設卡「驗證中」 | `shop/src/app/auth/reset-password/page.jsx:20` | 只監聽 `PASSWORD_RECOVERY` 事件，事件在訂閱前就發掉了。應先 `getSession()` 補查 |

### 未逐一驗證的 P3

原 review 還有 13 項 P3（邊界／防禦性），我只抽驗了幾項。清單在
`docs/archive/code-review-issues-2026-07-01.md`，**注意其中指向 `InventoryPage.jsx`、`StorefrontPage.jsx`
的項目要重新定位** —— 那兩個檔案已經合併進 `src/pages/ProductsPage.jsx` 與 `src/pages/products/`。

---

## 三、規模化

來自 `docs/archive/scalability-review-2026-07.md`。安全（第 1 步）與 ISR（第 2 步）已完成並線上驗證，剩下：

- **伺服器端分頁**（原「牆 1」，最高優先）。目前商城與後台都是「抓全部再前端處理」：
  - `shop/src/lib/data.js` 一次抓該店全部上架商品，`ProductList.jsx:109` 用 `slice()` 前端分頁
    （URL query 那部分已經做了，但只解 UI 狀態，沒解「抓全部」的根）
  - `src/pages/OrdersPage.jsx` 一次抓全部 orders + consumer_orders，無 `.range()`
  - 採購／統計在瀏覽器裡跑迴圈聚合全表
  - 改法：`.range()` + `.eq/.ilike` + `.order()`，統計走 RPC。`revenue_report_*` 已經是對的範本，照抄
- **沒有 CI**（`.github/workflows/` 不存在）。目前測試只有三支純函式 vitest
  （`memberImport`、`orderFinance`、`socialShare`），SQL/RLS 完全靠手動驗
- 列表／品牌頁完整靜態化（需 middleware 做網域→slug）
- `revalidateShop({ storeId })` 目前會失效該店所有詳情頁，高頻編輯時可改帶精確 productIds
- 商品數破千時，`generateStaticParams` 改成只預渲染熱門 N 個

---

## 四、Schema

來自 `docs/archive/schema-review-2026-06.md`。**Phase 1／3／4 都已完成**
（`20250025_phase1_perf_security`、`20250026_drop_store_id_default`、`20250027_consumer_orders_consumer_id`）。剩下：

- `shop_products` view 是 SECURITY DEFINER（Supabase advisor 標 ERROR）。已確認它只吐上架商品、不含成本，
  但較好的做法是改 `security_invoker = true` + 給 anon 適當 RLS
- 合併多條 permissive policy（advisor 標 16 張表）。純優化，要逐表確認合併後語意一致
- 開啟 leaked password protection；storage public bucket 關閉 listing
- 冗餘欄位清理（`price_adjustment`、`consumer_orders.items`、`coupons.usage_count`）—— 每項都要先改 app code，價值低，順手再做

---

## 五、功能

- **客服收件匣（站內閉環）**。migration 與 `chat` function 都已在 remote 上，站內助理跑過真實對話。
  規格與實作紀錄見 `docs/archive/customer-inbox-plan.md`，決策脈絡見 `docs/adr/0001`–`0003`，詞彙見 `CONTEXT.md`。
  **AI 自動回覆預設關閉**，逐店開通（`stores.settings.ai_reply`）；關著的店走純人工，
  對話直接進 `waiting_human` 等真人。約束見 `docs/architecture.md` §8 第 7 條。
  接手要做的：
  - **真人那半段從來沒被走過**：remote 至今 0 則 `staff` 訊息、`push_subscriptions` 0 筆。
    純人工模式下推播是店主唯一會知道有人在等的管道 —— 沒訂閱就是漏接
  - PWA 推播只驗過發送端（加密與 VAPID 簽章），**收端要在真的 iPhone 上「加入主畫面」後實測**；
    順便確認 VAPID 三把金鑰真的設進 Function Secrets（清單見計畫文件的「環境變數」段）
  - 走一次完整的 接管 → 回覆 → 結束對話，確認訪客端即時收得到
  - 驗完再開通自家店的 AI（SQL 見計畫文件），確認穩定後才考慮開放給其他店
  - LINE 併入是第二階段：`line-webhook` 切到 `_shared/assistant/`，兩份 prompt 收斂成一份
    （現在 LINE 那份把店名寫死成「LikeDaigo 代購商城」，多租戶下會講錯店名），
    `line_messages` 併進 `messages`（`channel='line'`）。
    **LINE 目前不吃 `ai_reply` 開關** —— 它不進收件匣、沒有真人接管，關掉就變死信箱
- **組合商品（社群導購一鍵買整套）**。實作中。規格見 `docs/archive/bundle-plan.md`，決策見 `docs/adr/0004`。
  落地頁先做簡化版，等區塊內容系統做好再換掉
- **區塊內容系統（首頁客製＋商品介紹）**。程式碼已在工作區、**只套到 local，remote 完全沒動**。
  規格與實作紀錄見 `docs/archive/content-blocks-plan.md`，決策見 `docs/adr/0005`、`0006`。
  接手要做的：
  - `supabase/migrations/20250080_content_blocks.sql` 套到 remote（純加欄位，不動 RLS）
  - 後台 `/home-design` 與商品上架表單裡的「商品介紹（區塊）」要人工點過一輪
    （四種區塊新增／編輯／上下移／複製／刪除、圖片上傳、預覽、發佈）
  - `/` 的轉址從 `next.config.js` 搬進 `app/page.jsx`（要看資料庫才知道該不該轉）。
- **商品頁編排器（Elementor 式整頁編排）**。規格見 `docs/archive/product-page-builder-plan.md`。
  實作在 git worktree `../inventory-app-ppb`，分支 `feat/product-page-builder`。
  接手要做的：
  - `supabase/migrations/20250082_product_page_blocks.sql` 套到 remote（純加欄位，不動 RLS）
  - 後台 `/product-template` 與 `/storefront/:spId/page` 要人工點過一輪
    （新增／拖拉排序／屬性面板／三段裝置預覽／發佈）
  - 分支合併前確認：商城端 `ProductDetail.jsx` 在別的分支上有視覺改版，兩邊會撞
  - 舊的 `ProductIntroEditor`（上架彈窗裡的折疊區）尚未移除，`intro_blocks` 尚未遷移
    **上線後要 curl 正式站確認首頁仍是 308 + `Location`**，這條路徑壞掉會讓 Google 收不到首頁
  - 草稿欄位（`home_blocks_draft` / `intro_blocks_draft`）目前 anon 讀得到：
    `stores` 對 anon 開放 SELECT、`storefront_products` 的已上架列也是。我方程式碼都只讀正式欄位，
    但直接打 PostgREST 就拿得到草稿。要真正關上得走 `20250039` 那種欄位級 GRANT，
    代價是 anon 的 `select('*')` 會整句失效（`getProductList` 正在用），故這版沒做
  - `getProductList` 用 `select('*')` 抓整張 `storefront_products`，現在多背了 `intro_blocks`
    兩個欄位。列表頁本來就該改成明列欄位，這下更該改
- **結帳自動套用等級折扣**。`member_levels.discount_percent` 已預留但結帳不吃它，等級折扣目前只是顯示。
  要改 `place_order`，並決定與優惠券的疊加／互斥規則
- **自訂網域自動化**。後台填網域只寫進 `stores.custom_domain`，Vercel 加網域＋簽憑證仍要手動進 Dashboard。
  需要一支帶 Vercel API token 的 serverless function ＋ DNS 輪詢。
  另外「自訂網域」欄位目前放在平台頁，應該移到店家設定讓店主自己管
- **LINE 登入的 Console 設定**（程式碼已在 main）：申請 Email 權限（審核制，要上傳用途截圖）、
  Callback 白名單、`LINE_LOGIN_CHANNEL_SECRET` 設進 Function Secrets、LIFF endpoint 指向正式網域
- **LINE bot 後續**：Phase C 匯款回報對帳、Phase D 以圖找商品（分支上有）、Phase E 連結制下單。
  Phase A（對話記憶）／B（訂單查詢＋綁定）已上線
- **Threads 收單 Phase 3-6**：讀留言解析進收單匣、首購閉環、回頭客快路徑、上線規模化。
  設計見 `docs/archive/threads-order-intake-plan.md`（該文件本身是現行設計，只是位置在 archive）
- **商家 onboarding 缺口**：邀請自動寄 email 與權限異動稽核（G5）、
  把 consumer 從 `user_store_roles` 退場讓該表回歸純後台角色（G7）、店主轉讓／救援機制（G8）。
  G1-G4、G6 都已完成

---

## 六、規模化到 5 家店才需要

來自 `docs/archive/scale-up-plan.md`，用 2026-06 真實 Dashboard 數據校準過。現在單店用量離上限很遠，
但這些有前置時間，要提前起跑：

- AWS SES production access（審核 1-2 天）
- Cloudflare R2（圖片搬離 Supabase Storage，省 egress）
- 確認平台 domain 與 Vercel 自訂網域配額

決策樹與成本試算在原文件，招第二、三家店時再拿出來看。
