-- 分類上下架：false = 該分類（含其子分類）從商城選單/篩選隱藏，
-- 掛在底下的商品仍可在「全部商品」瀏覽。後台一律顯示全部分類。
ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
