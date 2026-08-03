-- 商品頁編排器：全店範本 + 單一商品覆寫（見 docs/archive/product-page-builder-plan.md）
--
-- 沿用 20250080 的三條規則，理由相同，不再重述：
--   1. 內容存 jsonb，掛在各自主體那張表上（免 join、RLS 天然沿用，見 docs/adr/0005）
--   2. 不給 DEFAULT，讓「沒編過」（null）與「編成空的」（{blocks:[]}）在資料層就分得開
--   3. 草稿與正式分離，儲存只動 _draft，發佈才複製過去
--
-- 這裡也不新增任何 policy：stores 與 storefront_products 的既有 policy 已經涵蓋。

-- ── 全店商品頁範本 ─────────────────────────
-- 放 stores 而不是每件商品各存一份：店主改一次版型全店換掉，
-- 否則上架第 50 件商品時得排第 50 次版（Shopify、WooCommerce+Elementor 都是這個取捨）。
alter table stores
  add column if not exists product_template_blocks       jsonb,
  add column if not exists product_template_blocks_draft jsonb;

comment on column stores.product_template_blocks       is '全店商品頁範本已發佈的區塊內容 { version, blocks }；null = 沒編過，商品頁走內建版型';
comment on column stores.product_template_blocks_draft is '全店商品頁範本草稿；只有後台成員與預覽路徑會讀';

-- ── 單一商品覆寫 ───────────────────────────
-- null = 跟隨全店範本（不是「空版面」）。店主按「脫離範本」時才把當下範本複製進來。
alter table storefront_products
  add column if not exists page_blocks       jsonb,
  add column if not exists page_blocks_draft jsonb;

comment on column storefront_products.page_blocks       is '單一商品的商品頁覆寫（已發佈）；null = 跟隨 stores.product_template_blocks';
comment on column storefront_products.page_blocks_draft is '單一商品的商品頁覆寫草稿；只有後台成員與預覽路徑會讀';

-- 既有的 intro_blocks / intro_blocks_draft 刻意保留不刪。
-- 遷移是「複製進範本」而不是搬移 —— 出事才回得去（見計畫書 §7）。
