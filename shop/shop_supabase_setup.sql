-- ══════════════════════════════════════════════════
-- 消費者商城 — Supabase 新增資料表
-- 在 SQL Editor 執行（接續原本的 supabase_setup.sql）
-- ══════════════════════════════════════════════════

-- 1. 商品規格（每個商品的尺寸/顏色組合）
CREATE TABLE IF NOT EXISTS product_variants (
  id           BIGSERIAL PRIMARY KEY,
  product_id   BIGINT REFERENCES products(id) ON DELETE CASCADE,
  color        TEXT,
  size         TEXT,
  dimensions   TEXT,        -- 長寬高，例如 "60x40x30cm"
  stock        INTEGER NOT NULL DEFAULT 0,
  price_adjustment NUMERIC(10,2) DEFAULT 0,  -- 相對於基本售價的加減
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- 2. 客製化選項定義
CREATE TABLE IF NOT EXISTS custom_options (
  id           BIGSERIAL PRIMARY KEY,
  product_id   BIGINT REFERENCES products(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,       -- 例如「客製化文字」
  type         TEXT DEFAULT 'text', -- text / select / number
  placeholder  TEXT,
  required     BOOLEAN DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- 3. 商城商品設定（哪些商品上架到前台）
CREATE TABLE IF NOT EXISTS storefront_products (
  id           BIGSERIAL PRIMARY KEY,
  product_id   BIGINT REFERENCES products(id) ON DELETE CASCADE UNIQUE,
  published    BOOLEAN DEFAULT FALSE,
  shop_price   NUMERIC(10,2) NOT NULL DEFAULT 0,
  name_en      TEXT,          -- 英文商品名稱
  desc_zh      TEXT,          -- 中文描述
  desc_en      TEXT,          -- 英文描述
  sort_order   INTEGER DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- 4. 消費者訂單（從商城前台送出的訂單）
CREATE TABLE IF NOT EXISTS consumer_orders (
  id             BIGSERIAL PRIMARY KEY,
  customer_name  TEXT NOT NULL,
  email          TEXT,
  phone          TEXT,
  address        TEXT,
  items          TEXT NOT NULL,       -- 文字摘要
  items_json     JSONB,               -- 完整購物車資料
  total_amount   NUMERIC(10,2),
  payment_status TEXT DEFAULT '未付',
  status         TEXT DEFAULT '待確認',
  note           TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ── 匯率新增越南盾 ──────────────────────────────
INSERT INTO exchange_rates (currency, rate)
VALUES ('VND', 0.00122)
ON CONFLICT (currency) DO NOTHING;
-- 說明：1 VND ≈ 0.00122 TWD（即 1 TWD ≈ 820 VND）
-- 可在 App 匯率頁面修改

-- ── RLS 政策 ──────────────────────────────────
ALTER TABLE product_variants    ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_options      ENABLE ROW LEVEL SECURITY;
ALTER TABLE storefront_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumer_orders     ENABLE ROW LEVEL SECURITY;

-- product_variants：任何人可讀（商城展示用），登入者可寫
CREATE POLICY "public read variants" ON product_variants
  FOR SELECT USING (true);
CREATE POLICY "auth write variants" ON product_variants
  FOR ALL USING (auth.role() = 'authenticated');

-- custom_options：任何人可讀，登入者可寫
CREATE POLICY "public read options" ON custom_options
  FOR SELECT USING (true);
CREATE POLICY "auth write options" ON custom_options
  FOR ALL USING (auth.role() = 'authenticated');

-- storefront_products：任何人可讀已上架的，登入者可寫
CREATE POLICY "public read published" ON storefront_products
  FOR SELECT USING (published = true OR auth.role() = 'authenticated');
CREATE POLICY "auth write storefront" ON storefront_products
  FOR ALL USING (auth.role() = 'authenticated');

-- consumer_orders：任何人可新增（消費者下單），登入者可讀全部
CREATE POLICY "public insert orders" ON consumer_orders
  FOR INSERT WITH CHECK (true);
CREATE POLICY "auth read orders" ON consumer_orders
  FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "auth update orders" ON consumer_orders
  FOR UPDATE USING (auth.role() = 'authenticated');

-- ── 新增測試商品到商城（可選）─────────────────
-- 先確認 products 表有資料，再執行以下
-- INSERT INTO storefront_products (product_id, published, shop_price, name_en, desc_zh, desc_en)
-- SELECT id, true, cost * 1.4, name, '精選商品', 'Featured product'
-- FROM products LIMIT 3;
