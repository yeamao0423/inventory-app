-- 規格層特價：在 product_variants 加上 sale_price，可覆蓋全品特價
-- 特價軸：variant.sale_price ?? storefront_products.sale_price（留空＝用全品特價）
-- on_sale / sale_start / sale_end 仍在商品層（storefront_products）共用檔期。

ALTER TABLE public.product_variants
  ADD COLUMN IF NOT EXISTS sale_price numeric(10,2) DEFAULT NULL;
