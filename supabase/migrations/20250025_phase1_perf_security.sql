-- ============================================
-- Migration: Phase 1 — 效能 / 安全硬化（純 DB，無 app 改動）
-- 來源：Supabase advisor（performance + security）。語意完全不變，只改：
--   1) RLS：auth.uid()/auth.jwt() 包成 (select ...)，避免逐列重算（auth_rls_initplan）
--   2) 補關鍵 FK 覆蓋索引（有量、會被 join/cascade 打到的）
--   3) 12 個 function 補 SET search_path = public（function_search_path_mutable）
-- 註：store_id 索引被 advisor 標「未使用」是因為現在單店，多店後必用，故不動。
-- ============================================

-- ========== 1) RLS initplan：把 auth.* 包成單次 subquery ==========
-- 只改「不依賴資料列」的呼叫（auth.uid() / auth.jwt() / is_platform_admin()）；
-- 依賴列的 helper（shares_store(id) / is_store_member(store_id)）維持原樣。

-- consumers
DROP POLICY IF EXISTS "users insert own profile" ON public.consumers;
CREATE POLICY "users insert own profile" ON public.consumers
  FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = id);

DROP POLICY IF EXISTS "users read own profile" ON public.consumers;
CREATE POLICY "users read own profile" ON public.consumers
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = id);

DROP POLICY IF EXISTS "users update own profile" ON public.consumers;
CREATE POLICY "users update own profile" ON public.consumers
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = id)
  WITH CHECK ((select auth.uid()) = id);

-- platform_admins
DROP POLICY IF EXISTS "read own platform admin" ON public.platform_admins;
CREATE POLICY "read own platform admin" ON public.platform_admins
  FOR SELECT TO authenticated
  USING (user_id = (select auth.uid()));

-- profiles
DROP POLICY IF EXISTS "insert own profile" ON public.profiles;
CREATE POLICY "insert own profile" ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (id = (select auth.uid()));

DROP POLICY IF EXISTS "read own or colleague profiles" ON public.profiles;
CREATE POLICY "read own or colleague profiles" ON public.profiles
  FOR SELECT TO authenticated
  USING ((id = (select auth.uid())) OR shares_store(id) OR (select is_platform_admin()));

DROP POLICY IF EXISTS "update own profile" ON public.profiles;
CREATE POLICY "update own profile" ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = (select auth.uid()))
  WITH CHECK (id = (select auth.uid()));

-- store_consumers
DROP POLICY IF EXISTS "consumer join store" ON public.store_consumers;
CREATE POLICY "consumer join store" ON public.store_consumers
  FOR INSERT TO authenticated
  WITH CHECK (consumer_id = (select auth.uid()));

DROP POLICY IF EXISTS "consumer read own membership" ON public.store_consumers;
CREATE POLICY "consumer read own membership" ON public.store_consumers
  FOR SELECT TO authenticated
  USING (consumer_id = (select auth.uid()));

-- user_store_roles
DROP POLICY IF EXISTS "read own or store roles" ON public.user_store_roles;
CREATE POLICY "read own or store roles" ON public.user_store_roles
  FOR SELECT TO authenticated
  USING ((user_id = (select auth.uid())) OR is_store_member(store_id));

-- consumer_orders（用 auth.jwt() ->> 'email'）
DROP POLICY IF EXISTS "members or owner read consumer_orders" ON public.consumer_orders;
CREATE POLICY "members or owner read consumer_orders" ON public.consumer_orders
  FOR SELECT TO authenticated
  USING (is_store_member(store_id) OR (email = ((select auth.jwt()) ->> 'email')));

DROP POLICY IF EXISTS "members or owner update consumer_orders" ON public.consumer_orders;
CREATE POLICY "members or owner update consumer_orders" ON public.consumer_orders
  FOR UPDATE TO authenticated
  USING (is_store_member(store_id) OR (email = ((select auth.jwt()) ->> 'email')))
  WITH CHECK (is_store_member(store_id) OR (email = ((select auth.jwt()) ->> 'email')));

-- ========== 2) 關鍵 FK 覆蓋索引 ==========
CREATE INDEX IF NOT EXISTS product_variants_product_id_idx  ON public.product_variants(product_id);
CREATE INDEX IF NOT EXISTS product_images_product_id_idx    ON public.product_images(product_id);
CREATE INDEX IF NOT EXISTS history_product_id_idx           ON public.history(product_id);
CREATE INDEX IF NOT EXISTS procurement_items_batch_id_idx   ON public.procurement_items(batch_id);
CREATE INDEX IF NOT EXISTS procurement_items_product_id_idx ON public.procurement_items(product_id);
CREATE INDEX IF NOT EXISTS procurement_items_variant_id_idx ON public.procurement_items(variant_id);
CREATE INDEX IF NOT EXISTS consumer_orders_coupon_id_idx    ON public.consumer_orders(coupon_id);

-- ========== 3) function 補 search_path（缺的 12 個）==========
ALTER FUNCTION public.decrement_product_stock(bigint, integer)            SET search_path = public;
ALTER FUNCTION public.decrement_variant_stock(bigint, integer)            SET search_path = public;
ALTER FUNCTION public.handle_new_user()                                   SET search_path = public;
ALTER FUNCTION public.member_pick_level(bigint, numeric, integer)         SET search_path = public;
ALTER FUNCTION public.member_qualifying(bigint, text, timestamptz, numeric, integer) SET search_path = public;
ALTER FUNCTION public.normalize_email(text)                               SET search_path = public;
ALTER FUNCTION public.place_order(text, text, text, text, text, text, text, text, text, text, jsonb, numeric, integer, text, numeric, text, bigint) SET search_path = public;
ALTER FUNCTION public.redeem_coupon(text, numeric, text, bigint)          SET search_path = public;
ALTER FUNCTION public.refund_coupon(bigint)                               SET search_path = public;
ALTER FUNCTION public.revenue_report_orders(date, date, bigint, bigint, text[], text[], bigint) SET search_path = public;
ALTER FUNCTION public.revenue_report_items(date, date, bigint, bigint, text[], text[], bigint)  SET search_path = public;
ALTER FUNCTION public.update_updated_at()                                 SET search_path = public;
