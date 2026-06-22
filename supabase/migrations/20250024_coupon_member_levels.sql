-- ============================================
-- Migration: 優惠券限定會員等級
-- coupons 新增 allowed_level_ids（白名單；空陣列＝不限）。
-- 限定等級的券 = 需登入會員：訪客無等級故不可用。
-- 驗證兩處同步：lookup_coupon（預覽）、place_order（下單，權威）。
-- 前置：20250018~20250023
-- ============================================

-- ========== 1) 欄位 ==========
ALTER TABLE public.coupons
  ADD COLUMN IF NOT EXISTS allowed_level_ids bigint[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.coupons.allowed_level_ids
  IS '可使用此券的會員等級白名單；空陣列＝不限等級（所有人可用）';

-- ========== 2) helper：取會員在此店的有效等級（無明確等級回退預設） ==========
CREATE OR REPLACE FUNCTION public.member_level_for(p_store_id bigint, p_consumer_id uuid)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT sc.member_level_id FROM public.store_consumers sc
       WHERE sc.store_id = p_store_id AND sc.consumer_id = p_consumer_id),
    (SELECT id FROM public.member_levels WHERE store_id = p_store_id AND is_default LIMIT 1)
  );
$$;

GRANT EXECUTE ON FUNCTION public.member_level_for(bigint, uuid) TO authenticated, anon;

-- ========== 3) lookup_coupon：多回 allowed_level_ids 與 level_ok（預覽即時提示） ==========
CREATE OR REPLACE FUNCTION public.lookup_coupon(p_code text, p_store_id bigint)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_coupon coupons%ROWTYPE;
  v_cc coupon_codes%ROWTYPE;
  v_is_unique boolean := false;
  v_level_ok boolean;
BEGIN
  SELECT * INTO v_coupon FROM coupons
    WHERE code = p_code AND type = 'shared' AND store_id = p_store_id;

  IF v_coupon.id IS NULL THEN
    SELECT * INTO v_cc FROM coupon_codes WHERE code = p_code;
    IF v_cc.id IS NULL THEN
      RETURN jsonb_build_object('found', false);
    END IF;
    IF v_cc.is_used THEN
      RETURN jsonb_build_object('found', true, 'is_used', true);
    END IF;
    SELECT * INTO v_coupon FROM coupons WHERE id = v_cc.coupon_id AND store_id = p_store_id;
    IF v_coupon.id IS NULL THEN
      RETURN jsonb_build_object('found', false);
    END IF;
    v_is_unique := true;
  END IF;

  -- 會員等級資格：空白名單＝不限；否則需登入且等級在白名單
  v_level_ok := (array_length(v_coupon.allowed_level_ids, 1) IS NULL)
    OR (auth.uid() IS NOT NULL
        AND public.member_level_for(p_store_id, auth.uid()) = ANY (v_coupon.allowed_level_ids));

  RETURN jsonb_build_object(
    'found', true, 'is_used', false, 'is_unique', v_is_unique,
    'level_ok', v_level_ok,
    'coupon', jsonb_build_object(
      'id', v_coupon.id, 'name', v_coupon.name,
      'discount_type', v_coupon.discount_type, 'discount_value', v_coupon.discount_value,
      'min_amount', v_coupon.min_amount, 'max_discount', v_coupon.max_discount,
      'max_usage', v_coupon.max_usage, 'usage_count', v_coupon.usage_count,
      'starts_at', v_coupon.starts_at, 'expires_at', v_coupon.expires_at,
      'is_active', v_coupon.is_active,
      'allowed_level_ids', v_coupon.allowed_level_ids
    )
  );
END;
$$;

-- ========== 4) place_order：下單時權威驗證會員等級 ==========
-- 與 20250019 版相同，僅在 COUPON VALIDATION 段加入「會員等級資格」檢查。
CREATE OR REPLACE FUNCTION public.place_order(
  p_customer_name text,
  p_email text,
  p_phone text,
  p_address text,
  p_store_name text,
  p_store_number text,
  p_line_id text,
  p_remittance_last5 text,
  p_note text,
  p_items text,
  p_items_json jsonb,
  p_total_amount numeric,
  p_shipping_fee integer DEFAULT 0,
  p_coupon_code text DEFAULT NULL,
  p_subtotal numeric DEFAULT NULL,
  p_consumer_email text DEFAULT NULL,
  p_store_id bigint DEFAULT 1
)
RETURNS jsonb AS $$
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
BEGIN
  -- ========== 0) STORE CHECK ==========
  IF NOT EXISTS (SELECT 1 FROM public.stores WHERE id = p_store_id AND is_active) THEN
    RAISE EXCEPTION '商店不存在或已停用';
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
    customer_name, email, phone, address,
    store_name, store_number, line_id, remittance_last5,
    note, items, items_json, total_amount, shipping_fee,
    coupon_id, discount_amount,
    payment_status, status
  ) VALUES (
    p_store_id,
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
$$ LANGUAGE plpgsql SECURITY DEFINER;
