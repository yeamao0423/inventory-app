-- ============================================
-- Migration: revenue_report RPCs（營收報表）
-- 將「輸出報表的內容.sql」的兩段查詢正式化為可參數化的 RPC：
--   revenue_report_orders：訂單層級（營收/成本/利潤）
--   revenue_report_items ：品項層級明細
-- 相較原 SQL 的修正：
--   1. 兩個層級的篩選條件一致（原本細項層級沒排除已取消訂單）
--   2. 成本計算排除已取消的品項（items_json 內 status = 'cancelled'）
--   3. 篩選全面參數化（取代寫死的 id >= 25），為多租戶擴充鋪路
--   4. 品項層級回傳實際幣別欄位（原本欄位名寫死 VND）
-- 日期篩選以台灣時區（Asia/Taipei）為準。
-- 權限：consumer_orders 的 SELECT policy 是 USING (true)，RLS 擋不住，
--       且報表含成本/利潤，故 function 內檢查呼叫者必須是 admin/super_admin，
--       否則回傳空結果。
-- Run this in Supabase Dashboard → SQL Editor
-- ============================================

-- ========== 訂單層級 ==========
CREATE OR REPLACE FUNCTION public.revenue_report_orders(
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_id_from bigint DEFAULT NULL,
  p_id_to bigint DEFAULT NULL,
  p_statuses text[] DEFAULT NULL,
  p_pay_statuses text[] DEFAULT NULL
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
    co.id,
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
      SUM(COALESCE((item->>'qty')::int, 1))                                          AS item_count,
      SUM((item->>'price')::numeric * COALESCE((item->>'qty')::int, 1))              AS subtotal,
      SUM(ROUND(p.cost * COALESCE(er.rate, 1), 2) * COALESCE((item->>'qty')::int, 1)) AS total_cost
    FROM jsonb_array_elements(co.items_json) AS item
    LEFT JOIN products p        ON p.id = (item->>'id')::bigint
    LEFT JOIN exchange_rates er ON er.currency = p.currency
    WHERE COALESCE(item->>'status', 'active') != 'cancelled'
  ) oc ON true
  WHERE (p_date_from IS NULL OR (co.created_at AT TIME ZONE 'Asia/Taipei')::date >= p_date_from)
    AND (p_date_to   IS NULL OR (co.created_at AT TIME ZONE 'Asia/Taipei')::date <= p_date_to)
    AND (p_id_from   IS NULL OR co.id >= p_id_from)
    AND (p_id_to     IS NULL OR co.id <= p_id_to)
    AND (p_statuses     IS NULL OR co.status = ANY(p_statuses))
    AND (p_pay_statuses IS NULL OR co.payment_status = ANY(p_pay_statuses))
    AND EXISTS (
      SELECT 1 FROM user_store_roles usr
      WHERE usr.user_id = auth.uid() AND usr.role IN ('super_admin', 'admin')
    )
  ORDER BY co.id DESC;
$$ LANGUAGE sql STABLE;

-- ========== 品項層級 ==========
-- 已取消品項仍列出（品項狀態欄標示），但小計/成本小計/品項利潤為空，
-- 讓 Excel 直接加總時與訂單層級的數字一致。
CREATE OR REPLACE FUNCTION public.revenue_report_items(
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_id_from bigint DEFAULT NULL,
  p_id_to bigint DEFAULT NULL,
  p_statuses text[] DEFAULT NULL,
  p_pay_statuses text[] DEFAULT NULL
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
    co.id,
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
  WHERE (p_date_from IS NULL OR (co.created_at AT TIME ZONE 'Asia/Taipei')::date >= p_date_from)
    AND (p_date_to   IS NULL OR (co.created_at AT TIME ZONE 'Asia/Taipei')::date <= p_date_to)
    AND (p_id_from   IS NULL OR co.id >= p_id_from)
    AND (p_id_to     IS NULL OR co.id <= p_id_to)
    AND (p_statuses     IS NULL OR co.status = ANY(p_statuses))
    AND (p_pay_statuses IS NULL OR co.payment_status = ANY(p_pay_statuses))
    AND EXISTS (
      SELECT 1 FROM user_store_roles usr
      WHERE usr.user_id = auth.uid() AND usr.role IN ('super_admin', 'admin')
    )
  ORDER BY co.id DESC, item->>'name';
$$ LANGUAGE sql STABLE;

-- 報表含成本與利潤，只開放給後台登入者（anon 不可呼叫）
REVOKE EXECUTE ON FUNCTION public.revenue_report_orders(date, date, bigint, bigint, text[], text[]) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.revenue_report_items(date, date, bigint, bigint, text[], text[])  FROM anon, public;
GRANT EXECUTE ON FUNCTION public.revenue_report_orders(date, date, bigint, bigint, text[], text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revenue_report_items(date, date, bigint, bigint, text[], text[])  TO authenticated;
