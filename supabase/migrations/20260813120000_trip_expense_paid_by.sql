-- ══════════════════════════════════════════════
-- 行程費用代墊
--
-- trip_expenses 原本沒有付款人欄位：機票、住宿、交通等費用一律視為店家出的
-- 錢（見 20250056 決策，當時老闆知情且暫不加）。現在補上，讓員工代墊的
-- 差旅費比照進貨代墊（procurement_items.paid_by），一併在拆賬時算進「代墊
-- 返還」。
--
-- 沿用 procurement_batches 的作法：settled 標記這筆費用是否已被某次拆賬結
-- 清，拆賬時鎖定、作廢時還原，結清哪些筆記錄在 trip_settlements.settled_
-- expenses（跟 settled_batches 同一套快照邏輯）。
-- ══════════════════════════════════════════════

BEGIN;

ALTER TABLE trip_expenses
  ADD COLUMN IF NOT EXISTS paid_by uuid REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS settled boolean NOT NULL DEFAULT false;

ALTER TABLE trip_settlements
  ADD COLUMN IF NOT EXISTS settled_expenses jsonb NOT NULL DEFAULT '[]'::jsonb;

-- ── settle_trip：連同本趟未結清的代墊費用一起結清 ──────────
CREATE OR REPLACE FUNCTION public.settle_trip(
  p_trip_id      bigint,
  p_revenue      numeric,
  p_product_cost numeric,
  p_trip_expense numeric,
  p_net_profit   numeric,
  p_lines        jsonb,          -- [{user_id, user_name, share_pct, profit_share, reimbursement, payout}]
  p_note         text DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_store_id      bigint;
  v_settlement_id bigint;
  v_batches       jsonb;
  v_expenses      jsonb;
  v_total         numeric;
BEGIN
  SELECT store_id INTO v_store_id FROM trips WHERE id = p_trip_id;
  IF v_store_id IS NULL THEN
    RAISE EXCEPTION '行程不存在';
  END IF;
  IF NOT has_store_role(v_store_id, ARRAY['super_admin']) THEN
    RAISE EXCEPTION '沒有拆賬權限';
  END IF;
  IF EXISTS (SELECT 1 FROM trip_settlements WHERE trip_id = p_trip_id AND status = 'active') THEN
    RAISE EXCEPTION '此行程已完成拆賬，請先作廢後再重算';
  END IF;

  -- 掛在本趟、尚未結清的批次：連同結清前狀態一起記下來
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'prev_status', status)), '[]')
    INTO v_batches
    FROM procurement_batches
   WHERE trip_id = p_trip_id AND store_id = v_store_id AND status <> 'settled';

  -- 掛在本趟、有指定付款人、尚未結清的費用（沒指定付款人的視為店家出錢，不進代墊）
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id)), '[]')
    INTO v_expenses
    FROM trip_expenses
   WHERE trip_id = p_trip_id AND paid_by IS NOT NULL AND settled = false;

  SELECT COALESCE(SUM((l->>'payout')::numeric), 0) INTO v_total
    FROM jsonb_array_elements(p_lines) l;

  INSERT INTO trip_settlements (
    trip_id, settled_by, revenue, product_cost, trip_expense,
    net_profit, total_payout, settled_batches, settled_expenses, note
  ) VALUES (
    p_trip_id, auth.uid(), p_revenue, p_product_cost, p_trip_expense,
    p_net_profit, v_total, v_batches, v_expenses, p_note
  ) RETURNING id INTO v_settlement_id;

  INSERT INTO trip_settlement_lines (
    settlement_id, user_id, user_name, share_pct, profit_share, reimbursement, payout
  )
  SELECT v_settlement_id,
         NULLIF(l->>'user_id', '')::uuid,
         l->>'user_name',
         COALESCE((l->>'share_pct')::numeric, 0),
         COALESCE((l->>'profit_share')::numeric, 0),
         COALESCE((l->>'reimbursement')::numeric, 0),
         COALESCE((l->>'payout')::numeric, 0)
    FROM jsonb_array_elements(p_lines) l;

  UPDATE procurement_batches
     SET status = 'settled'
   WHERE id IN (SELECT (b->>'id')::bigint FROM jsonb_array_elements(v_batches) b);

  UPDATE trip_expenses
     SET settled = true
   WHERE id IN (SELECT (e->>'id')::bigint FROM jsonb_array_elements(v_expenses) e);

  RETURN v_settlement_id;
END;
$$;

-- ── void_trip_settlement：作廢重算，批次與代墊費用一併退回原狀態 ──
CREATE OR REPLACE FUNCTION public.void_trip_settlement(p_settlement_id bigint)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_store_id bigint;
  v_batches  jsonb;
  v_expenses jsonb;
BEGIN
  SELECT t.store_id, s.settled_batches, s.settled_expenses
    INTO v_store_id, v_batches, v_expenses
    FROM trip_settlements s JOIN trips t ON t.id = s.trip_id
   WHERE s.id = p_settlement_id AND s.status = 'active';

  IF v_store_id IS NULL THEN
    RAISE EXCEPTION '找不到生效中的拆賬紀錄';
  END IF;
  IF NOT has_store_role(v_store_id, ARRAY['super_admin']) THEN
    RAISE EXCEPTION '沒有拆賬權限';
  END IF;

  -- 只還原「還是 settled」的批次，避免蓋掉拆賬後才被手動改動的狀態
  UPDATE procurement_batches b
     SET status = COALESCE(x.prev_status, 'done')
    FROM (SELECT (e->>'id')::bigint AS id, e->>'prev_status' AS prev_status
            FROM jsonb_array_elements(v_batches) e) x
   WHERE b.id = x.id AND b.status = 'settled';

  UPDATE trip_expenses te
     SET settled = false
    FROM (SELECT (e->>'id')::bigint AS id FROM jsonb_array_elements(v_expenses) e) x
   WHERE te.id = x.id AND te.settled = true;

  UPDATE trip_settlements
     SET status = 'void', voided_at = now(), voided_by = auth.uid()
   WHERE id = p_settlement_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.settle_trip(bigint, numeric, numeric, numeric, numeric, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_trip_settlement(bigint) TO authenticated;

COMMIT;
