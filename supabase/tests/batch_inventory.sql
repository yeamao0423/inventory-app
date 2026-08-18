-- 批次入庫／退庫／行程批次測試。可重複執行：全程在一個交易內，最後 ROLLBACK。
-- 跑法：psql "postgresql://postgres:postgres@127.0.0.1:54332/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/batch_inventory.sql
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

CREATE OR REPLACE FUNCTION pg_temp.stock_of(p_pid bigint, p_vid bigint)
RETURNS integer LANGUAGE sql AS $$
  SELECT CASE WHEN p_vid IS NULL
    THEN (SELECT quantity FROM public.products WHERE id = p_pid)
    ELSE (SELECT stock FROM public.product_variants WHERE id = p_vid)
  END;
$$;

INSERT INTO public.stores (id, name, is_active) VALUES (-1, '測試店', true);
INSERT INTO public.products (id, name, quantity, unit, store_id) VALUES
  (-10, '甲商品', 0, '個', -1),
  (-20, '乙商品', 0, '個', -1);
INSERT INTO public.product_variants (id, product_id, store_id, options, stock) VALUES
  (-11, -10, -1, '{}'::jsonb, 0);
INSERT INTO public.trips (id, store_id, destination, depart_date, return_date)
VALUES (-1, -1, '東京', '2026-08-01', '2026-08-07');

INSERT INTO public.procurement_batches (id, store_id, batch_date, source, status, inventory_synced)
VALUES (-1, -1, '2026-08-12', '採購彙整', 'done', false);
INSERT INTO public.procurement_items (id, batch_id, product_id, variant_id, quantity, actual_qty, unit_cost, status) VALUES
  (-1, -1, -10, -11, 5, 5, 100, 'bought'),
  (-2, -1, -20, NULL, 3, 2, 200, 'partial'),
  (-3, -1, -20, NULL, 4, 0, 200, 'missed');

-- B1 入庫：bought + partial 進，missed 不進
SELECT public.receive_batch_inventory(-1);
SELECT pg_temp.assert_eq(pg_temp.stock_of(-10, -11), 5, 'B1 bought 規格 +5');
SELECT pg_temp.assert_eq(pg_temp.stock_of(-20, NULL), 2, 'B1 partial 用 actual_qty +2，missed 不算');
SELECT pg_temp.assert_eq(
  (SELECT inventory_synced FROM public.procurement_batches WHERE id = -1), true, 'B1 標記已入庫');
SELECT pg_temp.assert_eq(
  (SELECT count(*)::integer FROM public.history WHERE product_id IN (-10, -20)
     AND resulting_stock IS NOT NULL), 2, 'B1 寫 2 筆 trigger 產生的 history（這批測試資料沒填成本，resulting_value_twd 會是 null，改用 resulting_stock 判斷）');

-- B2 重複呼叫 → 只加一次
SELECT public.receive_batch_inventory(-1);
SELECT pg_temp.assert_eq(pg_temp.stock_of(-10, -11), 5, 'B2 重複入庫 → 庫存不變');

-- B3 刪除已入庫批次 → 退庫
SELECT public.delete_batch(-1);
SELECT pg_temp.assert_eq(pg_temp.stock_of(-10, -11), 0, 'B3 退庫 → 5-5=0');
SELECT pg_temp.assert_eq(pg_temp.stock_of(-20, NULL), 0, 'B3 退庫 → 2-2=0');
SELECT pg_temp.assert_eq(
  (SELECT count(*)::integer FROM public.procurement_batches WHERE id = -1), 0, 'B3 批次已刪');
SELECT pg_temp.assert_eq(
  (SELECT count(*)::integer FROM public.history
    WHERE change < 0 AND product_id IN (-10, -20) AND resulting_stock IS NOT NULL), 2, 'B3 寫 2 筆退庫 history');

-- B4 刪除未入庫批次 → 庫存不動
INSERT INTO public.procurement_batches (id, store_id, batch_date, status, inventory_synced)
VALUES (-2, -1, '2026-08-12', 'done', false);
INSERT INTO public.procurement_items (id, batch_id, product_id, quantity, actual_qty, status)
VALUES (-4, -2, -20, 9, 9, 'bought');
SELECT public.delete_batch(-2);
SELECT pg_temp.assert_eq(pg_temp.stock_of(-20, NULL), 0, 'B4 未入庫批次刪除 → 庫存不動');

-- B5 行程批次：建立即入庫
SELECT public.create_trip_batch(
  -1::bigint, -1::bigint, '2026-08-12'::date, NULL, NULL, '行李箱清點', '行程採購',
  '[{"productId":-10,"variantId":-11,"qty":6,"cost":120,"currency":"JPY"},
    {"productId":-20,"variantId":null,"qty":4,"cost":300,"currency":"JPY"}]'::jsonb
);
SELECT pg_temp.assert_eq(pg_temp.stock_of(-10, -11), 6, 'B5 行程批次入庫 → 規格 +6');
SELECT pg_temp.assert_eq(pg_temp.stock_of(-20, NULL), 4, 'B5 行程批次入庫 → 商品 +4');
SELECT pg_temp.assert_eq(
  (SELECT count(*)::integer FROM public.procurement_batches
    WHERE trip_id = -1 AND source = '行程採購' AND inventory_synced IS TRUE), 1,
  'B5 批次掛上行程、標記已入庫');
SELECT pg_temp.assert_eq(
  (SELECT count(*)::integer FROM public.procurement_items pi
     JOIN public.procurement_batches pb ON pb.id = pi.batch_id
    WHERE pb.trip_id = -1 AND pb.source = '行程採購' AND pi.status = 'bought'
      AND pi.quantity = pi.actual_qty), 2,
  'B5 品項 quantity = actual_qty，狀態 bought');

-- B6 預購負庫存先被抵銷 —— 訂單 trigger 與批次入庫接得起來（跨兩支 migration 的整合點）
INSERT INTO public.products (id, name, quantity, unit, store_id) VALUES (-50, '丙商品', 0, '個', -1);
INSERT INTO public.storefront_products (product_id, store_id, shop_price, published, skip_stock_check)
VALUES (-50, -1, 500, true, true);
INSERT INTO public.consumer_orders (id, store_id, customer_name, items, items_json, total_amount, status)
VALUES (-200, -1, '測試客', '丙商品 × 12',
  '[{"id":-50,"name":"丙商品","qty":12,"price":500}]'::jsonb, 6000, '待確認');
SELECT pg_temp.assert_eq(pg_temp.stock_of(-50, NULL), -12, 'B6 預購 12 件 → 0→-12');

SELECT public.create_trip_batch(
  -1::bigint, -1::bigint, '2026-08-12'::date, NULL, NULL, NULL, '行程採購',
  '[{"productId":-50,"variantId":null,"qty":20,"cost":100,"currency":"JPY"}]'::jsonb
);
SELECT pg_temp.assert_eq(pg_temp.stock_of(-50, NULL), 8, 'B6 入庫 20 件 → 先補平 -12，剩 8 可賣');

-- B7 權限：非本店成員不得動這家店的批次
-- 這三支 RPC 是 SECURITY DEFINER，繞過 RLS，擋不擋全靠 assert_store_admin
DO $$
BEGIN
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000009"}', true);
  BEGIN
    PERFORM public.create_trip_batch(
      -1::bigint, -1::bigint, '2026-08-12'::date, NULL, NULL, NULL, '行程採購',
      '[{"productId":-50,"variantId":null,"qty":5,"cost":100,"currency":"JPY"}]'::jsonb);
    RAISE EXCEPTION 'FAIL  B7 非本店成員應該被擋，但沒擋下來';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%沒有權限%' THEN RAISE; END IF;
    RAISE NOTICE 'PASS  B7 非本店成員建立行程批次被擋：%', SQLERRM;
  END;
  PERFORM set_config('request.jwt.claims', '', true);
END $$;
SELECT pg_temp.assert_eq(pg_temp.stock_of(-50, NULL), 8, 'B7 被擋時庫存一件都沒動');

ROLLBACK;
