-- 區塊內容系統：首頁客製與商品介紹
--
-- 內容以「區塊（blocks）」模型存成 jsonb，掛在各自主體那張表上（見 docs/adr/0005）：
-- 讀取路徑不用多一次查詢或 join，RLS 也天然沿用既有 policy —— 這裡刻意不新增任何 policy。
--
-- null 代表「沒編過」，商城要走既有的預設版面，不是顯示空白頁。這條規則很重要，
-- 所以四個欄位都不給 DEFAULT '{}'，讓「沒編過」與「編成空的」兩件事在資料層就分得開。
--
-- 每份內容的形狀是 { "version": 1, "blocks": [...] }。版本號是為了日後改區塊型別時舊資料有得救。
-- jsonb 沒有 schema 保護，結構正確性由共用的驗證函式負責
-- （後台 src/lib/contentBlocks.js 與商城 shop/src/lib/contentBlocks.js，兩份必須對齊）。

-- ── 商城首頁 ───────────────────────────────
-- 草稿與正式分離：儲存只動 _draft，發佈才把 _draft 複製到正式欄位。
alter table stores
  add column if not exists home_blocks       jsonb,
  add column if not exists home_blocks_draft jsonb;

comment on column stores.home_blocks       is '商城首頁已發佈的區塊內容 { version, blocks }；null = 沒編過，走預設版面';
comment on column stores.home_blocks_draft is '商城首頁草稿區塊內容；只有後台成員與預覽路徑會讀';

-- ── 商品介紹 ───────────────────────────────
-- 掛在 storefront_products（上架／銷售視角，desc_zh 的隔壁）而不是 products（庫存視角）：
-- 商城詳情頁本來就 select storefront_products.*，介紹內容放這裡等於零成本取得，
-- 且既有的 "public read published storefront" / "editors write storefront" 兩條 policy 直接適用。
alter table storefront_products
  add column if not exists intro_blocks       jsonb,
  add column if not exists intro_blocks_draft jsonb;

comment on column storefront_products.intro_blocks       is '商品介紹已發佈的區塊內容 { version, blocks }；null = 沒編過，詳情頁不顯示介紹區';
comment on column storefront_products.intro_blocks_draft is '商品介紹草稿區塊內容；只有後台成員與預覽路徑會讀';

-- 品牌主色存 stores.settings.brand_color（settings 已是 jsonb 且整包送到商城前端，主色不是機密），
-- 因此不需要額外欄位。
