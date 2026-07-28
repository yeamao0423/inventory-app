-- ══════════════════════════════════════════════
-- 訂單加購（併單）— RPC
--
--   calc_append_deadline : 依 stores.settings 算出加購死線
--   place_order          : 下單時快照 append_deadline（其餘不變）
--   append_to_order      : 消費者自助加購到既有訂單
--   get_consumer_order   : 多回傳加購與付款狀態
--
-- stores.settings 新增三個 key：
--   append_mode  : 'off' | 'relative' | 'absolute'（未設定視為 off）
--   append_hours : relative 模式下，結單後可加購幾小時
--   append_until : absolute 模式下的截止時間（過期即等同不開放）
-- ══════════════════════════════════════════════

BEGIN;

-- ── 1. 加購死線計算 ──────────────────────────────────────

CREATE OR REPLACE FUNCTION public.calc_append_deadline(p_store_id bigint, p_items_json jsonb)
RETURNS timestamptz
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_settings jsonb;
  v_mode     text;
  v_hours    numeric;
  v_last_end timestamptz;
BEGIN
  SELECT settings INTO v_settings FROM public.stores WHERE id = p_store_id;
  v_mode := COALESCE(NULLIF(v_settings->>'append_mode', ''), 'off');

  -- 絕對模式：直接用老闆指定的時間。已過期的日期會讓 can_append 為 false，
  -- 效果就是「不開放加購」，不需要另外的失效處理。
  IF v_mode = 'absolute' THEN
    RETURN NULLIF(v_settings->>'append_until', '')::timestamptz;
  END IF;

  IF v_mode <> 'relative' THEN
    RETURN NULL;
  END IF;

  v_hours := COALESCE(NULLIF(v_settings->>'append_hours', '')::numeric, 0);

  -- 取訂單內「最晚」的收單截止：這張單要等最晚那團到齊才能一起出貨，
  -- 加購窗口自然跟著它，而不是被最早截止的那團提前鎖死。
  SELECT MAX(sp.collection_end) INTO v_last_end
    FROM jsonb_array_elements(p_items_json) AS it
    JOIN public.storefront_products sp
      ON sp.product_id = (it->>'id')::bigint
     AND sp.store_id   = p_store_id
   WHERE COALESCE((it->>'isCollection')::boolean, false) = false
     AND it->>'id' ~ '^[0-9]+$'
     AND sp.collection_end IS NOT NULL;

  -- 純現貨（品項都沒有收單截止）→ 改以下單時間起算
  RETURN COALESCE(v_last_end, now()) + (v_hours * interval '1 hour');
END;
$$;

-- ── 2. place_order：僅新增 append_deadline 快照 ──────────
-- 簽名與 remote 現行的 22 參數版一致，避免建立多載。

CREATE OR REPLACE FUNCTION public.place_order(
  p_customer_name text, p_email text, p_phone text, p_address text,
  p_store_name text, p_store_number text, p_line_id text, p_remittance_last5 text,
  p_note text, p_items text, p_items_json jsonb, p_total_amount numeric,
  p_shipping_fee integer DEFAULT 0, p_coupon_code text DEFAULT NULL::text,
  p_subtotal numeric DEFAULT NULL::numeric, p_consumer_email text DEFAULT NULL::text,
  p_store_id bigint DEFAULT 1, p_payment_method text DEFAULT 'remittance'::text,
  p_shipping_subtype text DEFAULT NULL::text, p_cvs_store_id text DEFAULT NULL::text,
  p_cvs_store_name text DEFAULT NULL::text, p_cvs_address text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
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
    cvs_store_id, cvs_store_name, cvs_address,
    append_deadline
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
    p_cvs_store_id, p_cvs_store_name, p_cvs_address,
    public.calc_append_deadline(p_store_id, p_items_json)
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
$$;

-- ── 3. 加購到既有訂單 ────────────────────────────────────
-- 憑不可猜的 public_token 認證，與 get_consumer_order 同一套安全模型。
-- 全程不查 payment_status：已付款的訂單一樣能加購，加購後由 trigger
-- 自動轉成「部分付款」，消費者補匯差額即可。

CREATE OR REPLACE FUNCTION public.append_to_order(p_token uuid, p_items_json jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_order      record;
  v_item       jsonb;
  v_stock      integer;
  v_product_name  text;
  v_variant_label text;
  v_settings   jsonb;
  v_merged     jsonb;
  v_subtotal   numeric := 0;
  v_threshold  numeric;
  v_fee        integer;
  v_shipping   integer;
  v_new_total  numeric;
  v_items_str  text;
BEGIN
  SELECT * INTO v_order FROM public.consumer_orders WHERE public_token = p_token FOR UPDATE;
  IF v_order IS NULL THEN
    RAISE EXCEPTION '訂單不存在';
  END IF;

  IF p_items_json IS NULL OR jsonb_array_length(p_items_json) = 0 THEN
    RAISE EXCEPTION '沒有要加購的商品';
  END IF;

  -- ── 加購窗口：時間閘門 + 狀態煞車 ──
  IF v_order.status NOT IN ('待確認', '處理中') THEN
    RAISE EXCEPTION '此訂單已進入採購或出貨流程，無法加購';
  END IF;
  IF v_order.append_deadline IS NULL OR now() >= v_order.append_deadline THEN
    RAISE EXCEPTION '加購時間已截止';
  END IF;

  -- ── 驗庫存（與 place_order 同規則）──
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
        SELECT p.name INTO v_product_name FROM public.products p WHERE p.id = (v_item->>'id')::bigint;
        RAISE EXCEPTION '庫存不足：「%」，剩餘 % 件',
          COALESCE(v_product_name, v_item->>'name'), v_stock;
      END IF;
    END IF;
  END LOOP;

  -- ── 扣庫存 ──
  -- 後台改單的加購原本只驗不扣，加購量一放大就會超賣；這裡一併補上。
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

  -- ── 併入 items_json ──
  -- 加購品項另起一列而非併入同名品項，出貨與採購時才看得出哪些是後來加的。
  SELECT COALESCE(v_order.items_json, '[]'::jsonb) || COALESCE(jsonb_agg(
           it || jsonb_build_object('status', 'active', 'addedAt', now())
         ), '[]'::jsonb)
    INTO v_merged
    FROM jsonb_array_elements(p_items_json) AS it;

  -- ── 重算金額（只計 active 品項）──
  SELECT COALESCE(SUM((it->>'price')::numeric * (it->>'qty')::integer), 0)
    INTO v_subtotal
    FROM jsonb_array_elements(v_merged) AS it
   WHERE COALESCE(it->>'status', 'active') <> 'cancelled';

  SELECT settings INTO v_settings FROM public.stores WHERE id = v_order.store_id;
  v_threshold := COALESCE(NULLIF(v_settings->>'free_shipping_threshold', '')::numeric, 3800);
  v_fee       := COALESCE(NULLIF(v_settings->>'shipping_fee', '')::integer, 60);
  v_shipping  := CASE WHEN v_subtotal >= v_threshold THEN 0 ELSE v_fee END;

  -- 優惠券折扣沿用原值不重算：重算會牽動 coupon_usage 與 per_consumer_limit 的
  -- 一致性，v1 選擇不動它。
  v_new_total := v_subtotal - COALESCE(v_order.discount_amount, 0) + v_shipping;

  SELECT string_agg(
           (it->>'name')
           || CASE WHEN COALESCE(it->>'variantLabel','') <> '' THEN ' ' || (it->>'variantLabel') ELSE '' END
           || ' × ' || (it->>'qty')
           || CASE WHEN COALESCE(it->>'customNote','')  <> '' THEN ' [' || (it->>'customNote') || ']' ELSE '' END,
           ', ')
    INTO v_items_str
    FROM jsonb_array_elements(v_merged) AS it
   WHERE COALESCE(it->>'status', 'active') <> 'cancelled';

  UPDATE public.consumer_orders
     SET items_json   = v_merged,
         items        = COALESCE(v_items_str, items),
         shipping_fee = v_shipping,
         total_amount = v_new_total,
         updated_at   = now()
   WHERE id = v_order.id;

  RETURN jsonb_build_object(
    'ok', true,
    'order_id',        v_order.id,
    'store_order_no',  v_order.store_order_no,
    'previous_total',  v_order.total_amount,
    'new_total',       v_new_total,
    'subtotal',        v_subtotal,
    'shipping_fee',    v_shipping,
    'previous_shipping_fee', v_order.shipping_fee,
    'discount_amount', COALESCE(v_order.discount_amount, 0),
    'paid_amount',     v_order.paid_amount,
    'balance_due',     v_new_total - v_order.paid_amount
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

-- ── 4. 訂單查詢多回傳加購與付款狀態 ─────────────────────

CREATE OR REPLACE FUNCTION public.get_consumer_order(p_token uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT jsonb_build_object(
    'id', co.id,
    'store_order_no', co.store_order_no,
    'email', co.email,
    'remittance_last5', co.remittance_last5,
    'items', co.items,
    'items_json', co.items_json,
    'total_amount', co.total_amount,
    'discount_amount', co.discount_amount,
    'shipping_fee', co.shipping_fee,
    'status', co.status,
    'payment_status', co.payment_status,
    'paid_amount', co.paid_amount,
    'balance_due', COALESCE(co.total_amount, 0) - COALESCE(co.paid_amount, 0),
    'append_deadline', co.append_deadline,
    'can_append', (
      co.status IN ('待確認', '處理中')
      AND co.append_deadline IS NOT NULL
      AND now() < co.append_deadline
    )
  )
  FROM consumer_orders co WHERE co.public_token = p_token
$$;

-- ── 5. 後台改單加購的扣庫存 ─────────────────────────────
-- 後台 ConsumerOrderDetailSheet 原本只驗庫存、沒有真的扣，
-- 加購量一放大就會超賣。抽成 RPC 讓「驗 + 扣」在同一個交易完成。

CREATE OR REPLACE FUNCTION public.deduct_items_stock(p_store_id bigint, p_items_json jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_item          jsonb;
  v_stock         integer;
  v_product_name  text;
  v_variant_label text;
BEGIN
  IF NOT public.has_store_role(p_store_id, ARRAY['super_admin','admin','editor']) THEN
    RAISE EXCEPTION '權限不足';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items_json)
  LOOP
    IF (v_item->>'isCollection')::boolean IS TRUE THEN
      CONTINUE;
    END IF;

    IF v_item->>'variantId' IS NOT NULL AND v_item->>'variantId' != '' THEN
      SELECT pv.stock INTO v_stock
        FROM public.product_variants pv
       WHERE pv.id = (v_item->>'variantId')::bigint AND pv.store_id = p_store_id
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

      UPDATE public.product_variants
         SET stock = stock - (v_item->>'qty')::integer
       WHERE id = (v_item->>'variantId')::bigint;
    ELSE
      SELECT p.quantity INTO v_stock
        FROM public.products p
       WHERE p.id = (v_item->>'id')::bigint AND p.store_id = p_store_id
         FOR UPDATE;

      IF v_stock IS NULL THEN
        RAISE EXCEPTION '商品不存在 (product_id: %)', v_item->>'id';
      END IF;
      IF v_stock < (v_item->>'qty')::integer THEN
        SELECT p.name INTO v_product_name FROM public.products p WHERE p.id = (v_item->>'id')::bigint;
        RAISE EXCEPTION '庫存不足：「%」，剩餘 % 件',
          COALESCE(v_product_name, v_item->>'name'), v_stock;
      END IF;

      UPDATE public.products
         SET quantity = quantity - (v_item->>'qty')::integer
       WHERE id = (v_item->>'id')::bigint;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true);

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.append_to_order(uuid, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.calc_append_deadline(bigint, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.deduct_items_stock(bigint, jsonb) TO authenticated;

COMMIT;
