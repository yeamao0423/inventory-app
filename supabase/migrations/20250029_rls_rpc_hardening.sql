-- ============================================
-- Migration: RLS / RPC 硬化 — 上線第二租戶前的必要前置
-- 背景：表層 RLS 已正確以 store_id 隔離租戶；風險集中在「授給 anon 的
--       SECURITY DEFINER 函式缺內部授權」與一條過寬的 UPDATE policy。
-- 決策：孤兒函式直接 DROP；get_consumer_order 縮減回傳欄位（移除可枚舉 PII）。
-- ============================================

-- ========== A. 安全性修正（有實質影響）==========

-- A1) DROP 孤兒 SECURITY DEFINER 函式（app 0 引用，且 anon 可呼叫 → 跨租戶破壞面）
--     decrement_*：anon 可把任何店任何商品/規格庫存歸零（place_order 已內含扣庫存）
--     redeem_coupon：anon 可對任何訂單套券、竄改 total_amount、灌使用次數
--                    （查券未帶 store_id 為跨店；place_order/lookup_coupon 已內含同邏輯且有店別）
DROP FUNCTION IF EXISTS public.decrement_product_stock(bigint, integer);
DROP FUNCTION IF EXISTS public.decrement_variant_stock(bigint, integer);
DROP FUNCTION IF EXISTS public.redeem_coupon(text, numeric, text, bigint);

-- A2) refund_coupon：補內部授權（依訂單所屬店檢查角色）+ 收回 anon EXECUTE
--     只有本店 editor 以上可退券（與 consumer_orders 編輯權一致）
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

    -- 授權：限本店 super_admin / admin / editor
    IF NOT public.has_store_role(v_order.store_id, ARRAY['super_admin','admin','editor']) THEN
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

-- 注意：函式預設 GRANT EXECUTE TO PUBLIC，anon 透過 PUBLIC 繼承；
-- 必須 REVOKE FROM PUBLIC 才真正擋掉 anon，再 GRANT 回需要的角色。
REVOKE EXECUTE ON FUNCTION public.refund_coupon(bigint) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.refund_coupon(bigint) TO authenticated;

-- A3) recalc_member_level：收回 anon（authenticated 保留：被 promote_member 於消費者登入時
--     內部呼叫，且後台 MembersPage 也直呼）。
--     殘留風險低且無害：本函式只「依實際訂單重算為正確等級」並跳過 level_locked，
--     不能塞任意等級；故僅移除匿名攻擊面即可。
REVOKE EXECUTE ON FUNCTION public.recalc_member_level(bigint, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.recalc_member_level(bigint, text) TO authenticated;

-- A4) get_consumer_order：縮減回傳欄位，移除可被匿名枚舉的 PII
--     （姓名/電話/地址/line_id/note/store_name/store_number 全部不再外洩）
--     僅保留完成頁實際需要的欄位。
CREATE OR REPLACE FUNCTION public.get_consumer_order(p_order_id bigint)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'id', co.id,
    'email', co.email,
    'remittance_last5', co.remittance_last5,
    'items', co.items,
    'total_amount', co.total_amount,
    'discount_amount', co.discount_amount
  )
  FROM consumer_orders co WHERE co.id = p_order_id
$function$;

-- A5) consumer_orders UPDATE policy：排除 viewer（原 is_store_member 含 viewer，違反唯讀定義）
--     保留 editor 以上 + 訂單本人（消費者於商城自行取消用 email 比對）
DROP POLICY IF EXISTS "members or owner update consumer_orders" ON public.consumer_orders;
DROP POLICY IF EXISTS "staff or owner update consumer_orders" ON public.consumer_orders;
CREATE POLICY "staff or owner update consumer_orders" ON public.consumer_orders
  FOR UPDATE TO authenticated
  USING (has_store_role(store_id, ARRAY['super_admin','admin','editor'])
         OR email = ((SELECT auth.jwt()) ->> 'email'))
  WITH CHECK (has_store_role(store_id, ARRAY['super_admin','admin','editor'])
         OR email = ((SELECT auth.jwt()) ->> 'email'));

-- ========== B. 衛生性收斂（零功能風險，消 advisor 警告）==========

-- B1) 純 trigger / event 函式：本就不該當 RPC 被呼叫，從 PUBLIC 全部收回
--     （trigger 觸發以表擁有者執行，與 invoker EXECUTE 無關，不影響觸發）
REVOKE EXECUTE ON FUNCTION public.assign_store_order_no()      FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.recalc_member_level_trg()    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.seed_default_member_level()  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user()            FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_updated_at()          FROM PUBLIC, anon, authenticated;

-- B2) 自帶授權檢查的後台 RPC：從 PUBLIC 收回後只 GRANT 回 authenticated
--     （函式內已自驗角色；anon 不再能透過 PUBLIC 呼叫）
REVOKE EXECUTE ON FUNCTION public.import_members(bigint, jsonb)                  FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.import_members(bigint, jsonb)                  TO authenticated;
REVOKE EXECUTE ON FUNCTION public.list_members(bigint)                          FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.list_members(bigint)                          TO authenticated;
REVOKE EXECUTE ON FUNCTION public.set_member_level(bigint, bigint, uuid, bigint) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.set_member_level(bigint, bigint, uuid, bigint) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.get_my_membership(bigint)                     FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_my_membership(bigint)                     TO authenticated;
REVOKE EXECUTE ON FUNCTION public.promote_member(bigint)                        FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.promote_member(bigint)                        TO authenticated;

-- 註：is_platform_admin / is_store_member / has_store_role / shares_store / member_level_for
--     為 RLS policy 內部呼叫的 helper，必須保留 anon+authenticated EXECUTE，不可收回。
