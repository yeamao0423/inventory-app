-- ============================================================
-- Migration: 商品欄位可編輯 + history 改用 product_id 關聯
-- 在 Supabase Cloud Dashboard → SQL Editor 中執行
-- ============================================================

-- 1. 移除 products.sku 的 UNIQUE 約束
ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_sku_key;

-- 2. 允許 sku 為空（移除 NOT NULL）
ALTER TABLE public.products ALTER COLUMN sku DROP NOT NULL;

-- 3. history 表新增 product_id 欄位
ALTER TABLE public.history ADD COLUMN IF NOT EXISTS product_id bigint REFERENCES public.products(id) ON DELETE SET NULL;

-- 4. 回填 history.product_id（用現有 sku 比對）
UPDATE public.history h
SET product_id = p.id
FROM public.products p
WHERE h.sku = p.sku AND h.product_id IS NULL;

-- 5. history.sku 改為可空（保留歷史資料，但不再強制）
ALTER TABLE public.history ALTER COLUMN sku DROP NOT NULL;
