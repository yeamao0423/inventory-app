-- refund_coupon：放行無 JWT 的內部呼叫（pg_cron／service role）
--
-- 背景：20260812130000_cancel_abandoned_orders.sql 的棄單清理排程會呼叫
-- public.refund_coupon(p_order_id) 幫繞過後台 UI 的自動取消退券。但 refund_coupon
-- （最新定義見 20250029_rls_rpc_hardening.sql:20）的授權檢查
--   IF NOT public.has_store_role(v_order.store_id, ARRAY[...]) THEN RAISE EXCEPTION '無權限';
-- 跑在「訂單是否有優惠券」之前，而 has_store_role 是用 auth.uid() 查 user_store_roles。
-- 直連 DB（psql）或 pg_cron 觸發時沒有 JWT，auth.uid() 恆為 NULL，has_store_role 恆回
-- false，於是 refund_coupon 對任何訂單（不論有沒有優惠券）在這兩種呼叫路徑下都會
-- RAISE EXCEPTION '無權限'——排程如果吞掉這個例外，後果是「消費者用了折價券、信用卡
-- 棄單被排程取消、優惠券卻沒退回去」，是直接的客訴來源，不能吞。
--
-- 修法：比照同一批工作裡 20260812110000_batch_inventory_rpcs.sql:21 已經定的慣例——
--   IF auth.uid() IS NULL THEN RETURN; END IF;   -- 無 JWT ＝ 內部呼叫，放行
-- 這個放行是安全的，因為 refund_coupon 已經 REVOKE EXECUTE ... FROM PUBLIC, anon
-- （見本檔尾端重貼的 REVOKE/GRANT）：anon 完全呼叫不到這支函式，所以 auth.uid() IS NULL
-- 只可能發生在 service role、pg_cron，或其他 SECURITY DEFINER 函式的內部呼叫，
-- 不是外部可偽造的身分。
--
-- 逐字重貼整支函式（維持本 repo「改既有函式就整支重貼」的慣例），只動「授權」那一段：
-- 從「auth.uid() 有值但角色不符才擋」改成「auth.uid() 為 NULL（無 JWT）就直接放行，
-- 有 JWT 時維持原本的角色檢查」。其餘邏輯（含 coupon_id IS NULL 的早退）完全不變。
CREATE OR REPLACE FUNCTION public.refund_coupon(p_order_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_order    record;
    v_usage    record;
    v_coupon   record;
BEGIN
    SELECT * INTO v_order FROM public.consumer_orders WHERE id = p_order_id;
    IF v_order IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', '訂單不存在');
    END IF;

    -- 授權：限本店 super_admin / admin / editor。
    -- auth.uid() 為 NULL ＝ 無 JWT 的內部呼叫（service role、pg_cron、其他 SECURITY DEFINER
    -- 函式），放行；anon 走不到這裡，因為本函式已 REVOKE EXECUTE FROM PUBLIC, anon。
    -- 比照 20260812110000_batch_inventory_rpcs.sql 的既有慣例。
    IF auth.uid() IS NOT NULL
       AND NOT public.has_store_role(v_order.store_id, ARRAY['super_admin','admin','editor']) THEN
        RAISE EXCEPTION '無權限';
    END IF;

    IF v_order.coupon_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', '此訂單未使用優惠券');
    END IF;

    SELECT * INTO v_usage FROM public.coupon_usage WHERE order_id = p_order_id LIMIT 1;
    SELECT * INTO v_coupon FROM public.coupons WHERE id = v_order.coupon_id FOR UPDATE;

    UPDATE public.coupons
        SET usage_count = GREATEST(0, usage_count - 1), updated_at = now()
        WHERE id = v_coupon.id;

    IF v_coupon.type = 'unique' AND v_usage.coupon_code_id IS NOT NULL THEN
        UPDATE public.coupon_codes
            SET is_used = false, used_by = NULL, used_at = NULL, order_id = NULL
            WHERE id = v_usage.coupon_code_id;
    END IF;

    DELETE FROM public.coupon_usage WHERE order_id = p_order_id;

    UPDATE public.consumer_orders
        SET coupon_id = NULL,
            total_amount = total_amount + v_order.discount_amount,
            discount_amount = 0
        WHERE id = p_order_id;

    RETURN jsonb_build_object('ok', true, 'refunded_amount', v_order.discount_amount);
END;
$function$;

-- 重貼原本的 REVOKE/GRANT：CREATE OR REPLACE 不會動到既有權限，但重貼讓這支
-- migration 自成完整敘述，單獨重跑（例如 reset 後重套）也不會漏掉這一步。
REVOKE EXECUTE ON FUNCTION public.refund_coupon(bigint) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.refund_coupon(bigint) TO authenticated;
