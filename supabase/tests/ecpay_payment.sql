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

ROLLBACK;
