-- ============================================
-- Migration: Add variant_price to product_variants
-- Run this in Supabase Dashboard → SQL Editor
-- ============================================

-- Add variant_price column (nullable, when NULL falls back to shop_price)
ALTER TABLE public.product_variants
ADD COLUMN IF NOT EXISTS variant_price numeric(10,2) DEFAULT NULL;

-- Migrate existing data: convert price_adjustment to absolute price
-- For variants that have a non-zero adjustment, compute the final price
-- based on their linked storefront_products.shop_price
UPDATE public.product_variants pv
SET variant_price = sp.shop_price + pv.price_adjustment
FROM public.storefront_products sp
WHERE sp.product_id = pv.product_id
  AND pv.price_adjustment != 0;

-- For variants with zero adjustment, leave variant_price NULL
-- (will fall back to shop_price in the UI)
