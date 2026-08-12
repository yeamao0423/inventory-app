-- 訂單庫存扣補測試。可重複執行：全程在一個交易內，最後 ROLLBACK。
-- 跑法：psql "postgresql://postgres:postgres@127.0.0.1:54332/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/stock_reconcile.sql
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

-- 讀目前庫存
CREATE OR REPLACE FUNCTION pg_temp.stock_of(p_pid bigint, p_vid bigint)
RETURNS integer LANGUAGE sql AS $$
  SELECT CASE WHEN p_vid IS NULL
    THEN (SELECT quantity FROM public.products WHERE id = p_pid)
    ELSE (SELECT stock FROM public.product_variants WHERE id = p_vid)
  END;
$$;

-- ─── 測試資料 ──────────────────────────────
-- 用負數 id 避開既有資料，序列不受影響
INSERT INTO public.stores (id, name, is_active) VALUES (-1, '測試店', true);

INSERT INTO public.products (id, name, quantity, unit, store_id) VALUES
  (-10, '現貨商品', 10, '個', -1),
  (-20, '預購商品',  0, '個', -1),
  (-30, '限時單商品', 0, '個', -1),
  (-40, '未上架商品', 5, '個', -1);

INSERT INTO public.storefront_products (product_id, store_id, shop_price, published, skip_stock_check, collection_end) VALUES
  (-10, -1, 500, true, false, NULL),
  (-20, -1, 500, true, true,  NULL),
  (-30, -1, 500, true, false, now() + interval '7 days');

INSERT INTO public.product_variants (id, product_id, store_id, options, stock) VALUES
  (-11, -10, -1, '{}'::jsonb, 4),
  (-21, -20, -1, '{}'::jsonb, 0);

DO $$ BEGIN RAISE NOTICE '--- seed 完成 ---'; END $$;

-- ─── 扣減 ──────────────────────────────────

-- T1 現貨下單 → 庫存減，stock_committed 記帳
INSERT INTO public.consumer_orders (id, store_id, customer_name, items, items_json, total_amount, status)
VALUES (-100, -1, '測試客', '現貨商品 × 3',
  '[{"id":-10,"name":"現貨商品","qty":3,"price":500}]'::jsonb, 1500, '待確認');

SELECT pg_temp.assert_eq(pg_temp.stock_of(-10, NULL), 7, 'T1 現貨下單 3 件 → 庫存 10→7');
SELECT pg_temp.assert_eq(
  (SELECT stock_committed FROM public.consumer_orders WHERE id = -100),
  '{"-10:": 3}'::jsonb, 'T1 stock_committed 記下 3');

-- T2 預購下單 → 庫存扣成負
INSERT INTO public.consumer_orders (id, store_id, customer_name, items, items_json, total_amount, status)
VALUES (-101, -1, '測試客', '預購商品 × 12',
  '[{"id":-20,"name":"預購商品","qty":12,"price":500,"isCollection":true}]'::jsonb, 6000, '待確認');

SELECT pg_temp.assert_eq(pg_temp.stock_of(-20, NULL), -12, 'T2 預購下單 12 件 → 庫存 0→-12');

-- T3 走 place_order（而非裸 insert）也只扣一次
SELECT public.place_order(
  '測試客', 'a@b.c', '0900000000', '地址', NULL, NULL, NULL, NULL, NULL,
  '現貨商品 × 2',
  '[{"id":-10,"name":"現貨商品","qty":2,"price":500}]'::jsonb,
  1000, 0, NULL, 1000, 'a@b.c', -1);

SELECT pg_temp.assert_eq(pg_temp.stock_of(-10, NULL), 5, 'T3 place_order 扣 2 件 → 7→5（不是 3）');

-- ─── 回補 ──────────────────────────────────

-- T4 整張訂單取消（後台路徑）→ 回補
UPDATE public.consumer_orders SET status = '已取消' WHERE id = -100;
SELECT pg_temp.assert_eq(pg_temp.stock_of(-10, NULL), 8, 'T4 取消訂單 -100 → 5+3=8');
SELECT pg_temp.assert_eq(
  (SELECT stock_committed FROM public.consumer_orders WHERE id = -100),
  '{}'::jsonb, 'T4 取消後 stock_committed 清空');

-- T5 冪等：再取消一次，庫存不動
UPDATE public.consumer_orders SET status = '已取消' WHERE id = -100;
SELECT pg_temp.assert_eq(pg_temp.stock_of(-10, NULL), 8, 'T5 重複取消 → 庫存不變');

-- T6 取消後改回處理中 → 重新扣
UPDATE public.consumer_orders SET status = '處理中' WHERE id = -100;
SELECT pg_temp.assert_eq(pg_temp.stock_of(-10, NULL), 5, 'T6 復原訂單 → 8-3=5');

-- T7 單一品項取消
UPDATE public.consumer_orders
   SET items_json = '[{"id":-10,"name":"現貨商品","qty":3,"price":500,"status":"cancelled"}]'::jsonb
 WHERE id = -100;
SELECT pg_temp.assert_eq(pg_temp.stock_of(-10, NULL), 8, 'T7 品項取消 → 5+3=8');

-- T8 數量調降：先復原成 3，再降成 1
UPDATE public.consumer_orders
   SET items_json = '[{"id":-10,"name":"現貨商品","qty":3,"price":500}]'::jsonb
 WHERE id = -100;
UPDATE public.consumer_orders
   SET items_json = '[{"id":-10,"name":"現貨商品","qty":1,"price":500}]'::jsonb
 WHERE id = -100;
SELECT pg_temp.assert_eq(pg_temp.stock_of(-10, NULL), 7, 'T8 3→1 件 → 只補 2 件');

-- T9 消費者路徑：裸 update status（與 shop/account/page.jsx:83 同形）
UPDATE public.consumer_orders SET status = '已取消' WHERE id = -100;
SELECT pg_temp.assert_eq(pg_temp.stock_of(-10, NULL), 8, 'T9 消費者自行取消 → 回補');

-- T10 訂單刪除 → 回補（用預購那張，庫存 -12）
DELETE FROM public.consumer_orders WHERE id = -101;
SELECT pg_temp.assert_eq(pg_temp.stock_of(-20, NULL), 0, 'T10 刪除訂單 → -12 回到 0');

-- T11 規格層級：現貨規格 -11 庫存 4
INSERT INTO public.consumer_orders (id, store_id, customer_name, items, items_json, total_amount, status)
VALUES (-102, -1, '測試客', '現貨商品 紅/M × 2',
  '[{"id":-10,"variantId":-11,"variantLabel":"紅 / M","name":"現貨商品","qty":2,"price":500}]'::jsonb,
  1000, '待確認');
SELECT pg_temp.assert_eq(pg_temp.stock_of(-10, -11), 2, 'T11 規格下單 2 件 → 4→2');
SELECT pg_temp.assert_eq(
  (SELECT stock_committed FROM public.consumer_orders WHERE id = -102),
  '{"-10:-11": 2}'::jsonb, 'T11 規格的 stock_committed 鍵含 variantId');

-- T12 現貨不足 → 擋單且庫存不動
DO $$
DECLARE v_before integer;
BEGIN
  v_before := pg_temp.stock_of(-10, -11);
  BEGIN
    INSERT INTO public.consumer_orders (id, store_id, customer_name, items, items_json, total_amount, status)
    VALUES (-103, -1, '測試客', '現貨商品 紅/M × 99',
      '[{"id":-10,"variantId":-11,"variantLabel":"紅 / M","name":"現貨商品","qty":99,"price":500}]'::jsonb,
      49500, '待確認');
    RAISE EXCEPTION 'FAIL  T12 現貨不足應該要擋單，但沒擋';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%庫存不足%' THEN RAISE; END IF;
    RAISE NOTICE 'PASS  T12 現貨不足擋單，訊息：%', SQLERRM;
  END;
  PERFORM pg_temp.assert_eq(pg_temp.stock_of(-10, -11), v_before, 'T12 被擋下時庫存一件都沒動');
END $$;

-- T13 限時單商品：不檢查，可為負
INSERT INTO public.consumer_orders (id, store_id, customer_name, items, items_json, total_amount, status)
VALUES (-104, -1, '測試客', '限時單商品 × 5',
  '[{"id":-30,"name":"限時單商品","qty":5,"price":500}]'::jsonb, 2500, '待確認');
SELECT pg_temp.assert_eq(pg_temp.stock_of(-30, NULL), -5, 'T13 限時單下單 → 0→-5');

-- T14 未上架商品（後台自建訂單常見）：不套擋單規則
INSERT INTO public.consumer_orders (id, store_id, customer_name, items, items_json, total_amount, status)
VALUES (-105, -1, '測試客', '未上架商品 × 8',
  '[{"id":-40,"name":"未上架商品","qty":8,"price":500}]'::jsonb, 4000, '待確認');
SELECT pg_temp.assert_eq(pg_temp.stock_of(-40, NULL), -3, 'T14 未上架商品可扣成負 → 5→-3');

-- T15 出貨、付款狀態變更不動庫存
UPDATE public.consumer_orders SET status = '已出貨' WHERE id = -104;
SELECT pg_temp.assert_eq(pg_temp.stock_of(-30, NULL), -5, 'T15 標記已出貨 → 庫存不動');
UPDATE public.consumer_orders SET payment_status = '已付清' WHERE id = -104;
SELECT pg_temp.assert_eq(pg_temp.stock_of(-30, NULL), -5, 'T15 改付款狀態 → 庫存不動');

ROLLBACK;
