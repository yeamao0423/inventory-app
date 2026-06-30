-- 特價功能：在 storefront_products 加上特價金額與起訖時間
-- 全品一個特價金額（sale_price），on_sale 為總開關，
-- sale_start / sale_end 皆可空：
--   on_sale=false              → 不特價
--   on_sale=true + 無起訖       → 常駐特價
--   只有 sale_start            → 從起始日開始
--   只有 sale_end              → 到結束日為止
--   sale_start + sale_end      → 期間內特價

ALTER TABLE public.storefront_products
  ADD COLUMN IF NOT EXISTS sale_price numeric(10,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS sale_start timestamptz   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS sale_end   timestamptz   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS on_sale    boolean       DEFAULT false NOT NULL;
