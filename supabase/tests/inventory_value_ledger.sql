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

-- L10 receive_batch_inventory 觸發一次 → history 只多「一筆」帶成本的列
-- （不是舊格式一筆 + trigger 新格式一筆）。用 id 水位線鎖定「這次呼叫新增的列」，
-- 不能用 created_at（同一個交易內 now() 是凍結的，篩不出東西）。
INSERT INTO public.procurement_batches (id, store_id, batch_date, source, status, inventory_synced)
VALUES (-1, -1, '2026-08-18', '採購彙整', 'done', false);
INSERT INTO public.procurement_items (id, batch_id, product_id, variant_id, quantity, actual_qty, unit_cost, status)
VALUES (-1, -1, -10, NULL, 3, 3, 90, 'bought');

SELECT max(id) AS v FROM public.history \gset l10_before_
SELECT public.receive_batch_inventory(-1);
SELECT pg_temp.assert_eq(
  (SELECT count(*)::integer FROM public.history
    WHERE id > :l10_before_v AND product_id = -10 AND variant_id IS NULL), 1,
  'L10 批次入庫只多一筆 history（trigger 產生，不是新舊格式各一筆）');
-- 入庫前：stock=7, avg=1750/15（L2 併算後的值）。入庫 +3 件，這批成本讀
-- products.cost（此時是 150，L2 設的，不是 procurement_items.unit_cost=90——trigger 不讀那欄）。
-- 新平均 = (7×(1750/15) + 3×150) / 10
SELECT pg_temp.assert_eq(round(pg_temp.latest_avg(-10, NULL), 2),
  round((7 * (1750.0/15) + 3 * 150) / 10, 2), 'L10b 入庫後平均成本正確併算');
SELECT pg_temp.assert_eq(pg_temp.latest_value(-10, NULL), 10::numeric * pg_temp.latest_avg(-10, NULL),
  'L10c 入庫後價值 = 新庫存(10) × 新平均');

-- L11 delete_batch 退庫 → 同上，且退庫後庫存/平均成本正確回到入庫前的狀態
SELECT max(id) AS v FROM public.history \gset l11_before_
SELECT public.delete_batch(-1);
SELECT pg_temp.assert_eq(
  (SELECT count(*)::integer FROM public.history
    WHERE id > :l11_before_v AND product_id = -10 AND variant_id IS NULL AND change < 0), 1,
  'L11 退庫只多一筆 history');
SELECT pg_temp.assert_eq(
  (SELECT resulting_stock FROM public.history WHERE product_id = -10 AND variant_id IS NULL ORDER BY id DESC LIMIT 1),
  7, 'L11b 退庫後庫存回到入庫前的 7 件');

-- L12 期初基準：對每個現有商品/規格各有一筆起點，數字與 stock×cost 一致
-- （用一個全新的商品，模擬「migration 上線前就存在、從沒被 trigger 記錄過」的情況）
INSERT INTO public.products (id, name, quantity, unit, store_id, cost, currency) VALUES
  (-40, '丁商品（模擬舊資料）', 8, '個', -1, 50, 'TWD');
SELECT public.seed_inventory_value_opening_balance();
SELECT pg_temp.assert_eq(pg_temp.latest_avg(-40, NULL), 50::numeric, 'L12 期初基準：平均成本=現在成本');
SELECT pg_temp.assert_eq(pg_temp.latest_value(-40, NULL), 400::numeric, 'L12 期初基準：價值=8×50');
SELECT pg_temp.assert_eq(
  (SELECT reason FROM public.history WHERE product_id = -40 ORDER BY id DESC LIMIT 1),
  '期初基準：庫存價值追蹤上線', 'L12b reason 正確標註');

-- L13 打包：結算後主表只剩期初列＋新異動，history_archive 有完整舊明細，餘額對得起來。
-- 整個測試檔在同一個交易裡，now() 是凍結的（回傳交易開始時間），沒辦法讓真實時間流逝來
-- 製造「新舊資料」的落差，所以先把測試資料的 created_at 往前調一天，模擬「這些是上一期的舊資料」，
-- 只調測試店（store_id=-1）的列，不影響其他資料。
UPDATE public.history SET created_at = created_at - interval '1 day' WHERE store_id = -1;

DO $$
DECLARE
  v_stock_before numeric;
  v_avg_before   numeric;
BEGIN
  SELECT resulting_stock, avg_cost_twd INTO v_stock_before, v_avg_before
    FROM public.history WHERE product_id = -10 AND variant_id IS NULL ORDER BY id DESC LIMIT 1;
  PERFORM set_config('pg_temp.stock_before', v_stock_before::text, true);
  PERFORM set_config('pg_temp.avg_before', v_avg_before::text, true);
END $$;

SELECT public.close_inventory_history_period();

SELECT pg_temp.assert_eq(
  (SELECT count(*)::integer FROM public.history WHERE product_id = -10 AND variant_id IS NULL), 1,
  'L13 結算後甲商品主表只剩 1 筆期初餘額列');
SELECT pg_temp.assert_eq(
  (SELECT resulting_stock FROM public.history WHERE product_id = -10 AND variant_id IS NULL ORDER BY id DESC LIMIT 1)::text,
  current_setting('pg_temp.stock_before'), 'L13b 新期初列的庫存跟結算前最後一筆一致');
SELECT pg_temp.assert_eq(
  (SELECT avg_cost_twd FROM public.history WHERE product_id = -10 AND variant_id IS NULL ORDER BY id DESC LIMIT 1)::text,
  current_setting('pg_temp.avg_before'), 'L13c 新期初列的平均成本跟結算前最後一筆一致');
SELECT pg_temp.assert_eq(
  (SELECT count(*)::integer FROM public.history_archive WHERE product_id = -10 AND variant_id IS NULL) >= 3, true,
  'L13d 舊明細（至少 L1/L2/L3 那 3 筆）搬進了封存表');

ROLLBACK;
