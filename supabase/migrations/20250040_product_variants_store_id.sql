-- 多租戶一致性：product_variants 補上 store_id
-- 背景：product_variants 是唯一沒有自己 store_id 的業務表（靠 FK 到 products 取得
--       店別）。後台 OrdersPage 有三處 product_variants.select 未帶店別過濾，第二家
--       店上線後會把別店規格一起撈進記憶體（跨店讀取）。RLS 對 variants 是 USING(true)
--       擋不住，正解是讓查詢能直接按 store_id 過濾。
-- 做法：加 store_id 欄位，讓它跟所有兄弟表一致；回填既有資料、加索引，並用 BEFORE
--       觸發器在 INSERT/UPDATE 時自動從父商品帶入（後台寫入端不必改）。
-- 隔離：SELECT RLS 維持 USING(true)（商城訪客仍須讀已上架商品的規格），跨店讀取的
--       修復落在應用層查詢（.eq('store_id', storeId)），本欄位使其可行。

-- 1) 加欄位（先允許 NULL 以便回填）
ALTER TABLE public.product_variants
  ADD COLUMN IF NOT EXISTS store_id bigint REFERENCES public.stores(id);

-- 2) 回填：從父商品帶入店別
UPDATE public.product_variants v
   SET store_id = p.store_id
  FROM public.products p
 WHERE v.product_id = p.id
   AND v.store_id IS NULL;

-- 3) 回填完成後鎖成 NOT NULL（fail-fast，比照 migration 26 的顯式店別政策）
ALTER TABLE public.product_variants
  ALTER COLUMN store_id SET NOT NULL;

-- 4) 索引：多租戶後每個後台查詢都靠它過濾
CREATE INDEX IF NOT EXISTS product_variants_store_id_idx
  ON public.product_variants (store_id);

-- 5) 觸發器：INSERT/UPDATE 時若未帶 store_id，自動從父商品補上，避免寫入端漏帶
CREATE OR REPLACE FUNCTION public.set_variant_store_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.store_id IS NULL THEN
    SELECT store_id INTO NEW.store_id
      FROM public.products
     WHERE id = NEW.product_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS product_variants_set_store_id ON public.product_variants;
CREATE TRIGGER product_variants_set_store_id
  BEFORE INSERT OR UPDATE ON public.product_variants
  FOR EACH ROW EXECUTE FUNCTION public.set_variant_store_id();

-- 6) store_id 非敏感，開放 anon 讀取（migration 39 已改成欄位級授權，新欄位須顯式授權）
GRANT SELECT (store_id) ON public.product_variants TO anon;
