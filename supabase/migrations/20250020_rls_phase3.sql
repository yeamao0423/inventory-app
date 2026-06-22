-- ============================================
-- Migration: 多租戶 Phase 3 — RLS 全面重寫（G2）
-- 原則：
--   * 後台資料：只有該店成員可讀，寫入依角色分級（editor 可增改、admin 可刪、店主全權）
--   * 商城公開資料（目錄類）：anon 可讀；products 整表收回（cost 不再外洩）
--   * 高風險舊洞修補：consumer_orders USING(true)、coupon_codes 公開可讀（可列舉折扣碼）、
--     invitations 公開可讀（可偷 token 奪權）→ 全部改為 SECURITY DEFINER RPC 點查
--   * auth.role() 已棄用 → 一律改 TO anon / TO authenticated + 條件
-- 前置：必須先套用 20250018、20250019
-- ============================================

-- ========== 1) Helper functions ==========
-- SECURITY DEFINER 是為了避免 policy 之間遞迴觸發 user_store_roles 的 RLS；
-- 皆只回傳「呼叫者自己」的布林身分，無資料外洩面

CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM platform_admins WHERE user_id = auth.uid())
$$;

CREATE OR REPLACE FUNCTION public.is_store_member(p_store_id bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_store_roles
    WHERE user_id = auth.uid() AND store_id = p_store_id
      AND role IN ('super_admin', 'admin', 'editor', 'viewer')
  )
$$;

CREATE OR REPLACE FUNCTION public.has_store_role(p_store_id bigint, p_roles text[])
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_store_roles
    WHERE user_id = auth.uid() AND store_id = p_store_id AND role = ANY(p_roles)
  )
$$;

-- 是否與目標使用者同屬任一店（後台成員頁讀同事 profiles 用）
CREATE OR REPLACE FUNCTION public.shares_store(p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_store_roles a
    JOIN user_store_roles b ON a.store_id = b.store_id
    WHERE a.user_id = auth.uid() AND a.role != 'consumer' AND b.user_id = p_user
  )
$$;

-- ========== 2) 取代「公開可讀」舊洞的 RPC ==========

-- 匿名查單（訂單完成頁 /order/[id]）：以 id 點查，取代整表 USING(true)
CREATE OR REPLACE FUNCTION public.get_consumer_order(p_order_id bigint)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT to_jsonb(co.*) FROM consumer_orders co WHERE co.id = p_order_id
$$;

-- 結帳優惠碼預覽：以 code 點查，取代 coupons / coupon_codes 公開可讀（可列舉）
CREATE OR REPLACE FUNCTION public.lookup_coupon(p_code text, p_store_id bigint)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_coupon coupons%ROWTYPE;
  v_cc coupon_codes%ROWTYPE;
  v_is_unique boolean := false;
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

  RETURN jsonb_build_object(
    'found', true, 'is_used', false, 'is_unique', v_is_unique,
    'coupon', jsonb_build_object(
      'id', v_coupon.id, 'name', v_coupon.name,
      'discount_type', v_coupon.discount_type, 'discount_value', v_coupon.discount_value,
      'min_amount', v_coupon.min_amount, 'max_discount', v_coupon.max_discount,
      'max_usage', v_coupon.max_usage, 'usage_count', v_coupon.usage_count,
      'starts_at', v_coupon.starts_at, 'expires_at', v_coupon.expires_at,
      'is_active', v_coupon.is_active
    )
  );
END;
$$;

-- 邀請頁：以 token 點查，取代 invitations 公開可讀（可偷 token）
CREATE OR REPLACE FUNCTION public.get_invitation(p_token text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'id', i.id, 'email', i.email, 'role', i.role, 'store_id', i.store_id,
    'status', i.status, 'expires_at', i.expires_at, 'store_name', s.name
  )
  FROM invitations i JOIN stores s ON s.id = i.store_id
  WHERE i.token = p_token
$$;

-- 接受邀請：upsert 角色 + 標記 accepted（原本靠 client 直寫 user_store_roles，現已被新 policy 擋下）
CREATE OR REPLACE FUNCTION public.accept_invitation(p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_inv invitations%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', '請先登入');
  END IF;

  SELECT * INTO v_inv FROM invitations WHERE token = p_token FOR UPDATE;
  IF v_inv.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', '邀請不存在');
  END IF;
  IF v_inv.status != 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'error', '此邀請已被使用');
  END IF;
  IF v_inv.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', '邀請已過期');
  END IF;

  INSERT INTO user_store_roles (user_id, store_id, role)
  VALUES (auth.uid(), v_inv.store_id, v_inv.role)
  ON CONFLICT (user_id, store_id) DO UPDATE SET role = EXCLUDED.role;

  UPDATE invitations SET status = 'accepted' WHERE id = v_inv.id;

  RETURN jsonb_build_object('ok', true, 'store_id', v_inv.store_id, 'role', v_inv.role);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.accept_invitation(text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.accept_invitation(text) TO authenticated;
-- get_consumer_order / lookup_coupon / get_invitation 維持 anon 可呼叫（商城/邀請頁未登入可用）

-- ========== 3) 移除所有舊 policy（重建為唯一真相）==========
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT tablename, policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename IN (
      'stores', 'profiles', 'user_store_roles', 'invitations', 'platform_admins',
      'products', 'product_variants', 'product_images', 'product_tags',
      'categories', 'tags', 'variant_option_types', 'variant_option_values',
      'custom_options', 'storefront_products', 'exchange_rates', 'history',
      'orders', 'consumer_orders', 'consumers', 'store_consumers',
      'coupons', 'coupon_codes', 'coupon_usage',
      'trips', 'trip_expenses', 'procurement_batches', 'procurement_items'
    )
  LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', r.policyname, r.tablename);
  END LOOP;
END $$;

-- 確保 RLS 全開
ALTER TABLE stores                ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles              ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_store_roles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations           ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admins       ENABLE ROW LEVEL SECURITY;
ALTER TABLE products              ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_variants      ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_images        ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_tags          ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories            ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE variant_option_types  ENABLE ROW LEVEL SECURITY;
ALTER TABLE variant_option_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_options        ENABLE ROW LEVEL SECURITY;
ALTER TABLE storefront_products   ENABLE ROW LEVEL SECURITY;
ALTER TABLE exchange_rates        ENABLE ROW LEVEL SECURITY;
ALTER TABLE history               ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders                ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumer_orders       ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumers             ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_consumers       ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupons               ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupon_codes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupon_usage          ENABLE ROW LEVEL SECURITY;
ALTER TABLE trips                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE trip_expenses         ENABLE ROW LEVEL SECURITY;
ALTER TABLE procurement_batches   ENABLE ROW LEVEL SECURITY;
ALTER TABLE procurement_items     ENABLE ROW LEVEL SECURITY;

-- ========== 4) 新 policy ==========
-- 角色組合：寫入 = super_admin/admin/editor；刪除 = super_admin/admin；店主限定 = super_admin

-- ── stores：商城靠 slug 解析店家 → anon 只能讀營運中的店 ──
CREATE POLICY "public read active stores" ON stores
  FOR SELECT TO anon, authenticated
  USING (is_active OR is_store_member(id) OR is_platform_admin());
CREATE POLICY "platform insert stores" ON stores
  FOR INSERT TO authenticated WITH CHECK (is_platform_admin());
CREATE POLICY "owner or platform update stores" ON stores
  FOR UPDATE TO authenticated
  USING (is_platform_admin() OR has_store_role(id, ARRAY['super_admin']))
  WITH CHECK (is_platform_admin() OR has_store_role(id, ARRAY['super_admin']));

-- ── profiles：自己 + 同店同事 + 平台方 ──
CREATE POLICY "read own or colleague profiles" ON profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR shares_store(id) OR is_platform_admin());
CREATE POLICY "insert own profile" ON profiles
  FOR INSERT TO authenticated WITH CHECK (id = auth.uid());
CREATE POLICY "update own profile" ON profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid()) WITH CHECK (id = auth.uid());

-- ── user_store_roles：自己可見＋同店成員可見；異動僅店主（邀請接受走 accept_invitation RPC）──
CREATE POLICY "read own or store roles" ON user_store_roles
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR is_store_member(store_id));
CREATE POLICY "owner manage roles" ON user_store_roles
  FOR INSERT TO authenticated WITH CHECK (has_store_role(store_id, ARRAY['super_admin']));
CREATE POLICY "owner update roles" ON user_store_roles
  FOR UPDATE TO authenticated
  USING (has_store_role(store_id, ARRAY['super_admin']))
  WITH CHECK (has_store_role(store_id, ARRAY['super_admin']));
CREATE POLICY "owner delete roles" ON user_store_roles
  FOR DELETE TO authenticated USING (has_store_role(store_id, ARRAY['super_admin']));

-- ── invitations：店主與平台方管理；匿名讀取走 get_invitation RPC ──
CREATE POLICY "owner or platform manage invitations" ON invitations
  FOR ALL TO authenticated
  USING (has_store_role(store_id, ARRAY['super_admin']) OR is_platform_admin())
  WITH CHECK (has_store_role(store_id, ARRAY['super_admin']) OR is_platform_admin());

-- ── platform_admins：只能查自己 ──
CREATE POLICY "read own platform admin" ON platform_admins
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- ── products：含成本，整表僅店內成員（商城不直接讀此表）──
CREATE POLICY "members read products" ON products
  FOR SELECT TO authenticated USING (is_store_member(store_id));
CREATE POLICY "editors insert products" ON products
  FOR INSERT TO authenticated WITH CHECK (has_store_role(store_id, ARRAY['super_admin','admin','editor']));
CREATE POLICY "editors update products" ON products
  FOR UPDATE TO authenticated
  USING (has_store_role(store_id, ARRAY['super_admin','admin','editor']))
  WITH CHECK (has_store_role(store_id, ARRAY['super_admin','admin','editor']));
CREATE POLICY "admins delete products" ON products
  FOR DELETE TO authenticated USING (has_store_role(store_id, ARRAY['super_admin','admin']));

-- ── 商品子表（商城目錄需要 anon 讀；寫入跟隨父商品的店）──
CREATE POLICY "public read variants" ON product_variants
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "editors write variants" ON product_variants
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM products p WHERE p.id = product_id
                 AND has_store_role(p.store_id, ARRAY['super_admin','admin','editor'])))
  WITH CHECK (EXISTS (SELECT 1 FROM products p WHERE p.id = product_id
                 AND has_store_role(p.store_id, ARRAY['super_admin','admin','editor'])));

CREATE POLICY "public read product_images" ON product_images
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "editors write product_images" ON product_images
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM products p WHERE p.id = product_id
                 AND has_store_role(p.store_id, ARRAY['super_admin','admin','editor'])))
  WITH CHECK (EXISTS (SELECT 1 FROM products p WHERE p.id = product_id
                 AND has_store_role(p.store_id, ARRAY['super_admin','admin','editor'])));

CREATE POLICY "public read product_tags" ON product_tags
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "editors write product_tags" ON product_tags
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM products p WHERE p.id = product_id
                 AND has_store_role(p.store_id, ARRAY['super_admin','admin','editor'])))
  WITH CHECK (EXISTS (SELECT 1 FROM products p WHERE p.id = product_id
                 AND has_store_role(p.store_id, ARRAY['super_admin','admin','editor'])));

CREATE POLICY "public read custom_options" ON custom_options
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "editors write custom_options" ON custom_options
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM products p WHERE p.id = product_id
                 AND has_store_role(p.store_id, ARRAY['super_admin','admin','editor'])))
  WITH CHECK (EXISTS (SELECT 1 FROM products p WHERE p.id = product_id
                 AND has_store_role(p.store_id, ARRAY['super_admin','admin','editor'])));

-- ── 分類/標籤/規格定義（商城篩選用，anon 可讀；寫入限本店）──
CREATE POLICY "public read categories" ON categories
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "editors write categories" ON categories
  FOR ALL TO authenticated
  USING (has_store_role(store_id, ARRAY['super_admin','admin','editor']))
  WITH CHECK (has_store_role(store_id, ARRAY['super_admin','admin','editor']));

CREATE POLICY "public read tags" ON tags
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "editors write tags" ON tags
  FOR ALL TO authenticated
  USING (has_store_role(store_id, ARRAY['super_admin','admin','editor']))
  WITH CHECK (has_store_role(store_id, ARRAY['super_admin','admin','editor']));

CREATE POLICY "public read variant_option_types" ON variant_option_types
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "editors write variant_option_types" ON variant_option_types
  FOR ALL TO authenticated
  USING (has_store_role(store_id, ARRAY['super_admin','admin','editor']))
  WITH CHECK (has_store_role(store_id, ARRAY['super_admin','admin','editor']));

CREATE POLICY "public read variant_option_values" ON variant_option_values
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "editors write variant_option_values" ON variant_option_values
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM variant_option_types vot WHERE vot.id = option_type_id
                 AND has_store_role(vot.store_id, ARRAY['super_admin','admin','editor'])))
  WITH CHECK (EXISTS (SELECT 1 FROM variant_option_types vot WHERE vot.id = option_type_id
                 AND has_store_role(vot.store_id, ARRAY['super_admin','admin','editor'])));

-- ── storefront_products：anon 只看已上架；店內成員全看 ──
CREATE POLICY "public read published storefront" ON storefront_products
  FOR SELECT TO anon, authenticated
  USING (published = true OR is_store_member(store_id));
CREATE POLICY "editors write storefront" ON storefront_products
  FOR ALL TO authenticated
  USING (has_store_role(store_id, ARRAY['super_admin','admin','editor']))
  WITH CHECK (has_store_role(store_id, ARRAY['super_admin','admin','editor']));

-- ── exchange_rates / history / orders（自建訂單）：店內 ──
CREATE POLICY "members read rates" ON exchange_rates
  FOR SELECT TO authenticated USING (is_store_member(store_id));
CREATE POLICY "admins write rates" ON exchange_rates
  FOR ALL TO authenticated
  USING (has_store_role(store_id, ARRAY['super_admin','admin']))
  WITH CHECK (has_store_role(store_id, ARRAY['super_admin','admin']));

CREATE POLICY "members read history" ON history
  FOR SELECT TO authenticated USING (is_store_member(store_id));
CREATE POLICY "editors insert history" ON history
  FOR INSERT TO authenticated WITH CHECK (has_store_role(store_id, ARRAY['super_admin','admin','editor']));

CREATE POLICY "members read orders" ON orders
  FOR SELECT TO authenticated USING (is_store_member(store_id));
CREATE POLICY "editors write orders" ON orders
  FOR INSERT TO authenticated WITH CHECK (has_store_role(store_id, ARRAY['super_admin','admin','editor']));
CREATE POLICY "editors update orders" ON orders
  FOR UPDATE TO authenticated
  USING (has_store_role(store_id, ARRAY['super_admin','admin','editor']))
  WITH CHECK (has_store_role(store_id, ARRAY['super_admin','admin','editor']));
CREATE POLICY "admins delete orders" ON orders
  FOR DELETE TO authenticated USING (has_store_role(store_id, ARRAY['super_admin','admin']));

-- ── consumer_orders：店內成員＋消費者本人（email 比對）；匿名查單走 get_consumer_order RPC ──
-- 下單一律走 place_order（SECURITY DEFINER），不再開放匿名直接 INSERT
CREATE POLICY "members or owner read consumer_orders" ON consumer_orders
  FOR SELECT TO authenticated
  USING (is_store_member(store_id) OR email = (auth.jwt() ->> 'email'));
CREATE POLICY "editors insert consumer_orders" ON consumer_orders
  FOR INSERT TO authenticated WITH CHECK (has_store_role(store_id, ARRAY['super_admin','admin','editor']));
CREATE POLICY "members or owner update consumer_orders" ON consumer_orders
  FOR UPDATE TO authenticated
  USING (is_store_member(store_id) OR email = (auth.jwt() ->> 'email'))
  WITH CHECK (is_store_member(store_id) OR email = (auth.jwt() ->> 'email'));

-- ── consumers / store_consumers（沿用既有設計，重建）──
CREATE POLICY "users read own profile" ON consumers
  FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "users insert own profile" ON consumers
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);
CREATE POLICY "users update own profile" ON consumers
  FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

CREATE POLICY "consumer read own membership" ON store_consumers
  FOR SELECT TO authenticated USING (consumer_id = auth.uid());
CREATE POLICY "consumer join store" ON store_consumers
  FOR INSERT TO authenticated WITH CHECK (consumer_id = auth.uid());
CREATE POLICY "staff read store members" ON store_consumers
  FOR SELECT TO authenticated USING (is_store_member(store_id));
CREATE POLICY "admin update store members" ON store_consumers
  FOR UPDATE TO authenticated
  USING (has_store_role(store_id, ARRAY['super_admin','admin']))
  WITH CHECK (has_store_role(store_id, ARRAY['super_admin','admin']));

-- ── coupons / coupon_codes / coupon_usage：店內；商城預覽走 lookup_coupon RPC ──
CREATE POLICY "members read coupons" ON coupons
  FOR SELECT TO authenticated USING (is_store_member(store_id));
CREATE POLICY "editors write coupons" ON coupons
  FOR ALL TO authenticated
  USING (has_store_role(store_id, ARRAY['super_admin','admin','editor']))
  WITH CHECK (has_store_role(store_id, ARRAY['super_admin','admin','editor']));

CREATE POLICY "members read coupon_codes" ON coupon_codes
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM coupons c WHERE c.id = coupon_id AND is_store_member(c.store_id)));
CREATE POLICY "editors write coupon_codes" ON coupon_codes
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM coupons c WHERE c.id = coupon_id
                 AND has_store_role(c.store_id, ARRAY['super_admin','admin','editor'])))
  WITH CHECK (EXISTS (SELECT 1 FROM coupons c WHERE c.id = coupon_id
                 AND has_store_role(c.store_id, ARRAY['super_admin','admin','editor'])));

CREATE POLICY "members read coupon_usage" ON coupon_usage
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM coupons c WHERE c.id = coupon_id AND is_store_member(c.store_id)));
CREATE POLICY "admins delete coupon_usage" ON coupon_usage
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM coupons c WHERE c.id = coupon_id
                 AND has_store_role(c.store_id, ARRAY['super_admin','admin'])));

-- ── trips / trip_expenses：店主限定（差旅成本敏感）──
CREATE POLICY "owner manage trips" ON trips
  FOR ALL TO authenticated
  USING (has_store_role(store_id, ARRAY['super_admin']))
  WITH CHECK (has_store_role(store_id, ARRAY['super_admin']));
CREATE POLICY "owner manage trip_expenses" ON trip_expenses
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM trips t WHERE t.id = trip_id
                 AND has_store_role(t.store_id, ARRAY['super_admin'])))
  WITH CHECK (EXISTS (SELECT 1 FROM trips t WHERE t.id = trip_id
                 AND has_store_role(t.store_id, ARRAY['super_admin'])));

-- ── procurement：店內成員可讀，編輯以上可寫 ──
CREATE POLICY "members read batches" ON procurement_batches
  FOR SELECT TO authenticated USING (is_store_member(store_id));
CREATE POLICY "editors write batches" ON procurement_batches
  FOR ALL TO authenticated
  USING (has_store_role(store_id, ARRAY['super_admin','admin','editor']))
  WITH CHECK (has_store_role(store_id, ARRAY['super_admin','admin','editor']));
CREATE POLICY "members read procurement_items" ON procurement_items
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM procurement_batches b WHERE b.id = batch_id AND is_store_member(b.store_id)));
CREATE POLICY "editors write procurement_items" ON procurement_items
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM procurement_batches b WHERE b.id = batch_id
                 AND has_store_role(b.store_id, ARRAY['super_admin','admin','editor'])))
  WITH CHECK (EXISTS (SELECT 1 FROM procurement_batches b WHERE b.id = batch_id
                 AND has_store_role(b.store_id, ARRAY['super_admin','admin','editor'])));

-- ========== 5) Daigogo settings seed（remote 首次套用時補上；local 已有則跳過）==========
UPDATE stores SET settings = '{
  "shipping_fee": 60,
  "free_shipping_threshold": 3800,
  "sender_name": "徐承豊",
  "sender_phone": "0955367287",
  "sender_email": "daigogosg@gmail.com",
  "return_store_name": "和復門市",
  "return_store_number": "263115",
  "package_value": 999
}'::jsonb
WHERE id = 1 AND settings = '{}'::jsonb;
