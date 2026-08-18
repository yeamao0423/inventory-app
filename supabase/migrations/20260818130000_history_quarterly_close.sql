-- 每季打包：主表結算成「期初餘額」，舊明細封存到 history_archive，主表不無限長大。
-- pg_cron 排程觸發，也可以手動呼叫 close_inventory_history_period() 立即結算。

CREATE TABLE public.history_archive (LIKE public.history INCLUDING ALL);
ALTER TABLE public.history_archive ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow all authenticated history_archive" ON public.history_archive USING (auth.role() = 'authenticated');
GRANT SELECT, INSERT ON public.history_archive TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.close_inventory_history_period()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_cutoff timestamptz := now();
BEGIN
  -- 每個 product/variant 目前最新一筆，寫成新的期初餘額列（reason 標註季度結算）。
  -- resulting_stock IS NOT NULL 這個過濾條件是關鍵：2026-08-12 以前建立的舊 history
  -- 列（擴欄前，`variant_id`/`resulting_stock` 全部是 null）不能被當成「目前狀態」候選，
  -- 不然 change 會被塞 null，違反 NOT NULL 限制。這些舊雜訊本來就沒被追蹤過，直接略過，
  -- 不幫它們造一筆期初列——之後如果那個 product/variant 真的有異動，trigger 會正常起算。
  INSERT INTO public.history
    (product_id, variant_id, store_id, sku, change, resulting_stock,
     avg_cost_twd, resulting_value_twd, reason, created_at)
  SELECT DISTINCT ON (product_id, variant_id)
    product_id, variant_id, store_id, sku, resulting_stock, resulting_stock,
    avg_cost_twd,
    CASE WHEN avg_cost_twd IS NULL THEN NULL ELSE GREATEST(resulting_stock, 0) * avg_cost_twd END,
    '期初餘額：季度結算',
    v_cutoff
  FROM public.history
  WHERE created_at < v_cutoff
    AND resulting_stock IS NOT NULL
  ORDER BY product_id, variant_id, id DESC;

  -- 結算前的舊明細（不含剛寫的期初列，因為它的 created_at = v_cutoff，不 < v_cutoff）搬去封存
  INSERT INTO public.history_archive
  SELECT * FROM public.history WHERE created_at < v_cutoff;

  DELETE FROM public.history WHERE created_at < v_cutoff;
END $$;

-- 每季（1/4/7/10 月 1 號凌晨）自動結算一次
SELECT cron.schedule(
  'inventory-history-quarterly-close',
  '0 0 1 1,4,7,10 *',
  $$SELECT public.close_inventory_history_period()$$
);
