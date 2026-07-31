-- ══════════════════════════════════════════════
-- 訂單物流成本
--
-- 問題：consumer_orders.shipping_fee 存的是「向客戶收多少」，
--       系統從來沒有記過「實際付給物流多少」。
--       兩者在有收運費時剛好相等（收 60 付 60），所以之前把運費
--       當代收轉付、淨額 0。但滿額免運時收 0 付 60，那 60 元是
--       店家實付出去的錢，卻完全沒被算進成本。
--       （store 4 的 free_shipping_threshold = 0 是全店免運，
--         等於每一單都在自掏運費。）
--
-- 做法：
--   1. stores.settings.shipping_costs 放物流方式 → 成本的對照表
--   2. consumer_orders.shipping_cost 在建單時凍結當下的成本
--
-- 凍結規則跟商品成本快照一致（見 20250057）：價目表日後調整不回溯，
-- 只有物流方式改變時才重算。admin 手動改過的金額不會被蓋掉。
--
-- 運費淨損益 = shipping_fee − shipping_cost
--   有收運費 →  60 − 60 =   0
--   滿額免運 →   0 − 60 = −60   ← 這才是店家真正的支出
-- ══════════════════════════════════════════════

BEGIN;

ALTER TABLE public.consumer_orders
  ADD COLUMN IF NOT EXISTS shipping_cost integer;

COMMENT ON COLUMN public.consumer_orders.shipping_cost IS
  '實際付給物流的成本（TWD），建單時依 stores.settings.shipping_costs 凍結；'
  'shipping_fee 是向客戶收的金額，兩者不同';

-- ── 預設對照表：綠界四大超商 C2C ＋ 未指定（自寄）────────
-- 只補給還沒設定過的店家，不覆蓋已填的值。
UPDATE public.stores
   SET settings = settings || jsonb_build_object(
         'shipping_costs', jsonb_build_object(
           'default',     COALESCE((settings->>'shipping_fee')::int, 60),
           'UNIMARTC2C',  COALESCE((settings->>'shipping_fee')::int, 60),
           'FAMIC2C',     COALESCE((settings->>'shipping_fee')::int, 60),
           'HILIFEC2C',   COALESCE((settings->>'shipping_fee')::int, 60),
           'OKMARTC2C',   COALESCE((settings->>'shipping_fee')::int, 60)
         ))
 WHERE settings->'shipping_costs' IS NULL;

-- ── 寫入 trigger ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.snapshot_order_shipping_cost()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_settings jsonb;
  v_key      text;
  v_cost     numeric;
BEGIN
  -- 已經有金額、且物流方式沒變 → 不動。
  -- 讓 admin 手動填的實際運費不會被價目表蓋掉。
  IF TG_OP = 'UPDATE'
     AND NEW.shipping_subtype IS NOT DISTINCT FROM OLD.shipping_subtype
     AND NEW.shipping_cost IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT settings INTO v_settings FROM stores WHERE id = NEW.store_id;

  -- 沒指定物流方式（匯款自寄）走 default
  v_key := COALESCE(NULLIF(NEW.shipping_subtype, ''), 'default');

  v_cost := COALESCE(
    (v_settings->'shipping_costs'->>v_key)::numeric,
    (v_settings->'shipping_costs'->>'default')::numeric,
    -- 還沒設定過對照表的店家：先假設收多少就付多少
    (v_settings->>'shipping_fee')::numeric,
    60
  );

  NEW.shipping_cost := ROUND(v_cost);
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.snapshot_order_shipping_cost() IS
  '建單／改物流方式時凍結實際物流成本，價目表日後調整不回溯';

DROP TRIGGER IF EXISTS trg_snapshot_order_shipping_cost ON public.consumer_orders;
CREATE TRIGGER trg_snapshot_order_shipping_cost
  BEFORE INSERT OR UPDATE OF shipping_subtype ON public.consumer_orders
  FOR EACH ROW EXECUTE FUNCTION public.snapshot_order_shipping_cost();

-- ── 既有訂單回填 ──────────────────────────────────────────
-- 空指派 shipping_subtype 就會走上面同一支 trigger，邏輯不分兩份。
UPDATE public.consumer_orders
   SET shipping_subtype = shipping_subtype
 WHERE shipping_cost IS NULL;

COMMIT;
