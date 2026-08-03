-- ============================================================
-- place_order：套裝價重新驗證，差額寫進 discount_amount
--
-- 支點（ADR-0004）：組合不成為訂單品項。訂單品項仍是各件商品，
-- 只是每個品項在 items_json 帶 bundleId 標記所屬組合（items_json 消費者讀得到，
-- 但 bundleId 不是成本資訊，可以放）。套裝一口價與各件原價加總的差額累加進 discount_amount，
-- orderFinance.js 既有的分攤機制會讓單品毛利自動正確 —— 出貨/庫存/成本快照/拆賬一行都不用改。
--
-- 為什麼要在 DB 再驗一次：前端 localStorage 不可信。
--   * 套裝價一律取 DB 的 bundles.bundle_price（不看前端傳什麼）
--   * 完整性一律比對 DB 的 bundle_items（缺一件就不成立，各件以原價購買）
--   * 組合下架、不屬本店 → 直接視為沒有套裝價
-- 因此不論前端怎麼改，消費者為一整套付的錢就是 DB 上的 bundle_price。
--
-- 套裝價不與優惠券併用（ADR-0004）：兩者同時出現時直接擋下並說明原因。
--
-- 這份檔案是「以線上實際版本為基底 + 新增 1b 段落」，其餘邏輯逐字保留未動。
-- （repo migration 與實際 DB 有落差，此版對應 22 參數版的 place_order。）
-- ============================================================

CREATE OR REPLACE FUNCTION public.place_order(
  p_customer_name text, p_email text, p_phone text, p_address text,
  p_store_name text, p_store_number text, p_line_id text, p_remittance_last5 text,
  p_note text, p_items text, p_items_json jsonb, p_total_amount numeric,
  p_shipping_fee integer DEFAULT 0,
  p_coupon_code text DEFAULT NULL::text,
  p_subtotal numeric DEFAULT NULL::numeric,
  p_consumer_email text DEFAULT NULL::text,
  p_store_id bigint DEFAULT 1,
  p_payment_method text DEFAULT 'remittance'::text,
  p_shipping_subtype text DEFAULT NULL::text,
  p_cvs_store_id text DEFAULT NULL::text,
  p_cvs_store_name text DEFAULT NULL::text,
  p_cvs_address text DEFAULT NULL::text)
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
  -- 套裝價
  v_bundle_id bigint;
  v_bundle record;
  v_missing integer;
  v_base_total numeric;
  v_bundle_discount numeric := 0;
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

  -- ========== 1b) BUNDLE（套裝價）重新驗證 ==========
  -- 掃出 items_json 裡出現過的組合 id（前端標記，只當「線索」，一切以 DB 為準）
  FOR v_bundle_id IN
    SELECT DISTINCT (e->>'bundleId')::bigint
    FROM jsonb_array_elements(p_items_json) e
    WHERE e->>'bundleId' ~ '^[0-9]+$'
  LOOP
    -- 組合必須存在、屬於本店、且仍在架上，否則各件一律以原價購買
    SELECT * INTO v_bundle
    FROM public.bundles
    WHERE id = v_bundle_id AND store_id = p_store_id AND is_published;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    -- 完整性：組合裡的每一件商品，購物車都要有一列掛在這個組合下。缺一件就不成立。
    SELECT count(*) INTO v_missing
    FROM public.bundle_items bi
    WHERE bi.bundle_id = v_bundle.id
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_items_json) e
        WHERE e->>'bundleId' ~ '^[0-9]+$'
          AND (e->>'bundleId')::bigint = v_bundle.id
          AND e->>'id' ~ '^[0-9]+$'
          AND (e->>'id')::bigint = bi.product_id
      );
    IF v_missing > 0 THEN
      CONTINUE;
    END IF;

    -- 基準組原價加總：組合內每件各一。
    -- 數量超過 1 的部分照原價計，不打折 —— 一口價買的是「一套」。
    -- 同一商品意外出現多列時取最低單價（保守，寧可少折）。
    SELECT COALESCE(sum(x.unit_price), 0) INTO v_base_total
    FROM (
      -- 價格看不懂就當 0（少折，不會多折）—— 壞資料不該讓整張單噴錯
      SELECT bi.product_id,
             MIN(CASE WHEN e->>'price' ~ '^[0-9]+(\.[0-9]+)?$'
                      THEN (e->>'price')::numeric ELSE 0 END) AS unit_price
      FROM public.bundle_items bi
      JOIN jsonb_array_elements(p_items_json) e
        ON e->>'bundleId' ~ '^[0-9]+$'
       AND (e->>'bundleId')::bigint = v_bundle.id
       AND e->>'id' ~ '^[0-9]+$'
       AND (e->>'id')::bigint = bi.product_id
      WHERE bi.bundle_id = v_bundle.id
      GROUP BY bi.product_id
    ) x;

    IF v_base_total > v_bundle.bundle_price THEN
      v_bundle_discount := v_bundle_discount + (v_base_total - v_bundle.bundle_price);
    END IF;
  END LOOP;

  -- 折扣不可能大於商品總額（p_total_amount 含運費，先扣掉）
  v_bundle_discount := LEAST(v_bundle_discount, GREATEST(p_total_amount - COALESCE(p_shipping_fee, 0), 0));

  -- ========== 2) COUPON VALIDATION ==========
  IF p_coupon_code IS NOT NULL AND p_coupon_code != '' THEN
    -- 套裝價視為最終價，不與優惠券／等級折扣疊加（ADR-0004）
    IF v_bundle_discount > 0 THEN
      RAISE EXCEPTION '套裝價不能與優惠券併用，請先移除優惠碼，或把套裝中的商品拆開單買';
    END IF;

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

  -- 套裝價與優惠券互斥（上面已擋），這裡只會有一邊是非零值
  v_discount := ROUND(v_discount + v_bundle_discount);

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
    'bundle_discount', ROUND(v_bundle_discount),
    'final_total', v_final_total
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$;
