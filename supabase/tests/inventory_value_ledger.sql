-- 庫存價值帳本測試。可重複執行：全程在一個交易內，最後 ROLLBACK。
-- 跑法：psql "postgresql://postgres:postgres@127.0.0.1:54332/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/inventory_value_ledger.sql
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

CREATE OR REPLACE FUNCTION pg_temp.latest_avg(p_pid bigint, p_vid bigint)
RETURNS numeric LANGUAGE sql AS $$
  SELECT avg_cost_twd FROM public.history
   WHERE product_id = p_pid AND variant_id IS NOT DISTINCT FROM p_vid
   ORDER BY id DESC LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION pg_temp.latest_value(p_pid bigint, p_vid bigint)
RETURNS numeric LANGUAGE sql AS $$
  SELECT resulting_value_twd FROM public.history
   WHERE product_id = p_pid AND variant_id IS NOT DISTINCT FROM p_vid
   ORDER BY id DESC LIMIT 1;
$$;

INSERT INTO public.stores (id, name, is_active) VALUES (-1, '測試店', true);
INSERT INTO public.exchange_rates (currency, rate) VALUES ('JPY', 0.22) ON CONFLICT (currency) DO UPDATE SET rate = 0.22;

INSERT INTO public.products (id, name, quantity, unit, store_id, cost, currency) VALUES
  (-10, '甲商品（無規格）', 0, '個', -1, 100, 'TWD'),
  (-20, '乙商品（有規格）', 0, '個', -1, NULL, 'TWD');
INSERT INTO public.product_variants (id, product_id, store_id, options, stock, variant_cost) VALUES
  (-21, -20, -1, '{}'::jsonb, 0, 100);

-- L1 進貨：0 → 10 件，成本 100 TWD/件 → 平均成本直接等於這筆成本
UPDATE public.products SET quantity = 10 WHERE id = -10;
SELECT pg_temp.assert_eq(pg_temp.latest_avg(-10, NULL), 100::numeric, 'L1 第一次進貨，平均成本=這筆成本');
SELECT pg_temp.assert_eq(pg_temp.latest_value(-10, NULL), 1000::numeric, 'L1 庫存價值 = 10×100');

-- L2 再進貨：10→15 件，這次成本改 150 → 加權平均 (10×100+5×150)/15 ≈ 116.7
UPDATE public.products SET cost = 150 WHERE id = -10;
UPDATE public.products SET quantity = 15 WHERE id = -10;
SELECT pg_temp.assert_eq(round(pg_temp.latest_avg(-10, NULL), 1), 116.7::numeric, 'L2 加權平均正確併算');

-- L3 賣出：15→7 件（訂單/人工都算同一種 UPDATE）→ 平均成本不變，價值照平均扣減
UPDATE public.products SET quantity = 7 WHERE id = -10;
SELECT pg_temp.assert_eq(round(pg_temp.latest_avg(-10, NULL), 1), 116.7::numeric, 'L3 賣出後平均成本不變');
SELECT pg_temp.assert_eq(round(pg_temp.latest_value(-10, NULL), 1), 816.7::numeric, 'L3 庫存價值 = 7×116.7');

-- L4 規格庫存：0→20 件，成本用 variant_cost（100）
UPDATE public.product_variants SET stock = 20 WHERE id = -21;
SELECT pg_temp.assert_eq(pg_temp.latest_avg(-20, -21), 100::numeric, 'L4 規格用 variant_cost 起算平均');

-- L5 規格賣到剛好 0 → 下一次進貨的平均成本要能正確接續（不是 0÷0 出錯）
UPDATE public.product_variants SET stock = 0 WHERE id = -21;
SELECT pg_temp.assert_eq(pg_temp.latest_avg(-20, -21), 100::numeric, 'L5 扣到 0，平均成本記憶還在');
UPDATE public.product_variants SET variant_cost = 200 WHERE id = -21;
UPDATE public.product_variants SET stock = 5 WHERE id = -21;
SELECT pg_temp.assert_eq(pg_temp.latest_avg(-20, -21), 200::numeric, 'L5b 從 0 再進貨 → 全部權重給新成本');

-- L6 超賣成負庫存後再進貨：加權基準用 max(舊庫存,0)，不能被負數污染
UPDATE public.product_variants SET stock = -3 WHERE id = -21;
SELECT pg_temp.assert_eq(pg_temp.latest_avg(-20, -21), 200::numeric, 'L6 超賣時平均成本不變');
UPDATE public.product_variants SET variant_cost = 150 WHERE id = -21;
UPDATE public.product_variants SET stock = 2 WHERE id = -21;
SELECT pg_temp.assert_eq(pg_temp.latest_avg(-20, -21), 150::numeric, 'L6b 從負庫存進貨 → 權重歸零，平均=這批成本');

-- L7 缺成本的商品：resulting_value_twd 要是 null，不能靜默當 0
INSERT INTO public.products (id, name, quantity, unit, store_id, cost, currency) VALUES
  (-30, '丙商品（沒填成本）', 0, '個', -1, NULL, 'TWD');
UPDATE public.products SET quantity = 5 WHERE id = -30;
SELECT pg_temp.assert_eq(pg_temp.latest_avg(-30, NULL), NULL::numeric, 'L7 缺成本 → avg_cost_twd 是 null');
SELECT pg_temp.assert_eq(pg_temp.latest_value(-30, NULL), NULL::numeric, 'L7 缺成本 → resulting_value_twd 是 null，不是 0');

-- L8 同值覆寫（delta=0）不該多寫一筆
SELECT pg_temp.assert_eq(
  (SELECT count(*)::integer FROM public.history WHERE product_id = -10 AND variant_id IS NULL), 3,
  'L8 甲商品目前應該有 3 筆（L1/L2/L3），覆寫同值不多寫');
UPDATE public.products SET quantity = 7 WHERE id = -10;
SELECT pg_temp.assert_eq(
  (SELECT count(*)::integer FROM public.history WHERE product_id = -10 AND variant_id IS NULL), 3,
  'L8b 同值覆寫（7→7）不多寫一筆');

-- L9 非 authenticated 角色（模擬商城 anon/其他角色觸發的庫存變動）也要能正常寫入 history，
-- 不能因為 trigger 不是 definer 權限被 RLS 擋下、讓整個交易失敗
DO $$
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  UPDATE public.products SET quantity = 20 WHERE id = -30;
  PERFORM set_config('request.jwt.claims', '', true);
END $$;
SELECT pg_temp.assert_eq(
  (SELECT count(*)::integer FROM public.history WHERE product_id = -30), 2,
  'L9 anon 角色觸發的庫存變動一樣寫進 history（SECURITY DEFINER 生效）');

ROLLBACK;
