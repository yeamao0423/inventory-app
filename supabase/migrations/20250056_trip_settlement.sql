-- ══════════════════════════════════════════════
-- 行程拆賬
--
-- 拆賬邏輯（老闆定義）：
--   1. 淨利 = 訂單營收 − 商品成本 − 行程費用   ← 沿用行程報表現有口徑
--   2. A（分潤）= 淨利 × 該員工比例
--   3. 該員工實拿 = A + 他在本趟批次的未結清代墊金額
--   拆賬送出時，把掛在此行程底下的批次一次全部標記 settled。
--
-- 金額一律存快照：日後改商品成本、改比例都不會回頭動到歷史拆賬單。
-- ══════════════════════════════════════════════

BEGIN;

-- ── 1. 行程參與者與分潤比例 ──────────────────────────────
-- 比例合計不必等於 100%，沒分配到的部分視為店家保留。
CREATE TABLE IF NOT EXISTS trip_participants (
  id         bigserial PRIMARY KEY,
  trip_id    bigint NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id    uuid   NOT NULL REFERENCES profiles(id),
  share_pct  numeric(6,3) NOT NULL DEFAULT 0,
  note       text,
  created_at timestamptz DEFAULT now(),
  UNIQUE (trip_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_trip_participants_trip ON trip_participants(trip_id);

-- ── 2. 拆賬紀錄 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trip_settlements (
  id              bigserial PRIMARY KEY,
  trip_id         bigint NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  settled_at      timestamptz NOT NULL DEFAULT now(),
  settled_by      uuid REFERENCES profiles(id),
  -- 當下的財務快照
  revenue         numeric(12,2) NOT NULL DEFAULT 0,
  product_cost    numeric(12,2) NOT NULL DEFAULT 0,
  trip_expense    numeric(12,2) NOT NULL DEFAULT 0,
  net_profit      numeric(12,2) NOT NULL DEFAULT 0,
  total_payout    numeric(12,2) NOT NULL DEFAULT 0,
  -- 本次結清了哪些批次、結清前的狀態為何（作廢時原樣還原）
  settled_batches jsonb NOT NULL DEFAULT '[]',
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
  note            text,
  voided_at       timestamptz,
  voided_by       uuid REFERENCES profiles(id)
);

-- 一趟行程同時間只能有一張生效中的拆賬單
CREATE UNIQUE INDEX IF NOT EXISTS trip_settlements_one_active
  ON trip_settlements(trip_id) WHERE status = 'active';

-- ── 3. 拆賬明細（一人一列）──────────────────────────────
CREATE TABLE IF NOT EXISTS trip_settlement_lines (
  id            bigserial PRIMARY KEY,
  settlement_id bigint NOT NULL REFERENCES trip_settlements(id) ON DELETE CASCADE,
  user_id       uuid REFERENCES profiles(id),
  user_name     text,                                  -- 名字快照，成員改名或離開也看得懂
  share_pct     numeric(6,3)  NOT NULL DEFAULT 0,
  profit_share  numeric(12,2) NOT NULL DEFAULT 0,      -- A = 淨利 × 比例
  reimbursement numeric(12,2) NOT NULL DEFAULT 0,      -- 代墊返還
  payout        numeric(12,2) NOT NULL DEFAULT 0,      -- 實拿 = A + 代墊
  paid          boolean NOT NULL DEFAULT false,        -- 錢發出去了沒
  created_at    timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trip_settlement_lines_settlement
  ON trip_settlement_lines(settlement_id);

-- ── 4. RLS：跟 trips 一樣，店主限定（拆賬金額敏感）─────────
ALTER TABLE trip_participants      ENABLE ROW LEVEL SECURITY;
ALTER TABLE trip_settlements       ENABLE ROW LEVEL SECURITY;
ALTER TABLE trip_settlement_lines  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner manage trip_participants" ON trip_participants;
CREATE POLICY "owner manage trip_participants" ON trip_participants
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM trips t WHERE t.id = trip_id
                 AND has_store_role(t.store_id, ARRAY['super_admin'])))
  WITH CHECK (EXISTS (SELECT 1 FROM trips t WHERE t.id = trip_id
                 AND has_store_role(t.store_id, ARRAY['super_admin'])));

DROP POLICY IF EXISTS "owner manage trip_settlements" ON trip_settlements;
CREATE POLICY "owner manage trip_settlements" ON trip_settlements
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM trips t WHERE t.id = trip_id
                 AND has_store_role(t.store_id, ARRAY['super_admin'])))
  WITH CHECK (EXISTS (SELECT 1 FROM trips t WHERE t.id = trip_id
                 AND has_store_role(t.store_id, ARRAY['super_admin'])));

DROP POLICY IF EXISTS "owner manage trip_settlement_lines" ON trip_settlement_lines;
CREATE POLICY "owner manage trip_settlement_lines" ON trip_settlement_lines
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM trip_settlements s JOIN trips t ON t.id = s.trip_id
                 WHERE s.id = settlement_id AND has_store_role(t.store_id, ARRAY['super_admin'])))
  WITH CHECK (EXISTS (SELECT 1 FROM trip_settlements s JOIN trips t ON t.id = s.trip_id
                 WHERE s.id = settlement_id AND has_store_role(t.store_id, ARRAY['super_admin'])));

-- ── 5. settle_trip：拆賬 + 一次結清本趟批次（單一 transaction）──
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

  SELECT COALESCE(SUM((l->>'payout')::numeric), 0) INTO v_total
    FROM jsonb_array_elements(p_lines) l;

  INSERT INTO trip_settlements (
    trip_id, settled_by, revenue, product_cost, trip_expense,
    net_profit, total_payout, settled_batches, note
  ) VALUES (
    p_trip_id, auth.uid(), p_revenue, p_product_cost, p_trip_expense,
    p_net_profit, v_total, v_batches, p_note
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

  RETURN v_settlement_id;
END;
$$;

-- ── 6. void_trip_settlement：作廢重算，批次退回原狀態 ──────
CREATE OR REPLACE FUNCTION public.void_trip_settlement(p_settlement_id bigint)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_store_id bigint;
  v_batches  jsonb;
BEGIN
  SELECT t.store_id, s.settled_batches
    INTO v_store_id, v_batches
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

  UPDATE trip_settlements
     SET status = 'void', voided_at = now(), voided_by = auth.uid()
   WHERE id = p_settlement_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.settle_trip(bigint, numeric, numeric, numeric, numeric, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_trip_settlement(bigint) TO authenticated;

COMMIT;
