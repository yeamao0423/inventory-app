-- 綠界收款/棄單清理的 RPC 測試。可重複執行：全程在一個交易內，最後 ROLLBACK。
-- 跑法：psql "postgresql://postgres:postgres@127.0.0.1:54332/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/ecpay_payment.sql
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

-- 建測試商品與訂單。注意：不手動扣庫存——reconcile_stock trigger 會在 INSERT 時扣。
CREATE OR REPLACE FUNCTION pg_temp.setup_order(p_qty int, p_stock int, p_total numeric)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_pid bigint; v_oid bigint;
BEGIN
  INSERT INTO public.products (store_id, name, quantity, cost, currency)
  VALUES (1, 'TEST綠界商品', p_stock, 0, 'TWD') RETURNING id INTO v_pid;

  INSERT INTO public.consumer_orders (
    store_id, customer_name, email, phone, items, items_json,
    total_amount, paid_amount, payment_method, status
  ) VALUES (
    1, 'TEST客', 't@test.local', '0900000000', 'TEST綠界商品',
    jsonb_build_array(jsonb_build_object('id', v_pid, 'qty', p_qty)),
    p_total, 0, 'credit', '處理中'
  ) RETURNING id INTO v_oid;

  RETURN v_oid;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.pid_of(p_oid bigint)
RETURNS bigint LANGUAGE sql AS $$
  SELECT (items_json->0->>'id')::bigint FROM public.consumer_orders WHERE id = p_oid;
$$;

CREATE OR REPLACE FUNCTION pg_temp.stock_of(p_oid bigint)
RETURNS int LANGUAGE sql AS $$
  SELECT quantity FROM public.products WHERE id = pg_temp.pid_of(p_oid);
$$;

-- ── trigger 前提：建單即佔用庫存 ──
DO $$
DECLARE v_oid bigint;
BEGIN
  v_oid := pg_temp.setup_order(2, 10, 500);
  PERFORM pg_temp.assert_eq(pg_temp.stock_of(v_oid), 8, '建單時 trigger 已扣庫存');
END $$;

-- ── cancel_abandoned_credit_orders ──
DO $$
DECLARE v_oid bigint; v_status text;
BEGIN
  v_oid := pg_temp.setup_order(1, 5, 300);

  -- 才剛建立 → 不該被掃
  PERFORM public.cancel_abandoned_credit_orders(30);
  SELECT status INTO v_status FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_status, '處理中', '30 分鐘內的未付訂單不被清理');
  PERFORM pg_temp.assert_eq(pg_temp.stock_of(v_oid), 4, '未被清理時庫存維持佔用');

  -- 假裝是 31 分鐘前建立的 → 該被掃，且 trigger 要把庫存還回去
  UPDATE public.consumer_orders SET created_at = now() - interval '31 minutes' WHERE id = v_oid;
  PERFORM public.cancel_abandoned_credit_orders(30);
  SELECT status INTO v_status FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_status, '已取消', '逾時未付的信用卡訂單被取消');
  PERFORM pg_temp.assert_eq(pg_temp.stock_of(v_oid), 5, '取消後 trigger 把庫存還回，且只還一次');

  -- 重複執行不可以再還一次
  PERFORM public.cancel_abandoned_credit_orders(30);
  PERFORM pg_temp.assert_eq(pg_temp.stock_of(v_oid), 5, '重複清理不重複回補庫存');
END $$;

-- ── 不該被波及的訂單 ──
DO $$
DECLARE v_oid bigint; v_status text;
BEGIN
  -- 匯款訂單
  v_oid := pg_temp.setup_order(1, 5, 300);
  UPDATE public.consumer_orders
    SET payment_method = 'remittance', created_at = now() - interval '10 hours' WHERE id = v_oid;
  PERFORM public.cancel_abandoned_credit_orders(30);
  SELECT status INTO v_status FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_status, '處理中', '匯款訂單不被信用卡棄單清理波及');

  -- 已收到錢的訂單（例如 notify 已經進來過）
  v_oid := pg_temp.setup_order(1, 5, 300);
  UPDATE public.consumer_orders
    SET paid_amount = 300, created_at = now() - interval '10 hours' WHERE id = v_oid;
  PERFORM public.cancel_abandoned_credit_orders(30);
  SELECT status INTO v_status FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_status, '處理中', '已收款的訂單不被當棄單清掉');

  -- 已建物流單的訂單
  v_oid := pg_temp.setup_order(1, 5, 300);
  UPDATE public.consumer_orders
    SET allpay_logistics_id = 'L123', created_at = now() - interval '10 hours' WHERE id = v_oid;
  PERFORM public.cancel_abandoned_credit_orders(30);
  SELECT status INTO v_status FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_status, '處理中', '已建物流單的訂單不被當棄單清掉');
END $$;

-- ── 退券真的有發生：cancel_abandoned_credit_orders 取消訂單時要連帶退券 ──
-- 直連 psql（本測試的執行方式）沒有 JWT，auth.uid() 為 NULL。若 refund_coupon
-- 的授權檢查沒有放行「無 JWT 的內部呼叫」，這裡會直接 RAISE EXCEPTION '無權限'
-- 讓整個 DO block 失敗——所以這則測試同時也覆蓋了 20260812130100 那支 migration。
DO $$
DECLARE
  v_oid bigint;
  v_coupon_id bigint;
  v_usage_count_after int;
  v_coupon_id_after bigint;
  v_discount_after numeric;
BEGIN
  v_oid := pg_temp.setup_order(1, 5, 270);

  INSERT INTO public.coupons (store_id, name, type, discount_type, discount_value, usage_count)
  VALUES (1, 'TEST折價券', 'shared', 'fixed', 30, 1)
  RETURNING id INTO v_coupon_id;

  UPDATE public.consumer_orders
    SET coupon_id = v_coupon_id, discount_amount = 30,
        created_at = now() - interval '31 minutes'
    WHERE id = v_oid;

  INSERT INTO public.coupon_usage (coupon_id, order_id, consumer_email, discount_amount)
  VALUES (v_coupon_id, v_oid, 't@test.local', 30);

  PERFORM public.cancel_abandoned_credit_orders(30);

  SELECT usage_count INTO v_usage_count_after FROM public.coupons WHERE id = v_coupon_id;
  PERFORM pg_temp.assert_eq(v_usage_count_after, 0, '棄單取消時優惠券 usage_count 減 1');

  SELECT coupon_id, discount_amount INTO v_coupon_id_after, v_discount_after
    FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_coupon_id_after, NULL::bigint, '棄單取消時訂單 coupon_id 變成 NULL');
  PERFORM pg_temp.assert_eq(v_discount_after, 0::numeric, '棄單取消時訂單 discount_amount 變成 0');
END $$;

-- ── apply_ecpay_payment：正常收款 ──
DO $$
DECLARE v_oid bigint; v_paid numeric; v_pstatus text; v_r jsonb;
BEGIN
  v_oid := pg_temp.setup_order(1, 5, 1000);
  PERFORM public.create_ecpay_transaction(v_oid, 'TESTTRADE001', 1000);

  v_r := public.apply_ecpay_payment('TESTTRADE001', '1', 'Credit_CreditCard');
  PERFORM pg_temp.assert_eq((v_r->>'ok')::boolean, true, 'apply 回報成功');

  SELECT paid_amount, payment_status INTO v_paid, v_pstatus
    FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_paid, 1000::numeric, '付款金額寫進 paid_amount');
  PERFORM pg_temp.assert_eq(v_pstatus, '已付清', 'payment_status 由 trigger 推導成已付清');

  -- 冪等：同一筆 trade_no 再進來一次，錢不可以算兩次
  v_r := public.apply_ecpay_payment('TESTTRADE001', '1', 'Credit_CreditCard');
  PERFORM pg_temp.assert_eq((v_r->>'already')::boolean, true, '重複通知被識別為已處理');
  SELECT paid_amount INTO v_paid FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_paid, 1000::numeric, '重複通知不重複累加金額');
END $$;

-- ── 部分付款：加購後補差額 ──
DO $$
DECLARE v_oid bigint; v_paid numeric; v_pstatus text;
BEGIN
  v_oid := pg_temp.setup_order(1, 5, 1000);
  PERFORM public.create_ecpay_transaction(v_oid, 'TESTTRADE00A', 600);
  PERFORM public.apply_ecpay_payment('TESTTRADE00A', '1', 'Credit');
  SELECT paid_amount, payment_status INTO v_paid, v_pstatus
    FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_paid, 600::numeric, '第一筆收 600');
  PERFORM pg_temp.assert_eq(v_pstatus, '部分付款', '未收滿時狀態為部分付款');

  PERFORM public.create_ecpay_transaction(v_oid, 'TESTTRADE00B', 400);
  PERFORM public.apply_ecpay_payment('TESTTRADE00B', '1', 'Credit');
  SELECT paid_amount, payment_status INTO v_paid, v_pstatus
    FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_paid, 1000::numeric, '第二筆累加到 1000');
  PERFORM pg_temp.assert_eq(v_pstatus, '已付清', '收滿後狀態為已付清');
END $$;

-- ── 付款失敗不動錢 ──
DO $$
DECLARE v_oid bigint; v_paid numeric; v_tstatus text;
BEGIN
  v_oid := pg_temp.setup_order(1, 5, 500);
  PERFORM public.create_ecpay_transaction(v_oid, 'TESTTRADE002', 500);
  PERFORM public.apply_ecpay_payment('TESTTRADE002', '0', NULL);

  SELECT paid_amount INTO v_paid FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_paid, 0::numeric, '付款失敗不累加金額');
  SELECT status INTO v_tstatus FROM public.ecpay_transactions WHERE trade_no = 'TESTTRADE002';
  PERFORM pg_temp.assert_eq(v_tstatus, 'failed', '失敗交易標記為 failed');
END $$;

-- ── 未知 trade_no ──
DO $$
DECLARE v_r jsonb;
BEGIN
  v_r := public.apply_ecpay_payment('NO_SUCH_TRADE', '1', 'Credit');
  PERFORM pg_temp.assert_eq((v_r->>'ok')::boolean, false, '未知交易編號回報失敗而非默默吞掉');
END $$;

-- ── 遲到補救：訂單已被當棄單取消，庫存夠 → 復活並重新佔用 ──
DO $$
DECLARE v_oid bigint; v_status text; v_paid numeric; v_alert text; v_r jsonb;
BEGIN
  v_oid := pg_temp.setup_order(2, 10, 800);
  PERFORM public.create_ecpay_transaction(v_oid, 'TESTTRADE003', 800);
  PERFORM pg_temp.assert_eq(pg_temp.stock_of(v_oid), 8, '建單已佔用 2 件');

  -- 模擬棄單清理跑過了
  UPDATE public.consumer_orders SET created_at = now() - interval '31 minutes' WHERE id = v_oid;
  PERFORM public.cancel_abandoned_credit_orders(30);
  PERFORM pg_temp.assert_eq(pg_temp.stock_of(v_oid), 10, '棄單清理已把庫存還回');
  SELECT status INTO v_status FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_status, '已取消', '棄單已被取消');

  -- 綠界通知遲到才進來
  v_r := public.apply_ecpay_payment('TESTTRADE003', '1', 'Credit_CreditCard');
  PERFORM pg_temp.assert_eq((v_r->>'ok')::boolean, true, '遲到通知仍被接受');

  PERFORM pg_temp.assert_eq(pg_temp.stock_of(v_oid), 8, '遲到補救讓 trigger 重新佔用庫存');
  SELECT status, paid_amount, payment_alert INTO v_status, v_paid, v_alert
    FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_status, '處理中', '訂單從已取消復活');
  PERFORM pg_temp.assert_eq(v_paid, 800::numeric, '遲到補救仍記錄收款');
  PERFORM pg_temp.assert_eq(v_alert, NULL::text, '庫存夠時不該標警示');
END $$;

-- ── 遲到補救：庫存不足 → 收錢但標警示，絕不默默吞掉 ──
DO $$
DECLARE v_oid bigint; v_pid bigint; v_alert text; v_paid numeric; v_status text;
BEGIN
  v_oid := pg_temp.setup_order(2, 2, 800);   -- 建單後庫存歸零
  v_pid := pg_temp.pid_of(v_oid);
  PERFORM public.create_ecpay_transaction(v_oid, 'TESTTRADE004', 800);

  -- 這件商品要是「現貨」才會擋單：確保它在商城上架且不跳過庫存檢查
  -- 注意：storefront_products 的唯一鍵是 product_id（非 store_id+product_id）
  INSERT INTO public.storefront_products (store_id, product_id, shop_price, skip_stock_check)
  VALUES (1, v_pid, 400, false)
  ON CONFLICT (product_id) DO UPDATE SET skip_stock_check = false, collection_end = NULL;

  UPDATE public.consumer_orders SET created_at = now() - interval '31 minutes' WHERE id = v_oid;
  PERFORM public.cancel_abandoned_credit_orders(30);
  -- 庫存被還回後立刻被別人買光
  UPDATE public.products SET quantity = 0 WHERE id = v_pid;

  PERFORM public.apply_ecpay_payment('TESTTRADE004', '1', 'Credit_CreditCard');

  SELECT payment_alert, paid_amount, status INTO v_alert, v_paid, v_status
    FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_paid, 800::numeric, '庫存不足仍要記錄已收款');
  PERFORM pg_temp.assert_eq(v_alert IS NOT NULL, true, '庫存不足時標記 payment_alert 讓店家處理');
  PERFORM pg_temp.assert_eq(v_status, '已取消', '復活失敗時狀態維持已取消，不可假裝成功');
END $$;

-- ── apply_cod_payment ──
DO $$
DECLARE v_oid bigint; v_paid numeric; v_pstatus text;
BEGIN
  v_oid := pg_temp.setup_order(1, 5, 600);
  UPDATE public.consumer_orders SET payment_method = 'cod' WHERE id = v_oid;

  PERFORM public.apply_cod_payment(v_oid);
  SELECT paid_amount, payment_status INTO v_paid, v_pstatus
    FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_paid, 600::numeric, '貨到付款取件後補滿金額');
  PERFORM pg_temp.assert_eq(v_pstatus, '已付清', '貨到付款取件後狀態為已付清');

  -- 冪等
  PERFORM public.apply_cod_payment(v_oid);
  SELECT paid_amount INTO v_paid FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_paid, 600::numeric, '重複取件通知不重複加錢');
END $$;

-- ══════════════════════════════════════════════════════════════
-- 20260812170000 / 20260812170100 的補強
-- ══════════════════════════════════════════════════════════════

-- ── C4：棄單清理的授權與 p_minutes 下限 ──
-- 註：這裡用 has_function_privilege 檢查 ACL，而不是真的 SET ROLE authenticated 去呼叫。
-- 本機 Supabase 映像檔在「以 authenticated 呼叫一支沒有 EXECUTE 權限的函式」時會讓
-- backend segfault（整個 DB 重啟），是映像檔的問題，不是這支函式的問題；catalog 檢查
-- 一樣能證明 grant 已經拿掉，而且不會把別人的本機環境弄掛。
DO $$
DECLARE v_oid bigint; v_status text; v_raised boolean := false;
BEGIN
  PERFORM pg_temp.assert_eq(
    has_function_privilege('authenticated', 'public.cancel_abandoned_credit_orders(int)', 'EXECUTE'),
    false, 'authenticated 沒有 EXECUTE 權限（消費者也是這個角色）');
  PERFORM pg_temp.assert_eq(
    has_function_privilege('anon', 'public.cancel_abandoned_credit_orders(int)', 'EXECUTE'),
    false, 'anon 沒有 EXECUTE 權限');
  -- pg_cron 的 job 以 username='postgres'（本函式 owner）執行，排程不可以被自己的授權擋住
  PERFORM pg_temp.assert_eq(
    has_function_privilege('postgres', 'public.cancel_abandoned_credit_orders(int)', 'EXECUTE'),
    true, 'postgres（pg_cron 用的身分）仍可執行棄單清理');

  -- 函式體內的授權：有 JWT 但不是平台管理員 → 直接擋掉
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000ff"}', true);
  BEGIN
    PERFORM public.cancel_abandoned_credit_orders(30);
  EXCEPTION WHEN others THEN
    v_raised := true;
  END;
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM pg_temp.assert_eq(v_raised, true, '帶 JWT 但非平台管理員時函式自己也會擋');

  -- 負數 p_minutes 會讓時間界線跑到未來，必須被夾住
  v_oid := pg_temp.setup_order(1, 5, 300);
  PERFORM public.cancel_abandoned_credit_orders(-100000);
  SELECT status INTO v_status FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_status, '處理中', 'p_minutes 為負數時被夾成下限，剛建立的訂單不被掃');

  PERFORM public.cancel_abandoned_credit_orders(0);
  SELECT status INTO v_status FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_status, '處理中', 'p_minutes 為 0 時同樣被夾成下限');
END $$;

-- ── I1：帶券的訂單被當棄單取消後，遲到通知要把券與金額一起還原 ──
-- 這則刻意把「退券」與「遲到補救」串起來：兩段各自的測試都過，不代表接起來是對的。
DO $$
DECLARE
  v_oid bigint; v_cid bigint;
  v_total numeric; v_disc numeric; v_paid numeric;
  v_pstatus text; v_status text; v_alert text;
  v_coupon_after bigint; v_usage int; v_usage_rows int;
BEGIN
  v_oid := pg_temp.setup_order(1, 5, 1000);

  INSERT INTO public.coupons (store_id, name, type, discount_type, discount_value, usage_count)
  VALUES (1, 'TEST遲到折價券', 'shared', 'fixed', 200, 1)
  RETURNING id INTO v_cid;

  -- 結帳當下：原價 1000、折 200 → 實際請款 800
  UPDATE public.consumer_orders
     SET coupon_id = v_cid, discount_amount = 200, total_amount = 800,
         created_at = now() - interval '31 minutes'
   WHERE id = v_oid;
  INSERT INTO public.coupon_usage (coupon_id, order_id, consumer_email, discount_amount)
  VALUES (v_cid, v_oid, 't@test.local', 200);

  PERFORM public.create_ecpay_transaction(v_oid, 'TESTTRADE005', 800);

  -- 綠界通知遲到 → 排程先把它當棄單取消，並退券（total_amount 被加回 200）
  PERFORM public.cancel_abandoned_credit_orders(30);
  SELECT total_amount, coupon_id INTO v_total, v_coupon_after
    FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_total, 1000::numeric, '退券後 total_amount 被加回折扣金額');
  PERFORM pg_temp.assert_eq(v_coupon_after, NULL::bigint, '退券後 coupon_id 被清空');
  PERFORM pg_temp.assert_eq(pg_temp.stock_of(v_oid), 5, '棄單取消已回補庫存');

  -- 遲到通知進來
  PERFORM public.apply_ecpay_payment('TESTTRADE005', '1', 'Credit_CreditCard');

  SELECT total_amount, discount_amount, paid_amount, payment_status, status,
         payment_alert, coupon_id
    INTO v_total, v_disc, v_paid, v_pstatus, v_status, v_alert, v_coupon_after
    FROM public.consumer_orders WHERE id = v_oid;

  PERFORM pg_temp.assert_eq(v_status, '處理中', '遲到補救讓訂單復活');
  PERFORM pg_temp.assert_eq(pg_temp.stock_of(v_oid), 4, '復活後 trigger 重新佔用庫存');
  PERFORM pg_temp.assert_eq(v_total, 800::numeric, '復活時 total_amount 還原成折扣後金額');
  PERFORM pg_temp.assert_eq(v_disc, 200::numeric, '復活時 discount_amount 還原');
  PERFORM pg_temp.assert_eq(v_coupon_after, v_cid, '復活時優惠券掛回訂單');
  PERFORM pg_temp.assert_eq(v_paid, 800::numeric, '記入當初請款的折扣後金額');
  PERFORM pg_temp.assert_eq(v_pstatus, '已付清', '付清的客人不可被顯示成部分付款');
  PERFORM pg_temp.assert_eq(v_alert, NULL::text, '正常還原時不該標警示');

  SELECT usage_count INTO v_usage FROM public.coupons WHERE id = v_cid;
  PERFORM pg_temp.assert_eq(v_usage, 1, '優惠券用量還原回 1');
  SELECT count(*) INTO v_usage_rows FROM public.coupon_usage WHERE order_id = v_oid;
  PERFORM pg_temp.assert_eq(v_usage_rows, 1, 'coupon_usage 紀錄被還原');
  SELECT count(*) INTO v_usage_rows FROM public.abandoned_order_coupons WHERE order_id = v_oid;
  PERFORM pg_temp.assert_eq(v_usage_rows, 0, '還原後快照被清掉，不會被重複套用');
END $$;

-- ── I1：unique 券的碼也要還原（is_used / order_id / coupon_usage.coupon_code_id）──
DO $$
DECLARE
  v_oid bigint; v_cid bigint; v_code_id bigint;
  v_is_used boolean; v_code_order bigint; v_usage_code bigint; v_total numeric;
BEGIN
  v_oid := pg_temp.setup_order(1, 5, 1000);

  INSERT INTO public.coupons (store_id, name, type, discount_type, discount_value, usage_count)
  VALUES (1, 'TEST唯一券', 'unique', 'fixed', 150, 1)
  RETURNING id INTO v_cid;
  INSERT INTO public.coupon_codes (coupon_id, code, is_used, used_by, used_at, order_id)
  VALUES (v_cid, 'TESTUNIQ001', true, 't@test.local', now(), v_oid)
  RETURNING id INTO v_code_id;

  UPDATE public.consumer_orders
     SET coupon_id = v_cid, discount_amount = 150, total_amount = 850,
         created_at = now() - interval '31 minutes'
   WHERE id = v_oid;
  INSERT INTO public.coupon_usage (coupon_id, coupon_code_id, order_id, consumer_email, discount_amount)
  VALUES (v_cid, v_code_id, v_oid, 't@test.local', 150);

  PERFORM public.create_ecpay_transaction(v_oid, 'TESTTRADE009', 850);
  PERFORM public.cancel_abandoned_credit_orders(30);

  SELECT is_used INTO v_is_used FROM public.coupon_codes WHERE id = v_code_id;
  PERFORM pg_temp.assert_eq(v_is_used, false, '退券把唯一碼釋放回去');

  PERFORM public.apply_ecpay_payment('TESTTRADE009', '1', 'Credit_CreditCard');

  SELECT is_used, order_id INTO v_is_used, v_code_order
    FROM public.coupon_codes WHERE id = v_code_id;
  PERFORM pg_temp.assert_eq(v_is_used, true, '復活時唯一碼重新核銷');
  PERFORM pg_temp.assert_eq(v_code_order, v_oid, '唯一碼掛回原訂單');
  SELECT coupon_code_id INTO v_usage_code FROM public.coupon_usage WHERE order_id = v_oid;
  PERFORM pg_temp.assert_eq(v_usage_code, v_code_id, 'coupon_usage 也掛回唯一碼');
  SELECT total_amount INTO v_total FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_total, 850::numeric, '唯一券情境的金額同樣還原');
END $$;

-- ── I1 邊界：唯一碼在空窗期被別人用掉 → 金額仍要還原，並標警示 ──
DO $$
DECLARE
  v_oid bigint; v_other_oid bigint; v_cid bigint; v_code_id bigint;
  v_total numeric; v_paid numeric; v_pstatus text; v_alert text; v_code_order bigint;
BEGIN
  v_oid := pg_temp.setup_order(1, 5, 1000);
  v_other_oid := pg_temp.setup_order(1, 5, 1000);

  INSERT INTO public.coupons (store_id, name, type, discount_type, discount_value, usage_count)
  VALUES (1, 'TEST唯一券被搶', 'unique', 'fixed', 150, 1)
  RETURNING id INTO v_cid;
  INSERT INTO public.coupon_codes (coupon_id, code, is_used, used_by, used_at, order_id)
  VALUES (v_cid, 'TESTUNIQ002', true, 't@test.local', now(), v_oid)
  RETURNING id INTO v_code_id;

  UPDATE public.consumer_orders
     SET coupon_id = v_cid, discount_amount = 150, total_amount = 850,
         created_at = now() - interval '31 minutes'
   WHERE id = v_oid;
  INSERT INTO public.coupon_usage (coupon_id, coupon_code_id, order_id, consumer_email, discount_amount)
  VALUES (v_cid, v_code_id, v_oid, 't@test.local', 150);

  PERFORM public.create_ecpay_transaction(v_oid, 'TESTTRADE010', 850);
  PERFORM public.cancel_abandoned_credit_orders(30);

  -- 券被釋放後，另一位客人用掉了同一組碼
  UPDATE public.coupon_codes
     SET is_used = true, used_by = 'other@test.local', used_at = now(), order_id = v_other_oid
   WHERE id = v_code_id;

  PERFORM public.apply_ecpay_payment('TESTTRADE010', '1', 'Credit_CreditCard');

  SELECT total_amount, paid_amount, payment_status, payment_alert
    INTO v_total, v_paid, v_pstatus, v_alert
    FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_total, 850::numeric, '碼被搶走也要把金額還原，不能讓付清的客人變欠錢');
  PERFORM pg_temp.assert_eq(v_paid, 850::numeric, '仍記錄收款');
  PERFORM pg_temp.assert_eq(v_pstatus, '已付清', '金額口徑正確');
  PERFORM pg_temp.assert_eq(v_alert IS NOT NULL, true, '碼還不回去要標警示讓店家處理');
  SELECT order_id INTO v_code_order FROM public.coupon_codes WHERE id = v_code_id;
  PERFORM pg_temp.assert_eq(v_code_order, v_other_oid, '不可把別人已核銷的碼搶回來');
END $$;

-- ── I3：兩個分頁各發起一次全額付款 → 溢收要照實記帳並標警示 ──
DO $$
DECLARE v_oid bigint; v_paid numeric; v_pstatus text; v_alert text; v_tstatus text;
BEGIN
  v_oid := pg_temp.setup_order(1, 5, 1000);
  PERFORM public.create_ecpay_transaction(v_oid, 'TESTTRADE006', 1000);
  PERFORM public.create_ecpay_transaction(v_oid, 'TESTTRADE007', 1000);

  PERFORM public.apply_ecpay_payment('TESTTRADE006', '1', 'Credit_CreditCard');
  SELECT paid_amount, payment_alert INTO v_paid, v_alert
    FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_paid, 1000::numeric, '第一筆正常收款');
  PERFORM pg_temp.assert_eq(v_alert, NULL::text, '第一筆不該有溢收警示');

  -- 第二個分頁也刷過了：錢真的收到，不能假裝沒有
  PERFORM public.apply_ecpay_payment('TESTTRADE007', '1', 'Credit_CreditCard');
  SELECT paid_amount, payment_status, payment_alert INTO v_paid, v_pstatus, v_alert
    FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_paid, 2000::numeric, '溢收仍照實累加，不可漏記已收到的錢');
  PERFORM pg_temp.assert_eq(v_pstatus, '待退款', 'payment_status 推導成待退款');
  PERFORM pg_temp.assert_eq(v_alert LIKE '%溢收%', true, 'payment_alert 標出溢收待退款');
  PERFORM pg_temp.assert_eq(v_alert LIKE '%1000%', true, 'payment_alert 寫出溢收金額');

  SELECT status INTO v_tstatus FROM public.ecpay_transactions WHERE trade_no = 'TESTTRADE007';
  PERFORM pg_temp.assert_eq(v_tstatus, 'paid', '溢收的交易仍標為 paid，避免綠界一直重送');
END $$;

-- ── I4：復活時撞到暫時性錯誤（deadlock 等）必須往上丟，不可吞成「庫存不足」──
-- 用一個只對特定訂單發作、丟 40P01 的暫時 trigger 模擬 deadlock。
CREATE FUNCTION pg_temp_raise_transient() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'simulated deadlock' USING ERRCODE = '40P01';
END $$;

DO $$
DECLARE
  v_oid bigint; v_sqlstate text := null; v_paid numeric; v_tstatus text;
  v_status text; v_alert text;
BEGIN
  v_oid := pg_temp.setup_order(1, 5, 500);
  PERFORM public.create_ecpay_transaction(v_oid, 'TESTTRADE008', 500);
  UPDATE public.consumer_orders SET created_at = now() - interval '31 minutes' WHERE id = v_oid;
  PERFORM public.cancel_abandoned_credit_orders(30);

  EXECUTE format(
    'create trigger test_transient_boom after update of status on public.consumer_orders '
    'for each row when (new.id = %s and new.status = ''處理中'') '
    'execute function pg_temp_raise_transient()', v_oid);

  BEGIN
    PERFORM public.apply_ecpay_payment('TESTTRADE008', '1', 'Credit_CreditCard');
  EXCEPTION WHEN others THEN
    v_sqlstate := SQLSTATE;
  END;

  EXECUTE 'drop trigger if exists test_transient_boom on public.consumer_orders';

  PERFORM pg_temp.assert_eq(v_sqlstate, '40P01', '暫時性錯誤原樣往上丟，不被當成庫存不足');

  SELECT paid_amount, status, payment_alert INTO v_paid, v_status, v_alert
    FROM public.consumer_orders WHERE id = v_oid;
  SELECT status INTO v_tstatus FROM public.ecpay_transactions WHERE trade_no = 'TESTTRADE008';
  PERFORM pg_temp.assert_eq(v_paid, 0::numeric, '例外往上丟後整筆 rollback，不留半套帳');
  PERFORM pg_temp.assert_eq(v_tstatus, 'pending', '交易維持 pending，綠界重送時才有機會重來');
  PERFORM pg_temp.assert_eq(v_alert, NULL::text, '不可標成「庫存不足」誤導店家');
END $$;

DROP FUNCTION pg_temp_raise_transient();

-- ══════════════════════════════════════════════════════════════
-- 20260812170200：consumer_orders 欄位層級守衛
-- ══════════════════════════════════════════════════════════════
-- 模擬「瀏覽器直接打 PostgREST」：切成 authenticated 角色 ＋ 偽造 request.jwt.claims。
-- 不用 SET ROLE 去呼叫沒有 EXECUTE 權限的函式（那會讓本機 DB segfault），
-- 這裡只做純 UPDATE，trigger 內用到的 has_store_role / is_platform_admin / auth.uid
-- 都確認過 authenticated 有 EXECUTE。
-- 回傳 NULL ＝ 成功，否則回傳錯誤訊息。
CREATE OR REPLACE FUNCTION pg_temp.try_as(p_claims jsonb, p_sql text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_err text := null;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claims', p_claims::text, true);
    PERFORM set_config('role', 'authenticated', true);
    EXECUTE p_sql;
    PERFORM set_config('role', 'none', true);
    PERFORM set_config('request.jwt.claims', '', true);
  EXCEPTION WHEN others THEN
    v_err := SQLERRM;   -- 子交易回滾，role 與 claims 自動復原
  END;
  RETURN v_err;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.owner_claims()
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'sub',   '00000000-0000-0000-0000-0000000000aa',
    'email', 't@test.local',
    'role',  'authenticated');
$$;

-- ── 1) 本人取消訂單：唯一合法的更新，必須成功 ──
DO $$
DECLARE v_oid bigint; v_err text; v_status text;
BEGIN
  v_oid := pg_temp.setup_order(2, 10, 1000);
  PERFORM pg_temp.assert_eq(pg_temp.stock_of(v_oid), 8, '建單已佔用庫存');

  v_err := pg_temp.try_as(pg_temp.owner_claims(),
    format('update public.consumer_orders set status = ''已取消'' where id = %s', v_oid));

  PERFORM pg_temp.assert_eq(v_err, NULL::text, '本人把訂單改成已取消要成功');
  SELECT status INTO v_status FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_status, '已取消', '取消真的寫進去了（RLS 沒把整列擋掉）');
  -- 這一則同時證明 reconcile_stock 的 stock_committed 回寫沒有被守衛擋下
  PERFORM pg_temp.assert_eq(pg_temp.stock_of(v_oid), 10, '取消後 trigger 仍能回補庫存');
END $$;

-- ── 2) 核心案例：本人把 paid_amount 改成 total_amount → 必須被擋 ──
DO $$
DECLARE v_oid bigint; v_err text; v_paid numeric; v_pstatus text;
BEGIN
  v_oid := pg_temp.setup_order(1, 5, 1000);

  v_err := pg_temp.try_as(pg_temp.owner_claims(),
    format('update public.consumer_orders set paid_amount = total_amount where id = %s', v_oid));

  PERFORM pg_temp.assert_eq(v_err IS NOT NULL, true, '本人不可自行把 paid_amount 灌成已付清');
  PERFORM pg_temp.assert_eq(v_err LIKE '%只能由本人取消%', true, '錯誤訊息講人話');
  SELECT paid_amount, payment_status INTO v_paid, v_pstatus
    FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_paid, 0::numeric, 'paid_amount 沒有被改動');
  PERFORM pg_temp.assert_eq(v_pstatus, '未付', 'payment_status 維持未付');
END $$;

-- ── 3) 夾帶：同時改 status 與 paid_amount → 必須被擋 ──
DO $$
DECLARE v_oid bigint; v_err text; v_paid numeric; v_status text;
BEGIN
  v_oid := pg_temp.setup_order(1, 5, 1000);

  v_err := pg_temp.try_as(pg_temp.owner_claims(),
    format('update public.consumer_orders set status = ''已取消'', paid_amount = 99999 where id = %s', v_oid));

  PERFORM pg_temp.assert_eq(v_err IS NOT NULL, true, '不可用取消當幌子夾帶其他欄位');
  SELECT paid_amount, status INTO v_paid, v_status FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_paid, 0::numeric, '夾帶被擋下時 paid_amount 不變');
  PERFORM pg_temp.assert_eq(v_status, '處理中', '夾帶被擋下時 status 也不變');
END $$;

-- ── 4) 改 items_json（會讓 reconcile_stock 去動庫存）→ 必須被擋 ──
DO $$
DECLARE v_oid bigint; v_err text;
BEGIN
  v_oid := pg_temp.setup_order(1, 5, 1000);

  v_err := pg_temp.try_as(pg_temp.owner_claims(),
    format('update public.consumer_orders set items_json = ''[]''::jsonb where id = %s', v_oid));
  PERFORM pg_temp.assert_eq(v_err IS NOT NULL, true, '本人不可改 items_json');
  PERFORM pg_temp.assert_eq(pg_temp.stock_of(v_oid), 4, '庫存沒有被動到');

  -- stock_committed 刻意不在排除清單：灌大再取消就能回補從沒佔用過的庫存
  v_err := pg_temp.try_as(pg_temp.owner_claims(),
    format('update public.consumer_orders set stock_committed = ''{"1:":9999}''::jsonb where id = %s', v_oid));
  PERFORM pg_temp.assert_eq(v_err IS NOT NULL, true, '本人不可自行改 stock_committed');

  -- 其他金額欄位一樣擋
  v_err := pg_temp.try_as(pg_temp.owner_claims(),
    format('update public.consumer_orders set total_amount = 1 where id = %s', v_oid));
  PERFORM pg_temp.assert_eq(v_err IS NOT NULL, true, '本人不可改 total_amount');
END $$;

-- ── 5) 店員身分改 paid_amount → 必須成功（後台不受影響）──
DO $$
DECLARE v_oid bigint; v_err text; v_paid numeric; v_staff uuid;
BEGIN
  SELECT user_id INTO v_staff FROM public.user_store_roles
   WHERE store_id = 1 AND role IN ('super_admin','admin','editor') LIMIT 1;

  IF v_staff IS NULL THEN
    RAISE NOTICE 'SKIP  店員路徑（本機沒有 store_id=1 的店員帳號）';
    RETURN;
  END IF;

  v_oid := pg_temp.setup_order(1, 5, 1000);
  v_err := pg_temp.try_as(
    jsonb_build_object('sub', v_staff::text, 'email', 'staff@test.local', 'role', 'authenticated'),
    format('update public.consumer_orders set paid_amount = 1000 where id = %s', v_oid));

  PERFORM pg_temp.assert_eq(v_err, NULL::text, '店員改 paid_amount 不被守衛擋下');
  SELECT paid_amount INTO v_paid FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_paid, 1000::numeric, '店員的更新真的生效');
END $$;

-- ── 6) 無 JWT 的內部身分（service role／pg_cron／綠界 route）→ 必須成功 ──
DO $$
DECLARE v_oid bigint; v_paid numeric; v_status text;
BEGIN
  v_oid := pg_temp.setup_order(1, 5, 1000);

  UPDATE public.consumer_orders SET paid_amount = 500 WHERE id = v_oid;
  SELECT paid_amount INTO v_paid FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_paid, 500::numeric, '無 JWT 的內部更新不受守衛影響');

  -- 綠界那條路整條再跑一次，確認守衛沒有卡到 RPC
  PERFORM public.create_ecpay_transaction(v_oid, 'TESTTRADE011', 500);
  PERFORM public.apply_ecpay_payment('TESTTRADE011', '1', 'Credit_CreditCard');
  SELECT paid_amount, status INTO v_paid, v_status FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_paid, 1000::numeric, 'apply_ecpay_payment 照常記帳');
  PERFORM pg_temp.assert_eq(v_status, '處理中', '訂單狀態未受影響');
END $$;

-- ── 7) SECURITY DEFINER RPC（append_to_order）在有 JWT 的消費者身分下仍可運作 ──
-- 這是守衛最容易誤傷的一支：它 GRANT 給 anon/authenticated，卻要改
-- items_json / total_amount / updated_at。current_user 那條放行就是為了它。
DO $$
DECLARE v_oid bigint; v_pid bigint; v_token uuid; v_total numeric;
BEGIN
  v_oid := pg_temp.setup_order(1, 20, 1000);
  v_pid := pg_temp.pid_of(v_oid);
  UPDATE public.consumer_orders
     SET append_deadline = now() + interval '1 day'
   WHERE id = v_oid;
  SELECT public_token INTO v_token FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq(v_token IS NOT NULL, true, '訂單有 public_token 可供加購');

  -- append_to_order 自己有 EXCEPTION WHEN OTHERS，被擋下不會丟例外，
  -- 所以直接看副作用：品項數與金額有沒有真的變。
  PERFORM pg_temp.try_as(pg_temp.owner_claims(), format(
    'select public.append_to_order(%L::uuid, %L::jsonb)',
    v_token,
    jsonb_build_array(jsonb_build_object(
      'id', v_pid, 'qty', 1, 'price', 100, 'name', 'TEST綠界商品'))::text));

  SELECT total_amount INTO v_total FROM public.consumer_orders WHERE id = v_oid;
  PERFORM pg_temp.assert_eq((SELECT jsonb_array_length(items_json)
                               FROM public.consumer_orders WHERE id = v_oid), 2,
                            '加購品項真的併進 items_json（守衛沒卡到 SECURITY DEFINER RPC）');
  PERFORM pg_temp.assert_eq(v_total IS DISTINCT FROM 1000::numeric, true, '加購後金額有被重算');
  PERFORM pg_temp.assert_eq(pg_temp.stock_of(v_oid), 18, '加購後 trigger 多佔用 1 件');
END $$;

ROLLBACK;
