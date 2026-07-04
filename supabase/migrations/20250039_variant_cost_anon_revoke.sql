-- 安全修復：規格層成本 variant_cost 對匿名者封鎖
-- 背景：product_variants 的 SELECT RLS 是 public read USING(true)（商城訪客要看
--       庫存/售價），migration 35 在同一張全開表加了 variant_cost，導致任何人用
--       anon key 打 REST API 就能讀到每個規格的進貨成本（跨店洩密風險）。
-- 做法：比照 shop_products 藏 products.cost 的防線——表維持可讀，但把 anon 的
--       table-level SELECT 收回，改為只授權「非成本」欄位。variant_cost 這一欄
--       anon 讀不到；authenticated（後台登入者）維持完整讀取，不受影響。
-- 注意：收回 table-level SELECT 後，PostgREST 遇到 select('*') 或選到 variant_cost
--       會整句報錯，因此商城端查詢須明列欄位（見 shop/src/lib/data.js）。

REVOKE SELECT ON public.product_variants FROM anon;

GRANT SELECT (
  id,
  product_id,
  options,
  stock,
  price_adjustment,
  variant_price,
  created_at,
  sale_price
) ON public.product_variants TO anon;
