-- ============================================
-- Migration: 多租戶 Phase A-1 — 平台身分與註冊流程基礎
-- 依據 STORE_ONBOARDING_PLAN.md：
--   1. platform_admins：平台方身分（G1），與店內角色脫鉤
--   2. invitations.role 擴充 super_admin（店主邀請）與 viewer（G6）
--   3. handle_new_user() 只建 profiles，不再自動塞 user_store_roles（G7 起點）
--      後台帳號一律由邀請流程產生；消費者關係由 store_consumers 承載
--   4. place_order 加 p_store_id：訂單歸店、優惠券限同店、檢查店家有效
-- 僅先套用於 local，待測試通過後才可上 remote
-- ============================================

-- ========== 1) platform_admins ==========
CREATE TABLE IF NOT EXISTS platform_admins (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;

-- 只能查到自己是不是平台管理員（前端 isPlatformAdmin 判斷用）；
-- 新增/移除平台管理員一律 DB 手動操作，不開放 client 寫入
DROP POLICY IF EXISTS "read own platform admin" ON platform_admins;
CREATE POLICY "read own platform admin" ON platform_admins
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

GRANT SELECT ON platform_admins TO authenticated;

-- Seed：現有兩位 super_admin = 平台方
INSERT INTO platform_admins (user_id)
SELECT id FROM auth.users
WHERE email IN ('henry3556108@gapp.nthu.edu.tw', 'yeamao0423@gmail.com')
ON CONFLICT DO NOTHING;

-- ========== 2) invitations.role 擴充 ==========
ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_role_check;
ALTER TABLE invitations ADD CONSTRAINT invitations_role_check
  CHECK (role IN ('super_admin', 'admin', 'editor', 'viewer'));

-- ========== 3) handle_new_user() 簡化 ==========
-- 新帳號只建 profiles；不再寫 user_store_roles（舊行為：一律塞 store 1 consumer）。
-- 後台角色：邀請接受時 upsert；消費者：商城首次登入/下單時寫 store_consumers。
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.profiles (id, name, email)
  VALUES (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', new.email),
    new.email
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN new;
END;
$$;

-- ========== 4) place_order 加 p_store_id ==========
-- 參數列變動必須 DROP 舊版（避免 named-call ambiguous）
DROP FUNCTION IF EXISTS public.place_order(
  text, text, text, text, text, text, text, text, text, text,
  jsonb, numeric, integer, text, numeric, text
);

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
  -- coupon params (all nullable)
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
  -- coupon vars
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
    -- Look up shared coupon（限本店）
    SELECT * INTO v_coupon
      FROM public.coupons
      WHERE code = p_coupon_code AND type = 'shared' AND store_id = p_store_id
      FOR UPDATE;

    -- If not found, look up unique coupon code
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

      -- 一次性碼本身全域唯一，但活動必須屬於本店
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
