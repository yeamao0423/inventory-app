-- ============================================
-- Migration: 多租戶 Phase 1 — schema 鋪底
-- 目標：為「多代購業者平台」做資料層準備，現有 app 行為完全不變
--   1. stores 升級為業者主表（slug / custom_domain / settings）
--   2. 業務表全面加上 store_id（DEFAULT 1 = Daigogo，回填既有資料）
--   3. 全域 UNIQUE 改為 per-store 複合 UNIQUE
--   4. exchange_rates 改為 per-store（PK = store_id + currency）
--   5. consumer_orders 加 per-store 訂單編號 store_order_no（counter + trigger）
--   6. store_consumers：消費者與店家的會員關係（會員等級各店獨立）
--   7. revenue_report RPC 改為 store-aware（p_store_id DEFAULT 1）
-- 注意：DEFAULT 1 是 Phase 1 的過渡設計，Phase 2 由程式碼明確帶 store_id 後移除
-- 僅先套用於 local，待測試通過後才可上 remote
-- ============================================

-- ========== 1) stores 升級 ==========
ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS slug text,
  ADD COLUMN IF NOT EXISTS custom_domain text,
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE stores SET slug = 'daigogo' WHERE id = 1 AND slug IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS stores_slug_key ON stores (slug);
CREATE UNIQUE INDEX IF NOT EXISTS stores_custom_domain_key ON stores (custom_domain);

-- ========== 2) 業務表加 store_id ==========
ALTER TABLE products             ADD COLUMN IF NOT EXISTS store_id bigint NOT NULL DEFAULT 1 REFERENCES stores(id);
ALTER TABLE categories           ADD COLUMN IF NOT EXISTS store_id bigint NOT NULL DEFAULT 1 REFERENCES stores(id);
ALTER TABLE tags                 ADD COLUMN IF NOT EXISTS store_id bigint NOT NULL DEFAULT 1 REFERENCES stores(id);
ALTER TABLE variant_option_types ADD COLUMN IF NOT EXISTS store_id bigint NOT NULL DEFAULT 1 REFERENCES stores(id);
ALTER TABLE storefront_products  ADD COLUMN IF NOT EXISTS store_id bigint NOT NULL DEFAULT 1 REFERENCES stores(id);
ALTER TABLE consumer_orders      ADD COLUMN IF NOT EXISTS store_id bigint NOT NULL DEFAULT 1 REFERENCES stores(id);
ALTER TABLE orders               ADD COLUMN IF NOT EXISTS store_id bigint NOT NULL DEFAULT 1 REFERENCES stores(id);
ALTER TABLE history              ADD COLUMN IF NOT EXISTS store_id bigint NOT NULL DEFAULT 1 REFERENCES stores(id);
ALTER TABLE coupons              ADD COLUMN IF NOT EXISTS store_id bigint NOT NULL DEFAULT 1 REFERENCES stores(id);
ALTER TABLE trips                ADD COLUMN IF NOT EXISTS store_id bigint NOT NULL DEFAULT 1 REFERENCES stores(id);

CREATE INDEX IF NOT EXISTS products_store_id_idx             ON products (store_id);
CREATE INDEX IF NOT EXISTS categories_store_id_idx           ON categories (store_id);
CREATE INDEX IF NOT EXISTS tags_store_id_idx                 ON tags (store_id);
CREATE INDEX IF NOT EXISTS variant_option_types_store_id_idx ON variant_option_types (store_id);
CREATE INDEX IF NOT EXISTS storefront_products_store_id_idx  ON storefront_products (store_id);
CREATE INDEX IF NOT EXISTS consumer_orders_store_id_idx      ON consumer_orders (store_id);
CREATE INDEX IF NOT EXISTS orders_store_id_idx               ON orders (store_id);
CREATE INDEX IF NOT EXISTS history_store_id_idx              ON history (store_id);
CREATE INDEX IF NOT EXISTS coupons_store_id_idx              ON coupons (store_id);
CREATE INDEX IF NOT EXISTS trips_store_id_idx                ON trips (store_id);

-- ========== 3) 全域 UNIQUE → per-store 複合 UNIQUE ==========
-- 不改的話，第二家業者建同名分類 / 同碼優惠券會直接撞 constraint
ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_name_key;
ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_store_id_name_key;
ALTER TABLE categories ADD CONSTRAINT categories_store_id_name_key UNIQUE (store_id, name);

ALTER TABLE tags DROP CONSTRAINT IF EXISTS tags_name_key;
ALTER TABLE tags DROP CONSTRAINT IF EXISTS tags_store_id_name_key;
ALTER TABLE tags ADD CONSTRAINT tags_store_id_name_key UNIQUE (store_id, name);

ALTER TABLE variant_option_types DROP CONSTRAINT IF EXISTS variant_option_types_name_key;
ALTER TABLE variant_option_types DROP CONSTRAINT IF EXISTS variant_option_types_store_id_name_key;
ALTER TABLE variant_option_types ADD CONSTRAINT variant_option_types_store_id_name_key UNIQUE (store_id, name);

ALTER TABLE coupons DROP CONSTRAINT IF EXISTS coupons_code_key;
ALTER TABLE coupons DROP CONSTRAINT IF EXISTS coupons_store_id_code_key;
ALTER TABLE coupons ADD CONSTRAINT coupons_store_id_code_key UNIQUE (store_id, code);

-- coupon_codes.code 維持全域唯一：結帳輸入折扣碼時不需先知道店別，實作最簡單

-- ========== 4) exchange_rates 改 per-store ==========
-- 每家業者進貨國家與記帳匯率不同，各自維護
ALTER TABLE exchange_rates ADD COLUMN IF NOT EXISTS store_id bigint NOT NULL DEFAULT 1 REFERENCES stores(id);
ALTER TABLE exchange_rates DROP CONSTRAINT IF EXISTS exchange_rates_pkey;
ALTER TABLE exchange_rates ADD PRIMARY KEY (store_id, currency);

-- ========== 5) per-store 訂單編號 ==========
-- consumer_orders.id 是全域流水號，多店後各店編號會交錯跳號；
-- store_order_no 是顧客看到的店內編號。既有訂單回填 = id，Daigogo 編號無縫接續。
ALTER TABLE consumer_orders ADD COLUMN IF NOT EXISTS store_order_no bigint;
UPDATE consumer_orders SET store_order_no = id WHERE store_order_no IS NULL;
ALTER TABLE consumer_orders ALTER COLUMN store_order_no SET NOT NULL;

ALTER TABLE consumer_orders DROP CONSTRAINT IF EXISTS consumer_orders_store_order_no_key;
ALTER TABLE consumer_orders ADD CONSTRAINT consumer_orders_store_order_no_key UNIQUE (store_id, store_order_no);

CREATE TABLE IF NOT EXISTS store_order_counters (
  store_id bigint PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  last_no bigint NOT NULL DEFAULT 0
);
-- 內部計數表：不開放任何直接存取，只由 trigger（SECURITY DEFINER）操作
ALTER TABLE store_order_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON store_order_counters FROM anon, authenticated;

INSERT INTO store_order_counters (store_id, last_no)
SELECT store_id, MAX(store_order_no) FROM consumer_orders GROUP BY store_id
ON CONFLICT (store_id) DO UPDATE
SET last_no = GREATEST(store_order_counters.last_no, EXCLUDED.last_no);

-- trigger function 用 SECURITY DEFINER 是因為計數表對 client 角色完全關閉；
-- 回傳型別是 trigger，無法被 PostgREST 當 RPC 呼叫
CREATE OR REPLACE FUNCTION public.assign_store_order_no()
RETURNS trigger AS $$
BEGIN
  IF NEW.store_order_no IS NULL THEN
    INSERT INTO store_order_counters (store_id, last_no)
    VALUES (NEW.store_id, 1)
    ON CONFLICT (store_id) DO UPDATE SET last_no = store_order_counters.last_no + 1
    RETURNING last_no INTO NEW.store_order_no;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_assign_store_order_no ON consumer_orders;
CREATE TRIGGER trg_assign_store_order_no
  BEFORE INSERT ON consumer_orders
  FOR EACH ROW EXECUTE FUNCTION public.assign_store_order_no();

-- ========== 6) store_consumers：per-store 會員關係 ==========
-- consumers 維持平台級身分（一個帳號），與各店的會員關係 / 等級獨立存放
CREATE TABLE IF NOT EXISTS store_consumers (
  store_id bigint NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  consumer_id uuid NOT NULL REFERENCES consumers(id) ON DELETE CASCADE,
  member_level text,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (store_id, consumer_id)
);

ALTER TABLE store_consumers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "consumer read own membership" ON store_consumers;
CREATE POLICY "consumer read own membership" ON store_consumers
  FOR SELECT TO authenticated
  USING (consumer_id = auth.uid());

DROP POLICY IF EXISTS "consumer join store" ON store_consumers;
CREATE POLICY "consumer join store" ON store_consumers
  FOR INSERT TO authenticated
  WITH CHECK (consumer_id = auth.uid());

DROP POLICY IF EXISTS "staff read store members" ON store_consumers;
CREATE POLICY "staff read store members" ON store_consumers
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM user_store_roles usr
    WHERE usr.user_id = auth.uid()
      AND usr.store_id = store_consumers.store_id
      AND usr.role IN ('super_admin', 'admin', 'editor', 'viewer')
  ));

-- 會員等級只能由該店管理層調整
DROP POLICY IF EXISTS "admin update store members" ON store_consumers;
CREATE POLICY "admin update store members" ON store_consumers
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM user_store_roles usr
    WHERE usr.user_id = auth.uid()
      AND usr.store_id = store_consumers.store_id
      AND usr.role IN ('super_admin', 'admin')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM user_store_roles usr
    WHERE usr.user_id = auth.uid()
      AND usr.store_id = store_consumers.store_id
      AND usr.role IN ('super_admin', 'admin')
  ));

GRANT SELECT, INSERT, UPDATE ON store_consumers TO authenticated;

-- 既有消費者全數歸入 Daigogo
INSERT INTO store_consumers (store_id, consumer_id)
SELECT 1, id FROM consumers
ON CONFLICT DO NOTHING;

-- ========== 7) revenue_report RPC 改 store-aware ==========
-- 參數列變動必須先 DROP（否則新舊版本並存，named-call 會 ambiguous）
DROP FUNCTION IF EXISTS public.revenue_report_orders(date, date, bigint, bigint, text[], text[]);
DROP FUNCTION IF EXISTS public.revenue_report_items(date, date, bigint, bigint, text[], text[]);

CREATE OR REPLACE FUNCTION public.revenue_report_orders(
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_id_from bigint DEFAULT NULL,
  p_id_to bigint DEFAULT NULL,
  p_statuses text[] DEFAULT NULL,
  p_pay_statuses text[] DEFAULT NULL,
  p_store_id bigint DEFAULT 1
)
RETURNS TABLE (
  order_id bigint,
  created_at timestamptz,
  customer_name text,
  email text,
  phone text,
  remittance_last5 text,
  status text,
  payment_status text,
  item_count bigint,
  subtotal numeric,
  discount_amount numeric,
  shipping_fee integer,
  total_amount numeric,
  total_cost numeric,
  profit numeric,
  margin numeric,
  tracking_number text
) AS $$
  SELECT
    co.store_order_no,
    co.created_at,
    co.customer_name,
    co.email,
    co.phone,
    co.remittance_last5,
    co.status,
    co.payment_status,
    COALESCE(oc.item_count, 0),
    COALESCE(oc.subtotal, 0),
    COALESCE(co.discount_amount, 0),
    co.shipping_fee,
    co.total_amount,
    COALESCE(oc.total_cost, 0),
    co.total_amount - COALESCE(oc.total_cost, 0) - COALESCE(co.shipping_fee, 0),
    CASE WHEN co.total_amount > 0 THEN
      ROUND((co.total_amount - COALESCE(oc.total_cost, 0) - COALESCE(co.shipping_fee, 0))
            / co.total_amount * 100, 1)
    END,
    co.tracking_number
  FROM consumer_orders co
  LEFT JOIN LATERAL (
    SELECT
      SUM(COALESCE((item->>'qty')::int, 1))                                           AS item_count,
      SUM((item->>'price')::numeric * COALESCE((item->>'qty')::int, 1))               AS subtotal,
      SUM(ROUND(p.cost * COALESCE(er.rate, 1), 2) * COALESCE((item->>'qty')::int, 1)) AS total_cost
    FROM jsonb_array_elements(co.items_json) AS item
    LEFT JOIN products p        ON p.id = (item->>'id')::bigint
    LEFT JOIN exchange_rates er ON er.currency = p.currency AND er.store_id = co.store_id
    WHERE COALESCE(item->>'status', 'active') != 'cancelled'
  ) oc ON true
  WHERE co.store_id = p_store_id
    AND (p_date_from IS NULL OR (co.created_at AT TIME ZONE 'Asia/Taipei')::date >= p_date_from)
    AND (p_date_to   IS NULL OR (co.created_at AT TIME ZONE 'Asia/Taipei')::date <= p_date_to)
    AND (p_id_from   IS NULL OR co.store_order_no >= p_id_from)
    AND (p_id_to     IS NULL OR co.store_order_no <= p_id_to)
    AND (p_statuses     IS NULL OR co.status = ANY(p_statuses))
    AND (p_pay_statuses IS NULL OR co.payment_status = ANY(p_pay_statuses))
    AND EXISTS (
      SELECT 1 FROM user_store_roles usr
      WHERE usr.user_id = auth.uid()
        AND usr.store_id = p_store_id
        AND usr.role IN ('super_admin', 'admin')
    )
  ORDER BY co.store_order_no DESC;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION public.revenue_report_items(
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_id_from bigint DEFAULT NULL,
  p_id_to bigint DEFAULT NULL,
  p_statuses text[] DEFAULT NULL,
  p_pay_statuses text[] DEFAULT NULL,
  p_store_id bigint DEFAULT 1
)
RETURNS TABLE (
  order_id bigint,
  created_at timestamptz,
  order_status text,
  item_name text,
  sku text,
  variant_label text,
  item_status text,
  qty integer,
  unit_price numeric,
  subtotal numeric,
  currency text,
  unit_cost_orig numeric,
  unit_cost_twd numeric,
  cost_subtotal numeric,
  item_profit numeric,
  custom_note text
) AS $$
  SELECT
    co.store_order_no,
    co.created_at,
    co.status,
    item->>'name',
    COALESCE(item->>'sku', p.sku),
    item->>'variantLabel',
    COALESCE(item->>'status', 'active'),
    COALESCE((item->>'qty')::int, 1),
    (item->>'price')::numeric,
    CASE WHEN COALESCE(item->>'status', 'active') != 'cancelled' THEN
      (item->>'price')::numeric * COALESCE((item->>'qty')::int, 1)
    END,
    p.currency,
    p.cost,
    ROUND(p.cost * COALESCE(er.rate, 1), 2),
    CASE WHEN COALESCE(item->>'status', 'active') != 'cancelled' THEN
      ROUND(p.cost * COALESCE(er.rate, 1), 2) * COALESCE((item->>'qty')::int, 1)
    END,
    CASE WHEN COALESCE(item->>'status', 'active') != 'cancelled' THEN
      ((item->>'price')::numeric - ROUND(p.cost * COALESCE(er.rate, 1), 2))
      * COALESCE((item->>'qty')::int, 1)
    END,
    item->>'customNote'
  FROM consumer_orders co
  CROSS JOIN LATERAL jsonb_array_elements(co.items_json) AS item
  LEFT JOIN products p        ON p.id = (item->>'id')::bigint
  LEFT JOIN exchange_rates er ON er.currency = p.currency AND er.store_id = co.store_id
  WHERE co.store_id = p_store_id
    AND (p_date_from IS NULL OR (co.created_at AT TIME ZONE 'Asia/Taipei')::date >= p_date_from)
    AND (p_date_to   IS NULL OR (co.created_at AT TIME ZONE 'Asia/Taipei')::date <= p_date_to)
    AND (p_id_from   IS NULL OR co.store_order_no >= p_id_from)
    AND (p_id_to     IS NULL OR co.store_order_no <= p_id_to)
    AND (p_statuses     IS NULL OR co.status = ANY(p_statuses))
    AND (p_pay_statuses IS NULL OR co.payment_status = ANY(p_pay_statuses))
    AND EXISTS (
      SELECT 1 FROM user_store_roles usr
      WHERE usr.user_id = auth.uid()
        AND usr.store_id = p_store_id
        AND usr.role IN ('super_admin', 'admin')
    )
  ORDER BY co.store_order_no DESC, item->>'name';
$$ LANGUAGE sql STABLE;

REVOKE EXECUTE ON FUNCTION public.revenue_report_orders(date, date, bigint, bigint, text[], text[], bigint) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.revenue_report_items(date, date, bigint, bigint, text[], text[], bigint)  FROM anon, public;
GRANT EXECUTE ON FUNCTION public.revenue_report_orders(date, date, bigint, bigint, text[], text[], bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revenue_report_items(date, date, bigint, bigint, text[], text[], bigint)  TO authenticated;
