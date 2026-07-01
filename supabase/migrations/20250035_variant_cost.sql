-- 規格層成本：在 product_variants 加上 variant_cost，可覆蓋商品層成本
-- 成本軸：variant.variant_cost ?? products.cost（留空＝用商品成本）
-- 幣別仍在商品層（products.currency）共用，不另設規格幣別。

ALTER TABLE public.product_variants
  ADD COLUMN IF NOT EXISTS variant_cost numeric(10,2) DEFAULT NULL;
