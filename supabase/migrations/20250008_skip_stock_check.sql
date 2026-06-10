-- Migration: storefront_products 加入 skip_stock_check 欄位
-- 讓限時單或特殊商品可選擇不檢查庫存

ALTER TABLE storefront_products
  ADD COLUMN IF NOT EXISTS skip_stock_check boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN storefront_products.skip_stock_check
  IS '勾選時不檢查庫存、不扣庫存，適用於限時單等預購型商品';
