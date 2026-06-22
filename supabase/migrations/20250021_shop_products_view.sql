-- ============================================
-- Migration: shop_products 公開視圖（修復 Phase 3 RLS 後商城看不到商品）
-- 根因：商城以 PostgREST embedded join（products(*) / products!inner）讀 products，
--       Phase 3 將 products 收為店內成員限定後，匿名讀取回 null / 整列消失。
--       過去 products(*) 同時把 cost（成本）、currency 送進匿名瀏覽器 —— 本來就是洩漏。
-- 修法：以「視圖預設繞過 RLS（owner 權限）」的特性，刻意開一扇只含
--       安全欄位、且僅限已上架商品的窗口給商城。
--       前端 select 改用別名：products:shop_products(...)，UI 結構不變。
-- 前置：20250020
-- ============================================

CREATE OR REPLACE VIEW public.shop_products AS
SELECT p.id, p.name, p.sku, p.quantity, p.unit, p.source, p.category_id, p.store_id
FROM products p
WHERE EXISTS (
  SELECT 1 FROM storefront_products sp
  WHERE sp.product_id = p.id AND sp.published
);

GRANT SELECT ON public.shop_products TO anon, authenticated;
