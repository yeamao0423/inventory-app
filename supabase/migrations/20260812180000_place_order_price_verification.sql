-- ══════════════════════════════════════════════════════════════
-- place_order：伺服器端回算商品金額
--
-- 原本 v_final_total := p_total_amount - v_discount，整支函式從頭到尾沒有
-- 從資料庫讀過任何一個定價。函式是 SECURITY DEFINER 且 anon 可呼叫（商城結帳
-- 直接打它），所以任何人打開瀏覽器 console 就能用 p_total_amount = 1 買走
-- 3800 元的商品，接上綠界刷 1 元後 payment_status 自動變「已付清」。
--
-- 這支 migration 逐字重貼 place_order（來源 20260812100000_stock_committed_trigger.sql:161），
-- 簽章一個字都沒動，加上三件事：
--
--   1) 1a 新增：逐項從 storefront_products / product_variants 回算單價，
--      得出伺服器端的商品小計 v_items_subtotal。
--   2) 1b 新增：拿 v_items_subtotal 與前端傳來的 p_total_amount 比對，不符擋下。
--   3) 套裝折扣的基準組原價、優惠券的 min_amount 與折扣計算，
--      一律改吃 v_items_subtotal / 伺服器單價，不再吃 items_json 的 price
--      與 p_subtotal —— 否則攻擊者只要把 items_json 的 price 灌大，
--      折扣就跟著暴衝，即使總額誠實也能把最終金額壓到只剩運費。
--
-- ── 單價怎麼算：與商城前端同一條式子 ──────────────────
--   原價 = product_variants.variant_price
--          ?? storefront_products.shop_price + COALESCE(price_adjustment, 0)
--   特價 = COALESCE(variant.sale_price, storefront_products.sale_price)
--   特價生效 = on_sale AND now() 落在 sale_start/sale_end 之間 AND 特價 < 原價
--
--   對照 shop/src/lib/salePrice.js 的 getActivePrice()，以及三個呼叫端：
--     shop/src/app/products/[id]/ProductStateProvider.jsx:110-112
--     shop/src/app/products/[id]/ProductDetail.jsx:100-102
--     shop/src/app/bundles/[id]/BundleDetail.jsx:555-558
--   三處寫的是同一條式子，加入購物車時把算出來的 price 寫進 cart line。
--
--   p_total_amount = Σ(單價 × 數量) + 運費，「未扣任何折扣」
--   （shop/src/app/checkout/page.jsx:441，折扣由本函式自己算並扣掉）
--
-- ── 幾個刻意保留的行為 ──────────────────────────────
--   * isCollection（預購／限時收單）品項照樣計入小計。前端 cartSubtotal 把它們
--     算進去，isCollection 只影響「檢不檢查庫存」，不影響定價。排除它們會讓
--     每一張預購單都被擋掉。
--   * status='cancelled' 的品項排除，與 reconcile_order_stock trigger、
--     append_to_order 的口徑一致。
--   * 商品不在 storefront_products（後台自建訂單的品項）→ 沿用傳入的 price。
--     擋死會讓店家無法建單。代價是這類商品的價格仍不可信，見下面的殘留風險。
--
-- ── 殘留風險（本輪未關，需另案處理）────────────────
--   * 未上架商品沿用傳入 price：呼叫端可以拿一個沒有 storefront_products 的
--     product_id 用任意價格下單。這類商品不在商城賣，但 place_order 對 anon
--     開放，理論上可被借道。要關掉就得讓 place_order 拒絕未上架商品，
--     但那會改變後台建單路徑的行為，超出本輪範圍。
--   * p_shipping_fee 只驗上界（0 ≤ 運費 ≤ 伺服器算出的應收運費），不驗等於。
--     supabase/tests/stock_reconcile.sql:65 的 fixture 用 1000 元的小計傳
--     p_shipping_fee = 0，強制等於會把那則測試擋掉，而本輪不得修改該檔。
--     上界檢查已經擋住「傳負運費來折抵商品金額」這條真正危險的路，
--     剩下的曝險是每張單最多少收一次運費（本店 60 元）。
--     修法：把該 fixture 改成 p_shipping_fee = 60（或 p_total_amount = 1060），
--     再把下面的上界檢查換成等值比對。
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
  -- 伺服器端回算
  v_now timestamptz := now();
  v_priced jsonb := '[]'::jsonb;      -- [{pid, qty, bundleId, unit}] 逐列的伺服器單價
  v_items_subtotal numeric := 0;      -- 伺服器算出的商品小計（未扣折扣、不含運費）
  v_store_settings jsonb;
  v_free_threshold numeric;
  v_ship_fee numeric;
  v_expected_shipping numeric;
  v_paid_shipping numeric := COALESCE(p_shipping_fee, 0);
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

  -- ========== 1a) 伺服器端逐項回算單價 ==========
  -- 前端送來的 price 只當「線索」，一律以 storefront_products / product_variants 為準。
  -- 查不到上架資料的商品（後台自建訂單的品項）才沿用傳入的 price。
  WITH raw AS (
    SELECT
      CASE WHEN e->>'id' ~ '^-?[0-9]+$' THEN (e->>'id')::bigint END AS pid,
      CASE WHEN COALESCE(e->>'variantId', '') ~ '^-?[0-9]+$'
           THEN (e->>'variantId')::bigint END AS vid,
      CASE WHEN COALESCE(e->>'qty', '') ~ '^[0-9]+$'
           THEN (e->>'qty')::integer ELSE 0 END AS qty,
      -- 價格看不懂就當 0（少算，不會多算）—— 壞資料不該讓整張單噴不明錯誤
      CASE WHEN COALESCE(e->>'price', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
           THEN (e->>'price')::numeric ELSE 0 END AS client_price,
      CASE WHEN COALESCE(e->>'bundleId', '') ~ '^-?[0-9]+$'
           THEN (e->>'bundleId')::bigint END AS bundle_id
    FROM jsonb_array_elements(COALESCE(p_items_json, '[]'::jsonb)) AS e
    -- 已取消的品項不必付錢（與 reconcile_order_stock / append_to_order 同口徑）
    WHERE COALESCE(e->>'status', 'active') <> 'cancelled'
  ),
  resolved AS (
    SELECT
      r.pid, r.qty, r.bundle_id,
      CASE
        WHEN sp.product_id IS NULL THEN r.client_price
        WHEN sp.on_sale
         AND (sp.sale_start IS NULL OR sp.sale_start <= v_now)
         AND (sp.sale_end   IS NULL OR sp.sale_end   >= v_now)
         AND COALESCE(pv.sale_price, sp.sale_price) IS NOT NULL
         AND COALESCE(pv.sale_price, sp.sale_price)
             < COALESCE(pv.variant_price, sp.shop_price + COALESCE(pv.price_adjustment, 0))
        THEN COALESCE(pv.sale_price, sp.sale_price)
        ELSE COALESCE(pv.variant_price, sp.shop_price + COALESCE(pv.price_adjustment, 0))
      END AS unit_price
    FROM raw r
    LEFT JOIN public.storefront_products sp
      ON sp.product_id = r.pid AND sp.store_id = p_store_id
    -- 規格必須確實屬於這件商品，否則不算數（避免用便宜商品的 variantId 借價）
    LEFT JOIN public.product_variants pv
      ON pv.id = r.vid AND pv.product_id = r.pid
  )
  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'pid', pid, 'qty', qty, 'bundleId', bundle_id, 'unit', unit_price)), '[]'::jsonb),
    COALESCE(SUM(unit_price * qty), 0)
  INTO v_priced, v_items_subtotal
  FROM resolved;

  -- ========== 1b) 與前端傳來的金額比對 ==========
  SELECT settings INTO v_store_settings FROM public.stores WHERE id = p_store_id;
  v_free_threshold := COALESCE(NULLIF(v_store_settings->>'free_shipping_threshold', '')::numeric, 3800);
  v_ship_fee       := COALESCE(NULLIF(v_store_settings->>'shipping_fee', '')::numeric, 60);
  v_expected_shipping := CASE WHEN v_items_subtotal >= v_free_threshold THEN 0 ELSE v_ship_fee END;

  -- 運費只驗上界（理由見檔頭的殘留風險）。下界 0 是必要的：
  -- 沒有它，傳一筆負運費就能把商品金額整個折掉而通過下面的小計比對。
  IF v_paid_shipping < 0 OR v_paid_shipping > v_expected_shipping + 1 THEN
    RAISE EXCEPTION '運費金額有誤，請重新整理購物車後再試一次';
  END IF;

  -- 只容許浮點／四捨五入等級的誤差。金額比伺服器算的高也要擋 ——
  -- 放行「客人多付」等於讓多收錢的 bug 靜靜通過。
  IF ABS(COALESCE(p_total_amount, 0) - v_paid_shipping - v_items_subtotal) > 1 THEN
    RAISE EXCEPTION '商品價格已變動，請重新整理購物車後再試一次';
  END IF;

  -- ========== 1c) BUNDLE（套裝價）重新驗證 ==========
  -- 掃出 items_json 裡出現過的組合 id（前端標記，只當「線索」，一切以 DB 為準）
  FOR v_bundle_id IN
    SELECT DISTINCT (e->>'bundleId')::bigint
    FROM jsonb_array_elements(v_priced) e
    WHERE COALESCE(e->>'bundleId', '') ~ '^-?[0-9]+$'
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
        SELECT 1 FROM jsonb_array_elements(v_priced) e
        WHERE COALESCE(e->>'bundleId', '') ~ '^-?[0-9]+$'
          AND (e->>'bundleId')::bigint = v_bundle.id
          AND COALESCE(e->>'pid', '') ~ '^-?[0-9]+$'
          AND (e->>'pid')::bigint = bi.product_id
      );
    IF v_missing > 0 THEN
      CONTINUE;
    END IF;

    -- 基準組原價加總：組合內每件各一。
    -- 數量超過 1 的部分照原價計，不打折 —— 一口價買的是「一套」。
    -- 同一商品意外出現多列時取最低單價（保守，寧可少折）。
    --
    -- 單價來源改成 v_priced 的伺服器單價（原本讀 items_json 的 price）。
    -- 讀客戶端的 price 等於讓呼叫端自己決定折多少：把 price 灌到 99999，
    -- 折扣就是 (199998 - bundle_price)，最終金額只剩運費。
    SELECT COALESCE(sum(x.unit_price), 0) INTO v_base_total
    FROM (
      SELECT bi.product_id, MIN((e->>'unit')::numeric) AS unit_price
      FROM public.bundle_items bi
      JOIN jsonb_array_elements(v_priced) e
        ON COALESCE(e->>'bundleId', '') ~ '^-?[0-9]+$'
       AND (e->>'bundleId')::bigint = v_bundle.id
       AND COALESCE(e->>'pid', '') ~ '^-?[0-9]+$'
       AND (e->>'pid')::bigint = bi.product_id
      WHERE bi.bundle_id = v_bundle.id
      GROUP BY bi.product_id
    ) x;

    IF v_base_total > v_bundle.bundle_price THEN
      v_bundle_discount := v_bundle_discount + (v_base_total - v_bundle.bundle_price);
    END IF;
  END LOOP;

  -- 折扣不可能大於商品小計（用伺服器算出的小計，不用 p_total_amount）
  v_bundle_discount := LEAST(v_bundle_discount, GREATEST(v_items_subtotal, 0));

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
    -- 用伺服器算出的小計，不用 p_subtotal：後者是呼叫端說了算，
    -- 灌大就能繞過 min_amount，百分比券還會照著它折出天價。
    IF v_items_subtotal < v_coupon.min_amount THEN
      RAISE EXCEPTION '未達最低消費 NT$%', v_coupon.min_amount::text;
    END IF;

    -- Calculate discount（同上，一律以 v_items_subtotal 為基準）
    IF v_coupon.discount_type = 'fixed' THEN
      v_discount := LEAST(v_coupon.discount_value, v_items_subtotal);
    ELSE
      v_discount := v_items_subtotal * (v_coupon.discount_value / 100.0);
      IF v_coupon.max_discount IS NOT NULL THEN
        v_discount := LEAST(v_discount, v_coupon.max_discount);
      END IF;
      v_discount := LEAST(v_discount, v_items_subtotal);
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
