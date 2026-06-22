-- ============================================
-- Migration: Phase 4 — consumer_orders 接上會員身分（consumer_id）
-- 問題：consumer_orders 只內嵌 email、沒有 consumer_id。實測 63 筆有 34 筆 email
--       對不到任何 consumers；會員等級累積（member_qualifying）只能靠 email 字串聚合，
--       訪客 / 改 email / 大小寫不一致都會算錯。這也是 imported_members 補丁存在的根因。
-- 解法：
--   1) 加 consumer_id（nullable，訪客可空）+ index + FK
--   2) 回填既有訂單（normalize_email 命中 consumers 者）
--   3) place_order：登入會員下單時寫入 consumer_id（只認 consumers 內的身分，訪客/員工為 NULL）
--   4) member_qualifying：以 consumer_id 為主、email 為 fallback 聚合（嚴格 superset，不漏算舊單）
-- ============================================

-- ========== 1) 欄位 + 索引 ==========
ALTER TABLE public.consumer_orders
  ADD COLUMN IF NOT EXISTS consumer_id uuid REFERENCES public.consumers(id);

CREATE INDEX IF NOT EXISTS consumer_orders_consumer_id_idx ON public.consumer_orders(consumer_id);

-- ========== 2) 回填既有訂單 ==========
UPDATE public.consumer_orders co
SET consumer_id = c.id
FROM public.consumers c
WHERE co.consumer_id IS NULL
  AND co.email IS NOT NULL
  AND public.normalize_email(c.email) = public.normalize_email(co.email);

-- ========== 3) place_order：寫入 consumer_id ==========
-- 變更點：新增 v_consumer_id；下單者若為 consumers 內的登入會員則回填（auth.uid()）；
-- INSERT 帶入 consumer_id。其餘邏輯與 20250024 版完全相同。
-- 同時補上 SET search_path = public（CREATE OR REPLACE 會清掉 Phase 1 的 ALTER，故在此一併設定）。
CREATE OR REPLACE FUNCTION public.place_order(
  p_customer_name text, p_email text, p_phone text, p_address text,
  p_store_name text, p_store_number text, p_line_id text, p_remittance_last5 text,
  p_note text, p_items text, p_items_json jsonb, p_total_amount numeric,
  p_shipping_fee integer DEFAULT 0, p_coupon_code text DEFAULT NULL::text,
  p_subtotal numeric DEFAULT NULL::numeric, p_consumer_email text DEFAULT NULL::text,
  p_store_id bigint DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
DECLARE
  v_order_id bigint;
  v_store_order_no bigint;
  v_item jsonb;
  v_stock integer;
  v_product_name text;
  v_variant_label text;
  v_coupon record;
  v_coupon_code record;
  v_coupon_id bigint := NULL;
  v_coupon_code_id bigint := NULL;
  v_is_unique boolean := false;
  v_discount numeric := 0;
  v_usage_count integer;
  v_final_total numeric;
  v_consumer_id uuid := NULL;
BEGIN
  -- ========== 0) STORE CHECK ==========
  IF NOT EXISTS (SELECT 1 FROM public.stores WHERE id = p_store_id AND is_active) THEN
    RAISE EXCEPTION '商店不存在或已停用';
  END IF;

  -- ========== 0b) 解析下單會員（只認 consumers 內的身分；訪客/員工為 NULL）==========
  IF auth.uid() IS NOT NULL THEN
    SELECT id INTO v_consumer_id FROM public.consumers WHERE id = auth.uid();
  END IF;

  -- ========== 1) STOCK CHECK ==========
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items_json)
  LOOP
    IF (v_item->>'isCollection')::boolean IS TRUE THEN
      CONTINUE;
    END IF;

    IF v_item->>'variantId' IS NOT NULL AND v_item->>'variantId' != '' THEN
      SELECT pv.stock INTO v_stock
      FROM public.product_variants pv
      WHERE pv.id = (v_item->>'variantId')::bigint
      FOR UPDATE;

      IF v_stock IS NULL THEN
        RAISE EXCEPTION '商品規格不存在 (variant_id: %)', v_item->>'variantId';
      END IF;

      IF v_stock < (v_item->>'qty')::integer THEN
        SELECT p.name INTO v_product_name
        FROM public.products p
        JOIN public.product_variants pv ON pv.product_id = p.id
        WHERE pv.id = (v_item->>'variantId')::bigint;

        v_variant_label := COALESCE(v_item->>'variantLabel', '');
        RAISE EXCEPTION '庫存不足：「%」%，剩餘 % 件',
          COALESCE(v_product_name, v_item->>'name'),
          CASE WHEN v_variant_label != '' THEN ' (' || v_variant_label || ')' ELSE '' END,
          v_stock;
      END IF;
    ELSE
      SELECT p.quantity INTO v_stock
      FROM public.products p
      WHERE p.id = (v_item->>'id')::bigint
      FOR UPDATE;

      IF v_stock IS NULL THEN
        RAISE EXCEPTION '商品不存在 (product_id: %)', v_item->>'id';
      END IF;

      IF v_stock < (v_item->>'qty')::integer THEN
        SELECT p.name INTO v_product_name
        FROM public.products p
        WHERE p.id = (v_item->>'id')::bigint;

        RAISE EXCEPTION '庫存不足：「%」，剩餘 % 件',
          COALESCE(v_product_name, v_item->>'name'),
          v_stock;
      END IF;
    END IF;
  END LOOP;

  -- ========== 2) COUPON VALIDATION ==========
  IF p_coupon_code IS NOT NULL AND p_coupon_code != '' THEN
    SELECT * INTO v_coupon
      FROM public.coupons
      WHERE code = p_coupon_code AND type = 'shared' AND store_id = p_store_id
      FOR UPDATE;

    IF v_coupon IS NULL THEN
      SELECT * INTO v_coupon_code
        FROM public.coupon_codes
        WHERE code = p_coupon_code
        FOR UPDATE;

      IF v_coupon_code IS NULL THEN
        RAISE EXCEPTION '優惠碼不存在：%', p_coupon_code;
      END IF;

      IF v_coupon_code.is_used THEN
        RAISE EXCEPTION '此優惠碼已被使用';
      END IF;

      SELECT * INTO v_coupon
        FROM public.coupons
        WHERE id = v_coupon_code.coupon_id
        FOR UPDATE;

      IF v_coupon.store_id != p_store_id THEN
        RAISE EXCEPTION '優惠碼不存在：%', p_coupon_code;
      END IF;

      v_is_unique := true;
      v_coupon_code_id := v_coupon_code.id;
    END IF;

    v_coupon_id := v_coupon.id;

    -- Check coupon status
    IF NOT v_coupon.is_active THEN
      RAISE EXCEPTION '此優惠活動已停用';
    END IF;

    IF now() < v_coupon.starts_at THEN
      RAISE EXCEPTION '此優惠尚未開始';
    END IF;

    IF v_coupon.expires_at IS NOT NULL AND now() > v_coupon.expires_at THEN
      RAISE EXCEPTION '此優惠碼已過期';
    END IF;

    -- Check usage limits
    IF NOT v_is_unique AND v_coupon.max_usage IS NOT NULL AND v_coupon.usage_count >= v_coupon.max_usage THEN
      RAISE EXCEPTION '此優惠碼已達使用上限';
    END IF;

    -- Check member level eligibility（限定等級＝需登入會員）
    IF array_length(v_coupon.allowed_level_ids, 1) IS NOT NULL THEN
      IF auth.uid() IS NULL THEN
        RAISE EXCEPTION '此優惠僅限會員使用，請先登入';
      END IF;
      IF NOT (public.member_level_for(p_store_id, auth.uid()) = ANY (v_coupon.allowed_level_ids)) THEN
        RAISE EXCEPTION '您的會員等級不符合此優惠的使用資格';
      END IF;
    END IF;

    -- Check per-consumer limit
    IF v_coupon.per_consumer_limit IS NOT NULL THEN
      SELECT COUNT(*) INTO v_usage_count
        FROM public.coupon_usage
        WHERE coupon_id = v_coupon_id
          AND consumer_email = p_consumer_email;

      IF v_usage_count >= v_coupon.per_consumer_limit THEN
        RAISE EXCEPTION '您已使用過此優惠';
      END IF;
    END IF;

    -- Check minimum amount
    IF p_subtotal < v_coupon.min_amount THEN
      RAISE EXCEPTION '未達最低消費 NT$%', v_coupon.min_amount::text;
    END IF;

    -- Calculate discount
    IF v_coupon.discount_type = 'fixed' THEN
      v_discount := LEAST(v_coupon.discount_value, p_subtotal);
    ELSE
      v_discount := p_subtotal * (v_coupon.discount_value / 100.0);
      IF v_coupon.max_discount IS NOT NULL THEN
        v_discount := LEAST(v_discount, v_coupon.max_discount);
      END IF;
      v_discount := LEAST(v_discount, p_subtotal);
    END IF;

    v_discount := ROUND(v_discount);
  END IF;

  -- ========== 3) DEDUCT STOCK ==========
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items_json)
  LOOP
    IF (v_item->>'isCollection')::boolean IS TRUE THEN
      CONTINUE;
    END IF;

    IF v_item->>'variantId' IS NOT NULL AND v_item->>'variantId' != '' THEN
      UPDATE public.product_variants
      SET stock = stock - (v_item->>'qty')::integer
      WHERE id = (v_item->>'variantId')::bigint;
    ELSE
      UPDATE public.products
      SET quantity = quantity - (v_item->>'qty')::integer
      WHERE id = (v_item->>'id')::bigint;
    END IF;
  END LOOP;

  -- ========== 4) CREATE ORDER ==========
  v_final_total := p_total_amount - v_discount;

  INSERT INTO public.consumer_orders (
    store_id,
    consumer_id,
    customer_name, email, phone, address,
    store_name, store_number, line_id, remittance_last5,
    note, items, items_json, total_amount, shipping_fee,
    coupon_id, discount_amount,
    payment_status, status
  ) VALUES (
    p_store_id,
    v_consumer_id,
    p_customer_name, p_email, p_phone, p_address,
    p_store_name, p_store_number, p_line_id, p_remittance_last5,
    p_note, p_items, p_items_json, v_final_total, p_shipping_fee,
    v_coupon_id,
    v_discount,
    '未付', '待確認'
  )
  RETURNING id, store_order_no INTO v_order_id, v_store_order_no;

  -- ========== 5) RECORD COUPON USAGE ==========
  IF v_coupon_id IS NOT NULL THEN
    UPDATE public.coupons
      SET usage_count = usage_count + 1, updated_at = now()
      WHERE id = v_coupon_id;

    IF v_is_unique THEN
      UPDATE public.coupon_codes
        SET is_used = true, used_by = p_consumer_email,
            used_at = now(), order_id = v_order_id
        WHERE id = v_coupon_code_id;
    END IF;

    INSERT INTO public.coupon_usage (coupon_id, coupon_code_id, order_id, consumer_email, discount_amount)
      VALUES (v_coupon_id, v_coupon_code_id, v_order_id, p_consumer_email, v_discount);
  END IF;

  -- ========== 6) RETURN ==========
  RETURN jsonb_build_object(
    'ok', true,
    'order_id', v_order_id,
    'store_order_no', v_store_order_no,
    'discount_amount', v_discount
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

-- ========== 4) member_qualifying：consumer_id 為主、email 為 fallback ==========
-- 嚴格 superset：原本 email 命中的單照算，另外多認「consumer_id 命中但 email 不同」的未來單
--（登入會員用不同收件 email 下單也能正確累積）。同時補 SET search_path = public。
CREATE OR REPLACE FUNCTION public.member_qualifying(
  p_store_id bigint, p_email text, p_registered_at timestamp with time zone,
  p_base_amount numeric DEFAULT 0, p_base_orders integer DEFAULT 0)
 RETURNS TABLE(amount numeric, orders integer)
 LANGUAGE sql
 STABLE
 SET search_path = public
AS $function$
  SELECT
    p_base_amount + COALESCE(SUM(co.total_amount - COALESCE(co.shipping_fee, 0)), 0),
    p_base_orders + COALESCE(COUNT(*), 0)::int
  FROM public.consumer_orders co
  WHERE co.store_id = p_store_id
    AND co.payment_status = '已付清'
    AND (p_registered_at IS NULL OR co.created_at >= p_registered_at)
    AND (
      co.consumer_id = (
        SELECT id FROM public.consumers
        WHERE public.normalize_email(email) = public.normalize_email(p_email)
      )
      OR public.normalize_email(co.email) = public.normalize_email(p_email)
    );
$function$;
