-- ══════════════════════════════════════════════
-- 營收報表：對齊成本軸與折扣分攤
--
-- 三個問題：
--   1. 成本只看 products.cost，漏掉 20250035 加的規格層 variant_cost，
--      也沒用 20250057 寫入的下單當下成本快照 → 改成本/改匯率會回頭
--      改寫歷史利潤。
--   2. 品項層的利潤沒扣折扣（用 price − cost），訂單層有扣（total 是淨額），
--      所以 Excel 把品項層加總永遠對不上訂單層。原註解說「一致」其實沒做到。
--   3. 毛利率分母用 total_amount（含運費），分母灌水。
--
-- 修正後全站同一套口徑（與 src/lib/orderFinance.js 逐條對應）：
--   淨營收 = 未取消品項小計 − 折扣            ← 不含運費
--   成本   = COALESCE(快照, variant_cost, products.cost × 匯率)
--   利潤   = 淨營收 − 成本
--   折扣按品項小計比例分攤，零頭補在最後一個未取消品項，加總 === 訂單層
--
-- 另外帶出運費損益（見 20250058）：shipping_net = 向客戶收 − 實付物流。
-- 免運訂單是負的，那是店家真實的支出。它不進 profit（profit 是商品毛利），
-- 但報表要看得到，行程報告的可分配盈餘會扣它。
--
-- 訂單層 profit 的數值不變（原式 total − cost − shipping 展開後就等於
-- 淨營收 − 成本），變的是 margin 分母與成本軸。
-- 回傳欄位有增加，型別變更必須先 DROP。
-- ══════════════════════════════════════════════

BEGIN;

-- ── 成本軸單一實作：報表兩層共用，避免公式再度分岔 ──────────
CREATE OR REPLACE FUNCTION public.order_item_unit_cost_twd(
  p_order_id bigint, p_item_index int, p_item jsonb
)
RETURNS numeric
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    -- 1) 下單當下的快照，最可信（見 20250057）
    (SELECT c.unit_cost_twd FROM consumer_order_item_costs c
      WHERE c.order_id = p_order_id AND c.item_index = p_item_index),
    -- 2/3) 回退到現值：規格成本優先於商品成本，用當前匯率換算
    (SELECT ROUND(COALESCE(pv.variant_cost, p.cost) * COALESCE(er.rate, 1), 2)
       FROM products p
       LEFT JOIN product_variants pv ON pv.id::text = NULLIF(p_item->>'variantId', '')
       LEFT JOIN exchange_rates er   ON er.currency = p.currency
      WHERE p.id = NULLIF(p_item->>'id', '')::bigint),
    0
  );
$$;

COMMENT ON FUNCTION public.order_item_unit_cost_twd(bigint, int, jsonb) IS
  '訂單品項單位成本(TWD)：快照 > variant_cost > products.cost，與 src/lib/orderFinance.js 同一套規則';

REVOKE EXECUTE ON FUNCTION public.order_item_unit_cost_twd(bigint, int, jsonb) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.order_item_unit_cost_twd(bigint, int, jsonb) TO authenticated;

DROP FUNCTION IF EXISTS public.revenue_report_orders(date, date, bigint, bigint, text[], text[], bigint);
DROP FUNCTION IF EXISTS public.revenue_report_items(date, date, bigint, bigint, text[], text[], bigint);

-- ========== 訂單層 ==========
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
  net_sales numeric,
  shipping_fee integer,
  shipping_cost integer,
  shipping_net integer,
  total_amount numeric,
  total_cost numeric,
  profit numeric,
  margin numeric,
  tracking_number text
) AS $$
  WITH base AS (
    SELECT
      co.store_order_no,
      co.created_at,
      co.customer_name,
      co.email,
      co.phone,
      co.remittance_last5,
      co.status,
      co.payment_status,
      co.shipping_fee,
      COALESCE(co.shipping_cost, 0) AS shipping_cost,
      co.total_amount,
      co.tracking_number,
      COALESCE(oc.item_count, 0) AS item_count,
      COALESCE(oc.subtotal, 0)   AS subtotal,
      COALESCE(oc.total_cost, 0) AS total_cost,
      -- 折扣不可能大於未取消品項的小計（整張取消時小計為 0）
      LEAST(COALESCE(co.discount_amount, 0), COALESCE(oc.subtotal, 0)) AS eff_discount
    FROM consumer_orders co
    LEFT JOIN LATERAL (
      SELECT
        SUM(COALESCE((t.item->>'qty')::int, 1))                             AS item_count,
        SUM((t.item->>'price')::numeric * COALESCE((t.item->>'qty')::int, 1)) AS subtotal,
        SUM(public.order_item_unit_cost_twd(co.id, (t.ord - 1)::int, t.item)
            * COALESCE((t.item->>'qty')::int, 1)) AS total_cost
      FROM jsonb_array_elements(co.items_json) WITH ORDINALITY AS t(item, ord)
      WHERE COALESCE(t.item->>'status', 'active') != 'cancelled'
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
  )
  SELECT
    b.store_order_no,
    b.created_at,
    b.customer_name,
    b.email,
    b.phone,
    b.remittance_last5,
    b.status,
    b.payment_status,
    b.item_count,
    b.subtotal,
    b.eff_discount,
    b.subtotal - b.eff_discount,
    b.shipping_fee,
    b.shipping_cost,
    COALESCE(b.shipping_fee, 0) - b.shipping_cost,
    b.total_amount,
    b.total_cost,
    b.subtotal - b.eff_discount - b.total_cost,
    CASE WHEN b.subtotal - b.eff_discount > 0 THEN
      ROUND((b.subtotal - b.eff_discount - b.total_cost)
            / (b.subtotal - b.eff_discount) * 100, 1)
    END,
    b.tracking_number
  FROM base b
  ORDER BY b.store_order_no DESC;
$$ LANGUAGE sql STABLE;

-- ========== 品項層 ==========
-- 已取消品項仍列出（狀態欄標示），但小計/成本/利潤留空；
-- 折扣只分攤給未取消的品項，零頭補在該訂單最後一個未取消品項。
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
  item_discount numeric,
  net_subtotal numeric,
  currency text,
  unit_cost_orig numeric,
  unit_cost_twd numeric,
  cost_subtotal numeric,
  item_profit numeric,
  custom_note text
) AS $$
  WITH src AS (
    SELECT co.id AS pk, co.store_order_no, co.created_at, co.status,
           co.items_json, COALESCE(co.discount_amount, 0) AS discount_amount
      FROM consumer_orders co
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
  ),
  it AS (
    SELECT s.pk, s.store_order_no, s.created_at, s.status, s.discount_amount,
           t.item, t.idx,
           COALESCE(t.item->>'status', 'active') <> 'cancelled' AS is_active,
           (t.item->>'price')::numeric * COALESCE((t.item->>'qty')::int, 1) AS item_subtotal,
           public.order_item_unit_cost_twd(s.pk, (t.idx - 1)::int, t.item)  AS unit_cost
      FROM src s
      CROSS JOIN LATERAL jsonb_array_elements(s.items_json) WITH ORDINALITY AS t(item, idx)
  ),
  totals AS (
    SELECT pk,
           COALESCE(SUM(item_subtotal) FILTER (WHERE is_active), 0) AS active_subtotal,
           COUNT(*) FILTER (WHERE is_active)                        AS active_count
      FROM it GROUP BY pk
  ),
  joined AS (
    SELECT it.*, tt.active_subtotal, tt.active_count,
           LEAST(it.discount_amount, tt.active_subtotal) AS eff_discount
      FROM it JOIN totals tt ON tt.pk = it.pk
  ),
  raw AS (
    SELECT j.*,
           CASE WHEN j.is_active AND j.active_subtotal > 0
                THEN ROUND(j.eff_discount * j.item_subtotal / j.active_subtotal, 2)
                ELSE 0 END AS raw_disc,
           -- 未取消品項在該訂單內的序號（取消的品項不遞增）
           SUM(CASE WHEN j.is_active THEN 1 ELSE 0 END)
             OVER (PARTITION BY j.pk ORDER BY j.idx ROWS UNBOUNDED PRECEDING) AS active_rn
      FROM joined j
  ),
  alloc AS (
    SELECT r.*,
           CASE
             WHEN NOT r.is_active THEN 0
             WHEN r.active_rn = r.active_count THEN
               r.eff_discount - COALESCE(
                 SUM(r.raw_disc) OVER (PARTITION BY r.pk ORDER BY r.idx
                                       ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
             ELSE r.raw_disc
           END AS disc
      FROM raw r
  )
  SELECT
    a.store_order_no,
    a.created_at,
    a.status,
    a.item->>'name',
    COALESCE(a.item->>'sku', p.sku),
    a.item->>'variantLabel',
    COALESCE(a.item->>'status', 'active'),
    COALESCE((a.item->>'qty')::int, 1),
    (a.item->>'price')::numeric,
    CASE WHEN a.is_active THEN a.item_subtotal END,
    CASE WHEN a.is_active THEN a.disc END,
    CASE WHEN a.is_active THEN a.item_subtotal - a.disc END,
    COALESCE(snap.cost_currency, p.currency),
    COALESCE(snap.cost_orig, pv.variant_cost, p.cost),
    a.unit_cost,
    CASE WHEN a.is_active THEN a.unit_cost * COALESCE((a.item->>'qty')::int, 1) END,
    CASE WHEN a.is_active THEN
      a.item_subtotal - a.disc - a.unit_cost * COALESCE((a.item->>'qty')::int, 1)
    END,
    a.item->>'customNote'
  FROM alloc a
  LEFT JOIN products p          ON p.id = NULLIF(a.item->>'id', '')::bigint
  LEFT JOIN product_variants pv ON pv.id::text = NULLIF(a.item->>'variantId', '')
  LEFT JOIN consumer_order_item_costs snap
         ON snap.order_id = a.pk AND snap.item_index = (a.idx - 1)::int
  ORDER BY a.store_order_no DESC, a.item->>'name';
$$ LANGUAGE sql STABLE;

REVOKE EXECUTE ON FUNCTION public.revenue_report_orders(date, date, bigint, bigint, text[], text[], bigint) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.revenue_report_items(date, date, bigint, bigint, text[], text[], bigint)  FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.revenue_report_orders(date, date, bigint, bigint, text[], text[], bigint) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.revenue_report_items(date, date, bigint, bigint, text[], text[], bigint)  TO authenticated;

COMMIT;
