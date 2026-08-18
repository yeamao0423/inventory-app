-- 期初基準：對每個現有商品/規格，用「現在的 stock × 現在的成本」寫一筆起點，
-- 不管這個商品過去有沒有走過採購批次留下痕跡，上線那一刻全部起算。
-- 直接 INSERT INTO history（不經過 trigger，因為沒有真的 UPDATE stock/quantity）。
CREATE OR REPLACE FUNCTION public.seed_inventory_value_opening_balance()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r record;
  v_avg   numeric;
  v_rate  numeric;
  v_value numeric;
BEGIN
  FOR r IN
    SELECT p.id AS product_id, NULL::bigint AS variant_id, p.store_id, p.sku,
           p.quantity AS stock, p.currency, p.cost AS raw_cost
      FROM public.products p
     WHERE NOT EXISTS (SELECT 1 FROM public.product_variants v WHERE v.product_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM public.history h WHERE h.product_id = p.id AND h.variant_id IS NULL)
    UNION ALL
    SELECT p.id, v.id, p.store_id, p.sku, v.stock, p.currency, COALESCE(v.variant_cost, p.cost)
      FROM public.product_variants v
      JOIN public.products p ON p.id = v.product_id
     WHERE NOT EXISTS (SELECT 1 FROM public.history h WHERE h.product_id = p.id AND h.variant_id = v.id)
  LOOP
    v_avg := NULL;
    IF r.raw_cost IS NOT NULL THEN
      IF r.currency = 'TWD' OR r.currency IS NULL THEN
        v_avg := r.raw_cost;
      ELSE
        SELECT rate INTO v_rate FROM public.exchange_rates WHERE currency = r.currency;
        IF v_rate IS NOT NULL THEN v_avg := round(r.raw_cost * v_rate, 1); END IF;
      END IF;
    END IF;
    v_value := CASE WHEN v_avg IS NULL THEN NULL ELSE GREATEST(r.stock, 0) * v_avg END;

    INSERT INTO public.history
      (product_id, variant_id, store_id, sku, change, resulting_stock,
       unit_cost, currency, unit_cost_twd, avg_cost_twd, resulting_value_twd, reason, created_at)
    VALUES
      (r.product_id, r.variant_id, r.store_id, r.sku, r.stock, r.stock,
       r.raw_cost, r.currency, v_avg, v_avg, v_value, '期初基準：庫存價值追蹤上線', now());
  END LOOP;
END $$;

-- 上線當下立刻跑一次，對現有全部商品/規格建立起點
SELECT public.seed_inventory_value_opening_balance();
