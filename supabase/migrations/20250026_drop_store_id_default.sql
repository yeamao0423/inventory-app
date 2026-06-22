-- ============================================
-- Migration: Phase 3 — 移除 store_id DEFAULT 1（多租戶過渡收尾）
-- 背景：20250018 為回填既有資料，把各業務表 store_id 設成 NOT NULL DEFAULT 1。
-- 過渡期已過：所有寫入路徑皆明確帶 store_id（已逐一稽核）——
--   · app 14 處 insert 皆 `store_id: storeId`
--   · place_order RPC 用 p_store_id
--   · accept_invitation RPC 用 invitation.store_id
--   · exchange_rates 為 app 唯讀（store_id 本就是 PK 一部分）
-- 移除 DEFAULT 後，任何漏帶 store_id 的寫入會「立即 NOT NULL 報錯」，
-- 而非靜默落到 Daigogo(1)。這是招第二家店上線前的必要保護。
-- 註：不改 NOT NULL、不改既有資料，純移除預設值，可安全 rollback（重設 DEFAULT 1 即可）。
-- ============================================

ALTER TABLE public.categories           ALTER COLUMN store_id DROP DEFAULT;
ALTER TABLE public.consumer_orders       ALTER COLUMN store_id DROP DEFAULT;
ALTER TABLE public.coupons               ALTER COLUMN store_id DROP DEFAULT;
ALTER TABLE public.exchange_rates        ALTER COLUMN store_id DROP DEFAULT;
ALTER TABLE public.history               ALTER COLUMN store_id DROP DEFAULT;
ALTER TABLE public.invitations           ALTER COLUMN store_id DROP DEFAULT;
ALTER TABLE public.orders                ALTER COLUMN store_id DROP DEFAULT;
ALTER TABLE public.procurement_batches   ALTER COLUMN store_id DROP DEFAULT;
ALTER TABLE public.products              ALTER COLUMN store_id DROP DEFAULT;
ALTER TABLE public.storefront_products   ALTER COLUMN store_id DROP DEFAULT;
ALTER TABLE public.tags                  ALTER COLUMN store_id DROP DEFAULT;
ALTER TABLE public.trips                 ALTER COLUMN store_id DROP DEFAULT;
ALTER TABLE public.user_store_roles      ALTER COLUMN store_id DROP DEFAULT;
ALTER TABLE public.variant_option_types  ALTER COLUMN store_id DROP DEFAULT;
