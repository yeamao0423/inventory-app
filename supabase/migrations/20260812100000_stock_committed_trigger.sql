-- ══════════════════════════════════════════════════════════════
-- 庫存變動單一寫入點
--
-- 庫存 = 可賣量。「扣不扣」與「擋不擋」拆開：
--   現貨（storefront_products.skip_stock_check=false 且無 collection_end）
--     → 佔用增加時檢查，不足擋單，永不為負
--   預購／限時單／未上架 → 不檢查，照樣扣，可為負（負數 = 欠客人幾件）
--
-- 每張訂單用 stock_committed 記下自己佔走多少。任何訂單變更都重算差額並套用，
-- 因此是冪等的：重複執行差額為 0，不需要防重入旗標，也不需要狀態機。
--
-- 為什麼是 trigger 不是 RPC：消費者在會員中心取消訂單是
-- shop/src/app/account/page.jsx:83 的裸 update，沒有 RPC 可以掛。
-- 掛在表上，所有路徑（商城、後台、LINE、未來的 ECPay 回呼、直打 PostgREST）自動涵蓋。
-- ══════════════════════════════════════════════════════════════

ALTER TABLE public.consumer_orders
  ADD COLUMN IF NOT EXISTS stock_committed jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.consumer_orders.stock_committed
  IS '這張訂單目前從庫存佔走的量。鍵為 "productId:variantId"（無規格時 variantId 留空）。由 reconcile_order_stock() 維護，勿手動改。';

CREATE OR REPLACE FUNCTION public.reconcile_order_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_row       public.consumer_orders;
  v_target    jsonb := '{}'::jsonb;
  v_labels    jsonb := '{}'::jsonb;
  v_current   jsonb;
  v_item      jsonb;
  v_key       text;
  v_pid       bigint;
  v_vid       bigint;
  v_qty       integer;
  v_delta     integer;
  v_stock     integer;
  v_blocking  boolean;
  v_name      text;
  v_label     text;
BEGIN
  IF TG_OP = 'DELETE' THEN v_row := OLD; ELSE v_row := NEW; END IF;
  v_current := COALESCE(v_row.stock_committed, '{}'::jsonb);

  -- ── 1) 目標佔用量 ──────────────────────────
  -- 訂單被刪除、或狀態為已取消 → 目標一律 0
  IF TG_OP <> 'DELETE' AND COALESCE(NEW.status, '') <> '已取消' THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(NEW.items_json, '[]'::jsonb))
    LOOP
      CONTINUE WHEN COALESCE(v_item->>'status', 'active') = 'cancelled';
      CONTINUE WHEN COALESCE(v_item->>'id', '') !~ '^-?[0-9]+$';

      v_pid := (v_item->>'id')::bigint;
      v_vid := CASE WHEN COALESCE(v_item->>'variantId','') ~ '^-?[0-9]+$'
                    THEN (v_item->>'variantId')::bigint ELSE NULL END;
      v_qty := CASE WHEN COALESCE(v_item->>'qty','') ~ '^[0-9]+$'
                    THEN (v_item->>'qty')::integer ELSE 0 END;
      CONTINUE WHEN v_qty <= 0;

      v_key := v_pid::text || ':' || COALESCE(v_vid::text, '');
      v_target := jsonb_set(v_target, ARRAY[v_key],
        to_jsonb(COALESCE((v_target->>v_key)::integer, 0) + v_qty), true);

      -- 錯誤訊息要能講出是哪個規格，先把標籤留下來
      IF COALESCE(v_item->>'variantLabel','') <> '' THEN
        v_labels := jsonb_set(v_labels, ARRAY[v_key], to_jsonb(v_item->>'variantLabel'), true);
      END IF;
    END LOOP;
  END IF;

  -- ── 2) 套用差額 ────────────────────────────
  -- 依 key 字串排序處理，讓所有交易的鎖順序一致，避免死鎖
  FOR v_key IN
    SELECT k FROM (
      SELECT jsonb_object_keys(v_target)  AS k
      UNION
      SELECT jsonb_object_keys(v_current) AS k
    ) s ORDER BY k
  LOOP
    v_delta := COALESCE((v_target->>v_key)::integer, 0)
             - COALESCE((v_current->>v_key)::integer, 0);
    CONTINUE WHEN v_delta = 0;

    v_pid := split_part(v_key, ':', 1)::bigint;
    v_vid := NULLIF(split_part(v_key, ':', 2), '')::bigint;

    -- 只有「佔用增加」才檢查。差額為負是回補，永遠放行——
    -- 否則商品從預購改成現貨後，既有負庫存會讓客人再也取消不了單。
    IF v_delta > 0 THEN
      SELECT NOT (COALESCE(sp.skip_stock_check, false) OR sp.collection_end IS NOT NULL)
        INTO v_blocking
        FROM public.storefront_products sp
       WHERE sp.product_id = v_pid AND sp.store_id = v_row.store_id;

      -- 查無上架資料 → 這件商品不在商城賣（後台自建訂單常見），不套商城的擋單規則
      v_blocking := COALESCE(v_blocking, false);

      IF v_blocking THEN
        IF v_vid IS NOT NULL THEN
          SELECT stock INTO v_stock FROM public.product_variants WHERE id = v_vid FOR UPDATE;
          IF v_stock IS NULL THEN
            RAISE EXCEPTION '商品規格不存在 (variant_id: %)', v_vid;
          END IF;
        ELSE
          SELECT quantity INTO v_stock FROM public.products WHERE id = v_pid FOR UPDATE;
          IF v_stock IS NULL THEN
            RAISE EXCEPTION '商品不存在 (product_id: %)', v_pid;
          END IF;
        END IF;

        IF v_stock < v_delta THEN
          SELECT name INTO v_name FROM public.products WHERE id = v_pid;
          v_label := COALESCE(v_labels->>v_key, '');
          RAISE EXCEPTION '庫存不足：「%」%，剩餘 % 件',
            COALESCE(v_name, '商品'),
            CASE WHEN v_label <> '' THEN ' (' || v_label || ')' ELSE '' END,
            v_stock;
        END IF;
      END IF;
    END IF;

    -- DB 端加減，不是讀-改-寫
    IF v_vid IS NOT NULL THEN
      UPDATE public.product_variants SET stock = stock - v_delta WHERE id = v_vid;
    ELSE
      UPDATE public.products SET quantity = quantity - v_delta WHERE id = v_pid;
    END IF;
  END LOOP;

  -- ── 3) 寫回記帳 ────────────────────────────
  -- trigger 只監聽 items_json / status，所以這句不會遞迴觸發自己
  IF TG_OP <> 'DELETE' AND v_target IS DISTINCT FROM v_current THEN
    UPDATE public.consumer_orders SET stock_committed = v_target WHERE id = NEW.id;
  END IF;

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS reconcile_stock ON public.consumer_orders;
CREATE TRIGGER reconcile_stock
AFTER INSERT OR DELETE OR UPDATE OF items_json, status
ON public.consumer_orders
FOR EACH ROW EXECUTE FUNCTION public.reconcile_order_stock();


-- ══════════════════════════════════════════════════════════════
-- 以下三支既有 RPC 逐字重貼，只刪掉扣庫存那一段——庫存交給上面的 trigger。
-- 檢查段落全部保留：它們只檢查不扣，負責回商城那句友善的「庫存不足」訊息。
--
--   place_order        （來源 20250071_place_order_bundle_discount.sql）
--     刪 3) DEDUCT STOCK 整段迴圈，保留 1) STOCK CHECK
--   append_to_order    （來源 20250053_order_append_rpc.sql）
--     刪「── 扣庫存 ──」整段迴圈，保留「── 驗庫存 ──」
--   deduct_items_stock （來源 20250053_order_append_rpc.sql）
--     刪兩處 UPDATE，保留檢查。簽章不變，呼叫端此後只是在做一次前置檢查。
-- ══════════════════════════════════════════════════════════════

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
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true);

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;
