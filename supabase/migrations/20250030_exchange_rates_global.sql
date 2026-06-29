-- 幣別匯率改回「全域」（移除 per-store），並補齊亞洲常見幣別預設匯率
--
-- 背景：匯率為客觀市場匯率，全平台一致，本不需 per-store。
-- 20250018_multi_tenant_phase1 當初把 exchange_rates 改成 PK=(store_id,currency)，
-- 這裡還原成全域（PK=currency），讓所有店家共用同一份匯率，新增幣別只補一次即可。

-- ========== 1) 移除依賴 store_id 的 RLS policy ==========
DROP POLICY IF EXISTS "members read rates" ON public.exchange_rates;
DROP POLICY IF EXISTS "admins write rates" ON public.exchange_rates;

-- ========== 2) 收斂為全域：去重 → 移除 store_id → PK 改回 currency ==========
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'exchange_rates'
      AND column_name = 'store_id'
  ) THEN
    -- 同 currency 只保留一筆（store_id 最小者），避免移除 store_id 後 PK 衝突
    DELETE FROM public.exchange_rates a
    USING public.exchange_rates b
    WHERE a.currency = b.currency
      AND a.store_id > b.store_id;

    ALTER TABLE public.exchange_rates DROP CONSTRAINT IF EXISTS exchange_rates_pkey;
    ALTER TABLE public.exchange_rates DROP COLUMN store_id;
    ALTER TABLE public.exchange_rates ADD PRIMARY KEY (currency);
  END IF;
END $$;

-- ========== 3) 還原全域 RLS policy（與多租戶改造前一致）==========
DROP POLICY IF EXISTS "allow all authenticated exchange_rates" ON public.exchange_rates;
CREATE POLICY "allow all authenticated exchange_rates" ON public.exchange_rates
  USING (auth.role() = 'authenticated');

-- ========== 4) revenue_report 函式：JOIN 拿掉 store_id 條件（改回全域匯率）==========
-- 函式簽章不變（仍以 p_store_id 篩訂單歸屬），僅 exchange_rates JOIN 由
--   er.currency = p.currency AND er.store_id = co.store_id
-- 改為
--   er.currency = p.currency
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
    LEFT JOIN exchange_rates er ON er.currency = p.currency
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
  LEFT JOIN exchange_rates er ON er.currency = p.currency
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

-- ========== 5) 補齊全域預設匯率（1 外幣 = ? 台幣）==========
-- ⚠️ 以下為「概略預估值」，請依實際匯率自行調整；ON CONFLICT DO NOTHING 不覆蓋既有值。
INSERT INTO public.exchange_rates (currency, rate) VALUES
  ('TWD', 1.0000),   -- 新台幣（基準）
  ('JPY', 0.2100),   -- 日圓
  ('KRW', 0.0240),   -- 韓元
  ('THB', 0.9200),   -- 泰銖
  ('VND', 0.0013),   -- 越南盾
  ('IDR', 0.0020),   -- 印尼盾
  ('CNY', 4.5000),   -- 人民幣
  ('HKD', 4.1000),   -- 港幣
  ('MYR', 7.6000),   -- 馬來西亞令吉
  ('PHP', 0.5700),   -- 菲律賓披索
  ('SGD', 24.0000),  -- 新加坡幣
  ('USD', 32.0000),  -- 美元
  ('EUR', 35.0000)   -- 歐元
ON CONFLICT (currency) DO NOTHING;
