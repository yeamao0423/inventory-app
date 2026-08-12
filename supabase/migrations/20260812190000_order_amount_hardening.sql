-- ══════════════════════════════════════════════════════════════
-- 訂單金額驗證：收掉 20260812180000 留下的三個缺口
--
-- 前一支（20260812180000_place_order_price_verification.sql）讓 place_order
-- 從資料庫回算商品小計並與 p_total_amount 比對，但自己列了三個沒關的洞。
-- 這支把它們關掉，place_order 整支重貼（簽章一個字沒動），
-- append_to_order 也整支重貼（來源 20260812100000_stock_committed_trigger.sql:490）。
--
--   缺口 1｜運費只驗上下界 → 改成等值比對。
--     原本是 0 ≤ 傳入運費 ≤ 應收運費 + 1，曝險是每張單可以少收一次運費。
--     之所以沒驗等值，是因為 supabase/tests/stock_reconcile.sql 的 T3 fixture
--     用 1000 元小計傳 p_shipping_fee = 0。那則 fixture 已改成 1060/60。
--
--   缺口 2｜未上架商品沿用前端傳來的 price → 改成拒絕下單。
--     原本的理由是「後台自建訂單的商品不在 storefront_products」，但 place_order
--     全 repo 只有一個呼叫端（shop/src/app/checkout/page.jsx:452，商城結帳）；
--     後台建單走的是 consumer_orders 直接 insert + reconcile_stock trigger，
--     根本不經過這支 RPC。所以那個放行只是留給 anon 的旁門：
--     拿一個沒上架過的 product_id，整套價格驗證就被繞開。
--
--   缺口 3｜append_to_order 有同一個洞而且更寬 → 一併關掉。詳見下半段。
--
-- 這支 migration 加在 place_order 上的東西（承接前一支）：
--
--   1) 1a：逐項從 storefront_products / product_variants 回算單價，
--      得出伺服器端的商品小計 v_items_subtotal。查不到上架資料的品項一律擋下。
--   2) 1b：拿 v_items_subtotal 與前端傳來的 p_total_amount 比對，不符擋下；
--      運費與伺服器算出的應收運費等值比對。
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
-- ── 「上架」的判準：storefront_products 有沒有那一列 ──────
--   storefront_products 有 published 欄位，但**不拿它當判準**。理由：
--   有列就代表價格是店家在後台設定的（shop_price / sale_price / 規格價），
--   伺服器回算得出來，價格就可信 —— 這才是這道檢查要守的東西。
--   published = false 只是「暫時從商城前台隱藏」，那一列的價格照樣是店家設的；
--   拿它擋單只會誤傷「加入購物車後店家臨時隱藏」的正常客人，
--   卻一分錢的曝險都沒減少。真正危險的是**沒有那一列**：
--   沒有列就沒有店家設定的價格可回算，只能沿用前端傳來的數字。
--
-- ── UX 邊界（可接受，但要知道）──────────────────────
--   商品在加入購物車之後、結帳之前被店家從 storefront_products 刪掉（真正下架），
--   正常客人也會撞到「部分商品已下架，請重新整理購物車後再試一次」。
--   訊息已經講清楚該做什麼，而且這種情況本來就該重新結帳。
--
-- ── 幾個刻意保留的行為 ──────────────────────────────
--   * isCollection（預購／限時收單）品項照樣計入小計。前端 cartSubtotal 把它們
--     算進去，isCollection 只影響「檢不檢查庫存」，不影響定價。排除它們會讓
--     每一張預購單都被擋掉。
--   * status='cancelled' 的品項排除，與 reconcile_order_stock trigger、
--     append_to_order 的口徑一致。這類品項不用付錢，也就不受上架檢查約束。
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
  v_offshelf integer := 0;            -- 找不到上架資料的品項數
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
  -- 前端送來的 price 一概不採用，一律以 storefront_products / product_variants 為準。
  -- 查不到上架資料的品項標記成 offshelf，下一段直接擋下整張單。
  WITH raw AS (
    SELECT
      CASE WHEN e->>'id' ~ '^-?[0-9]+$' THEN (e->>'id')::bigint END AS pid,
      CASE WHEN COALESCE(e->>'variantId', '') ~ '^-?[0-9]+$'
           THEN (e->>'variantId')::bigint END AS vid,
      CASE WHEN COALESCE(e->>'qty', '') ~ '^[0-9]+$'
           THEN (e->>'qty')::integer ELSE 0 END AS qty,
      CASE WHEN COALESCE(e->>'bundleId', '') ~ '^-?[0-9]+$'
           THEN (e->>'bundleId')::bigint END AS bundle_id
    FROM jsonb_array_elements(COALESCE(p_items_json, '[]'::jsonb)) AS e
    -- 已取消的品項不必付錢（與 reconcile_order_stock / append_to_order 同口徑）
    WHERE COALESCE(e->>'status', 'active') <> 'cancelled'
  ),
  resolved AS (
    SELECT
      r.pid, r.qty, r.bundle_id,
      (sp.product_id IS NULL) AS offshelf,
      CASE
        -- 沒有上架資料就沒有伺服器價可算。這裡先給 0 讓查詢跑完，
        -- 真正的處理是下一段用 v_offshelf 把整張單擋掉。
        WHEN sp.product_id IS NULL THEN 0
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
    COALESCE(SUM(unit_price * qty), 0),
    COUNT(*) FILTER (WHERE offshelf)
  INTO v_priced, v_items_subtotal, v_offshelf
  FROM resolved;

  -- 沒有 storefront_products 那一列 → 沒有店家設定的價格可回算，
  -- 沿用前端傳來的 price 等於把整套價格驗證讓給呼叫端。擋下。
  IF v_offshelf > 0 THEN
    RAISE EXCEPTION '部分商品已下架，請重新整理購物車後再試一次';
  END IF;

  -- ========== 1b) 與前端傳來的金額比對 ==========
  SELECT settings INTO v_store_settings FROM public.stores WHERE id = p_store_id;
  v_free_threshold := COALESCE(NULLIF(v_store_settings->>'free_shipping_threshold', '')::numeric, 3800);
  v_ship_fee       := COALESCE(NULLIF(v_store_settings->>'shipping_fee', '')::numeric, 60);
  v_expected_shipping := CASE WHEN v_items_subtotal >= v_free_threshold THEN 0 ELSE v_ship_fee END;

  -- 運費等值比對（同樣只容許 1 元內的零頭）。等值而非上下界，因為：
  --   * 低於應收 → 少收運費（原本的殘留缺口，每張單一次）
  --   * 高於應收 → 多收運費，一樣是 bug
  --   * 負運費   → 拿運費當折扣把商品金額折掉，同時通過下面的小計比對
  IF ABS(v_paid_shipping - v_expected_shipping) > 1 THEN
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


-- ══════════════════════════════════════════════════════════════
-- append_to_order：伺服器端回算加購金額
--
-- 來源 20260812100000_stock_committed_trigger.sql:490，整支重貼，簽章沒動。
--
-- ── 原本的洞 ──────────────────────────────────────────
--   v_subtotal 從 v_merged（既有 items_json ＋ 新加購品項）用呼叫端傳來的
--   price 重算，再寫回 total_amount。也就是說呼叫端不只能決定加購品的價格，
--   還能連整張單原有的金額一起改寫成任意值。函式是 SECURITY DEFINER、
--   GRANT 給 anon。目前被 append_mode 預設 'off' 擋著（calc_append_deadline
--   回 NULL → 「加購時間已截止」），但那是設定開關，不是程式碼防線：
--   店家在後台把加購打開的那一刻這個洞就活了。
--
-- ── 修法：小計拆成兩段，兩段都不看呼叫端傳的 price ──
--
--   A) 新加購品項 → 從 storefront_products / product_variants 回算單價，
--      用的是與 place_order 逐字相同的那條式子。查不到上架資料就擋下整次加購
--      （錯誤訊息與 place_order 同一句）。算出來的單價會**釘進**寫入 items_json
--      的那一列，之後後台編輯訂單看到的就是真實價格。
--
--   B) 既有品項 → 從訂單自己的欄位回推，而不是把 items_json 的 price 加總：
--
--        既有小計 = total_amount + discount_amount - shipping_fee
--
--      為什麼不直接讀 items_json 的 price（那是任務原本的建議）：
--      **place_order 並沒有逐列驗證 items_json 的 price**，它驗的是
--      「伺服器算出的小計」對「p_total_amount」的總額等式。所以下單時把某一列的
--      price 灌成 1、同時誠實地傳 p_total_amount，整張單會通過驗證，
--      而 items_json 裡留下的是那個假價格。之後只要加購一次，
--      整張單的金額就會依那個假價格塌下來。讀 items_json 等於把洞換個位置。
--
--      回推用的三個欄位全是伺服器寫進去的：
--        * place_order：total = 伺服器小計 + 運費 - 折扣，三欄同時寫入，等式成立。
--        * 後台編輯訂單（src/components/ConsumerOrderDetailSheet.jsx:509-517）：
--          total_amount / shipping_fee / discount_amount 在同一個 UPDATE 裡一起寫，
--          等式一樣成立 —— 品項取消、數量調降、手動加品項都走這條路。
--        * 棄單還原優惠券（20260812170100:105）：total -= discount、discount = discount，
--          等式仍成立。
--      全 repo 沒有第四個會單獨動這三欄的地方（grep 過 src / shop/src / supabase）。
--
--      副作用（可接受）：品項取消如果沒有同步更新 total_amount，加購時仍會把那筆
--      金額算進去。但唯一會把品項標成 cancelled 的地方就是上面那個後台編輯畫面，
--      它必定同時更新 total_amount，所以實務上不會發生。
--
-- ── 沒有一起改的東西 ──────────────────────────────────
--   * 優惠券折扣沿用原值不重算（v1 的決定，重算會牽動 coupon_usage
--     與 per_consumer_limit 的一致性）。
--   * 加購品項不吃套裝折扣 —— 原本就沒有這個邏輯。
-- ══════════════════════════════════════════════════════════════

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
  -- 伺服器端回算
  v_now             timestamptz := now();
  v_new_items       jsonb := '[]'::jsonb;   -- 加購品項（price 已換成伺服器價）
  v_added_subtotal  numeric := 0;           -- 加購品項的小計
  v_prev_subtotal   numeric := 0;           -- 既有品項的小計（由訂單欄位回推）
  v_offshelf        integer := 0;
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

  -- ── A) 加購品項：伺服器端回算單價，順便把價格釘進要寫入的那一列 ──
  -- 單價式子與 place_order 1a 逐字相同（對照 shop/src/lib/salePrice.js getActivePrice）。
  WITH raw AS (
    SELECT
      e.ordinality AS ord,
      e.value      AS line,
      CASE WHEN e.value->>'id' ~ '^-?[0-9]+$' THEN (e.value->>'id')::bigint END AS pid,
      CASE WHEN COALESCE(e.value->>'variantId', '') ~ '^-?[0-9]+$'
           THEN (e.value->>'variantId')::bigint END AS vid,
      CASE WHEN COALESCE(e.value->>'qty', '') ~ '^[0-9]+$'
           THEN (e.value->>'qty')::integer ELSE 0 END AS qty
    FROM jsonb_array_elements(p_items_json) WITH ORDINALITY AS e(value, ordinality)
  ),
  resolved AS (
    SELECT
      r.ord, r.line, r.qty,
      (sp.product_id IS NULL) AS offshelf,
      CASE
        WHEN sp.product_id IS NULL THEN 0
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
      ON sp.product_id = r.pid AND sp.store_id = v_order.store_id
    -- 規格必須確實屬於這件商品，否則不算數（避免用便宜商品的 variantId 借價）
    LEFT JOIN public.product_variants pv
      ON pv.id = r.vid AND pv.product_id = r.pid
  )
  SELECT
    COALESCE(jsonb_agg(
      line || jsonb_build_object('price', unit_price, 'status', 'active', 'addedAt', v_now)
      ORDER BY ord), '[]'::jsonb),
    COALESCE(SUM(unit_price * qty), 0),
    COUNT(*) FILTER (WHERE offshelf)
  INTO v_new_items, v_added_subtotal, v_offshelf
  FROM resolved;

  IF v_offshelf > 0 THEN
    RAISE EXCEPTION '部分商品已下架，請重新整理購物車後再試一次';
  END IF;

  -- ── 併入 items_json ──
  -- 加購品項另起一列而非併入同名品項，出貨與採購時才看得出哪些是後來加的。
  v_merged := COALESCE(v_order.items_json, '[]'::jsonb) || v_new_items;

  -- ── B) 既有品項小計：由訂單欄位回推，不讀 items_json 的 price（理由見檔頭）──
  v_prev_subtotal := GREATEST(
    COALESCE(v_order.total_amount, 0)
      + COALESCE(v_order.discount_amount, 0)
      - COALESCE(v_order.shipping_fee, 0), 0);

  v_subtotal := v_prev_subtotal + v_added_subtotal;

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
