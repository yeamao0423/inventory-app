-- 20250036: 訂單完成頁改用不可猜 token（消除以流水號枚舉消費者 PII）
--
-- 背景：get_consumer_order(bigint) 以流水號點查，任何人遞增 /order/1、/order/2…
--       即可收割每筆訂單的 email + 匯款末五碼 + 品項 + 金額（釣魚素材）。
-- 作法：consumer_orders 新增 public_token（隨機 UUID）；完成頁改以 token 查詢，
--       token 不可猜＝等同「持有此連結者才是下單本人」。place_order 回傳 token
--       供結帳頁導向。舊的可枚舉 bigint 查詢函式一併移除。
--
-- ⚠️ 部署順序：本 migration 必須「先」套用到資料庫，再上線對應前端；
--    否則前端呼叫 get_consumer_order(uuid) / 讀取 public_token 會失敗。
-- ⚠️ place_order 以「線上實際的 22 參數版（含 ECPay 物流欄位 p_payment_method /
--    p_shipping_subtype / p_cvs_*）」為基礎修改。repo 內既有的 place_order migration
--    （最新到 20250027，17 參數）落後於實際 DB；本檔並移除該 17 參數多載，
--    避免與 22 參數版對同一組具名參數產生 "function is not unique" 歧義。

-- 1) 新增不可猜 token 欄位（既有列由 DEFAULT 自動補值，不需手動 backfill）
ALTER TABLE public.consumer_orders
  ADD COLUMN IF NOT EXISTS public_token uuid NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS consumer_orders_public_token_idx
  ON public.consumer_orders (public_token);

-- 2) 移除可枚舉的舊查詢函式，改以 token 點查（仍只回傳完成頁所需最小欄位）
DROP FUNCTION IF EXISTS public.get_consumer_order(bigint);

CREATE OR REPLACE FUNCTION public.get_consumer_order(p_token uuid)
 RETURNS jsonb
 STABLE SECURITY DEFINER
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'id', co.id,
    'store_order_no', co.store_order_no,
    'email', co.email,
    'remittance_last5', co.remittance_last5,
    'items', co.items,
    'total_amount', co.total_amount,
    'discount_amount', co.discount_amount
  )
  FROM consumer_orders co WHERE co.public_token = p_token
$function$;

REVOKE ALL ON FUNCTION public.get_consumer_order(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_consumer_order(uuid) TO anon, authenticated;

-- 3) 移除落後的 17 參數 place_order 多載（若不存在則略過），避免具名參數歧義
DROP FUNCTION IF EXISTS public.place_order(
  text, text, text, text, text, text, text, text, text, text, jsonb, numeric,
  integer, text, numeric, text, bigint);

-- 4) place_order（線上 22 參數版）新增回傳 public_token 供結帳導頁。
--    僅 3 處改動：宣告 v_public_token、RETURNING 帶回 public_token、回傳 jsonb 加入 public_token。
CREATE OR REPLACE FUNCTION public.place_order(p_customer_name text, p_email text, p_phone text, p_address text, p_store_name text, p_store_number text, p_line_id text, p_remittance_last5 text, p_note text, p_items text, p_items_json jsonb, p_total_amount numeric, p_shipping_fee integer DEFAULT 0, p_coupon_code text DEFAULT NULL::text, p_subtotal numeric DEFAULT NULL::numeric, p_consumer_email text DEFAULT NULL::text, p_store_id bigint DEFAULT 1, p_payment_method text DEFAULT 'remittance'::text, p_shipping_subtype text DEFAULT NULL::text, p_cvs_store_id text DEFAULT NULL::text, p_cvs_store_name text DEFAULT NULL::text, p_cvs_address text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order_id bigint;
  v_store_order_no bigint;
  v_public_token uuid;
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
  v_payment_method text := COALESCE(NULLIF(p_payment_method, ''), 'remittance');
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
    payment_status, status,
    payment_method, shipping_subtype,
    cvs_store_id, cvs_store_name, cvs_address
  ) VALUES (
    p_store_id,
    v_consumer_id,
    p_customer_name, p_email, p_phone, p_address,
    p_store_name, p_store_number, p_line_id, p_remittance_last5,
    p_note, p_items, p_items_json, v_final_total, p_shipping_fee,
    v_coupon_id,
    v_discount,
    '未付', '待確認',
    v_payment_method, p_shipping_subtype,
    p_cvs_store_id, p_cvs_store_name, p_cvs_address
  )
  RETURNING id, store_order_no, public_token INTO v_order_id, v_store_order_no, v_public_token;

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
    'public_token', v_public_token,
    'discount_amount', v_discount,
    'final_total', v_final_total
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$


