-- ══════════════════════════════════════════════════════════════
-- 庫存價值帳本：擴建 history 表 + trigger 保證無論在哪裡改庫存都自動留下
-- 帶移動加權平均成本的異動記錄。見 docs/superpowers/specs/2026-08-18-inventory-value-ledger-design.md
-- ══════════════════════════════════════════════════════════════

ALTER TABLE public.history
  ADD COLUMN variant_id bigint REFERENCES public.product_variants(id),
  ADD COLUMN resulting_stock integer,
  ADD COLUMN unit_cost numeric,
  ADD COLUMN currency text,
  ADD COLUMN unit_cost_twd numeric,
  ADD COLUMN avg_cost_twd numeric,
  ADD COLUMN resulting_value_twd numeric;

-- SECURITY DEFINER：不管觸發 UPDATE 的是哪個角色（商城 anon 結帳、後台 authenticated
-- 手動改庫存），寫入 history 都要用同一組固定權限，不受呼叫端 RLS 影響——
-- 這是「無論在哪裡改庫存都會留紀錄」這個保證能不能成立的關鍵。
CREATE OR REPLACE FUNCTION public.log_stock_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_product_id bigint;
  v_variant_id bigint;
  v_store_id   bigint;
  v_sku        text;
  v_old_stock  integer;
  v_new_stock  integer;
  v_delta      integer;
  v_currency   text;
  v_raw_cost   numeric;
  v_unit_cost_twd numeric;
  v_rate       numeric;
  v_prev_avg   numeric;
  v_new_avg    numeric;
  v_weight     numeric;
  v_resulting_value numeric;
BEGIN
  IF TG_TABLE_NAME = 'products' THEN
    v_product_id := NEW.id;
    v_variant_id := NULL;
    v_old_stock  := OLD.quantity;
    v_new_stock  := NEW.quantity;
    v_store_id   := NEW.store_id;
    v_sku        := NEW.sku;
    v_currency   := NEW.currency;
    v_raw_cost   := NEW.cost;
  ELSE
    v_variant_id := NEW.id;
    v_old_stock  := OLD.stock;
    v_new_stock  := NEW.stock;
    SELECT p.id, p.store_id, p.sku, p.currency, COALESCE(NEW.variant_cost, p.cost)
      INTO v_product_id, v_store_id, v_sku, v_currency, v_raw_cost
      FROM public.products p WHERE p.id = NEW.product_id;
  END IF;

  v_delta := v_new_stock - v_old_stock;
  IF v_delta = 0 THEN
    RETURN NEW;
  END IF;

  -- 上一筆這個 product/variant 的平均成本（沒有就是 null，代表從沒被賦過成本）
  SELECT h.avg_cost_twd INTO v_prev_avg
    FROM public.history h
   WHERE h.product_id = v_product_id
     AND h.variant_id IS NOT DISTINCT FROM v_variant_id
   ORDER BY h.id DESC LIMIT 1;

  -- 這筆異動當下，商品身上記錄的成本，換算 TWD
  IF v_raw_cost IS NOT NULL THEN
    IF v_currency = 'TWD' OR v_currency IS NULL THEN
      v_unit_cost_twd := v_raw_cost;
    ELSE
      SELECT rate INTO v_rate FROM public.exchange_rates WHERE currency = v_currency;
      IF v_rate IS NOT NULL THEN
        v_unit_cost_twd := round(v_raw_cost * v_rate, 1);
      END IF;
    END IF;
  END IF;

  IF v_delta > 0 THEN
    -- 庫存增加：併入加權平均。加權基準用 max(舊庫存,0)——負庫存（已售未進貨）
    -- 沒有實體庫存可言，不該用負數去加權，見 spec「加權平均的邊界」。
    -- 這筆成本未知（v_unit_cost_twd is null）時不併算，維持原平均——沒有依據就不動它。
    IF v_prev_avg IS NULL THEN
      v_new_avg := v_unit_cost_twd;
    ELSIF v_unit_cost_twd IS NULL THEN
      v_new_avg := v_prev_avg;
    ELSE
      v_weight := GREATEST(v_old_stock, 0);
      v_new_avg := (v_weight * v_prev_avg + v_delta * v_unit_cost_twd) / (v_weight + v_delta);
    END IF;
  ELSE
    -- 庫存減少：平均成本不變，只是從價值裡扣掉「減少量 × 目前平均成本」
    v_new_avg := v_prev_avg;
  END IF;

  v_resulting_value := CASE WHEN v_new_avg IS NULL THEN NULL ELSE GREATEST(v_new_stock, 0) * v_new_avg END;

  INSERT INTO public.history
    (product_id, variant_id, store_id, sku, change, resulting_stock,
     unit_cost, currency, unit_cost_twd, avg_cost_twd, resulting_value_twd, reason, created_at)
  VALUES
    (v_product_id, v_variant_id, v_store_id, v_sku, v_delta, v_new_stock,
     v_raw_cost, v_currency, v_unit_cost_twd, v_new_avg, v_resulting_value, NULL, now());

  RETURN NEW;
END $$;

CREATE TRIGGER log_stock_change_products
  AFTER UPDATE OF quantity ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.log_stock_change();

CREATE TRIGGER log_stock_change_variants
  AFTER UPDATE OF stock ON public.product_variants
  FOR EACH ROW EXECUTE FUNCTION public.log_stock_change();
