-- ============================================
-- Migration: 消費者分級（會員等級）+ 外部平台會員匯入
-- 模型 A 雙表（見 docs/member-tiers-plan.md §13）：
--   擴充 store_consumers（已註冊會員）+ 新增 imported_members（外部平台原始名單）
--   member_levels：per-store 等級定義
-- 純加法，不 DROP store_consumers。僅先套 local，測試過才上 remote。
-- 前置：20250018~20250021
-- ============================================

-- ========== 0) normalize_email（匯入、比對、索引統一用，#8/#12）==========
CREATE OR REPLACE FUNCTION public.normalize_email(p_email text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(trim(p_email));
$$;

-- ========== 1) member_levels ==========
CREATE TABLE IF NOT EXISTS public.member_levels (
  id bigserial PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  name text NOT NULL,
  sort_order int NOT NULL DEFAULT 0,            -- 數字越大等級越高
  threshold_amount numeric NOT NULL DEFAULT 0,  -- 達標累積消費額
  threshold_orders int NOT NULL DEFAULT 0,      -- （選用）達標訂單數
  discount_percent numeric,                     -- （選用）等級折扣，v1 僅後台維護
  is_default boolean NOT NULL DEFAULT false,    -- 新會員 / 找不到對應時的預設等級
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (store_id, name)
);
-- 每店僅一個預設等級（#6）
CREATE UNIQUE INDEX IF NOT EXISTS member_levels_one_default_per_store
  ON public.member_levels (store_id) WHERE is_default;
CREATE INDEX IF NOT EXISTS member_levels_store_idx ON public.member_levels (store_id);

DROP TRIGGER IF EXISTS member_levels_updated_at ON public.member_levels;
CREATE TRIGGER member_levels_updated_at BEFORE UPDATE ON public.member_levels
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ========== 2) 擴充 store_consumers（已註冊會員）==========
ALTER TABLE public.store_consumers
  ADD COLUMN IF NOT EXISTS member_level_id bigint REFERENCES public.member_levels(id) ON DELETE RESTRICT,  -- #7
  ADD COLUMN IF NOT EXISTS level_locked    boolean NOT NULL DEFAULT false,   -- 手動升級鎖定
  ADD COLUMN IF NOT EXISTS registered_at   timestamptz,                      -- 升等時間基準
  ADD COLUMN IF NOT EXISTS imported_amount numeric NOT NULL DEFAULT 0,       -- 晉升時自匯入名單帶入
  ADD COLUMN IF NOT EXISTS imported_orders int     NOT NULL DEFAULT 0;

-- 舊 member_level(text) 在 local 全為 NULL；無資料可映射，移除舊欄
ALTER TABLE public.store_consumers DROP COLUMN IF EXISTS member_level;

-- ========== 3) imported_members（外部平台原始名單，多平台通用）==========
CREATE TABLE IF NOT EXISTS public.imported_members (
  id bigserial PRIMARY KEY,
  store_id bigint NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  source text NOT NULL,                 -- 'shopline' | 'shopee' | ...
  external_id text,                     -- 平台會員 ID（Shopline 顧客 ID）
  email text NOT NULL,                  -- 一律 normalize_email 後存
  name text,
  phone text,
  registered_at timestamptz,            -- Shopline 加入日期
  imported_amount numeric NOT NULL DEFAULT 0,
  imported_orders int NOT NULL DEFAULT 0,
  accepts_marketing boolean,
  manual_level_id bigint REFERENCES public.member_levels(id) ON DELETE RESTRICT, -- 未註冊者手動指定
  promoted_consumer_id uuid REFERENCES public.consumers(id) ON DELETE SET NULL,  -- 晉升後標記
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (store_id, source, external_id)
);
CREATE INDEX IF NOT EXISTS imported_members_email_idx
  ON public.imported_members (store_id, public.normalize_email(email));

DROP TRIGGER IF EXISTS imported_members_updated_at ON public.imported_members;
CREATE TRIGGER imported_members_updated_at BEFORE UPDATE ON public.imported_members
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ========== 4) consumer_orders 合格額查詢索引（#11/#12，表達式與 helper 一致）==========
CREATE INDEX IF NOT EXISTS consumer_orders_store_email_paid_idx
  ON public.consumer_orders (store_id, public.normalize_email(email))
  WHERE payment_status = '已付清';

-- ========== 5) 共用 helper（D4）==========
-- 合格額/合格訂單數：起始額(imported) + 我們商城已付清、註冊後的訂單（扣運費，D2）
CREATE OR REPLACE FUNCTION public.member_qualifying(
  p_store_id bigint,
  p_email text,
  p_registered_at timestamptz,
  p_base_amount numeric DEFAULT 0,
  p_base_orders int DEFAULT 0
)
RETURNS TABLE (amount numeric, orders int)
LANGUAGE sql STABLE AS $$
  SELECT
    p_base_amount + COALESCE(SUM(co.total_amount - COALESCE(co.shipping_fee, 0)), 0),
    p_base_orders + COALESCE(COUNT(*), 0)::int
  FROM public.consumer_orders co
  WHERE co.store_id = p_store_id
    AND public.normalize_email(co.email) = public.normalize_email(p_email)
    AND co.payment_status = '已付清'
    AND (p_registered_at IS NULL OR co.created_at >= p_registered_at);
$$;

-- 選等級：符合門檻者取 sort_order 最大；皆不符回 NULL（呼叫端 fallback 預設）
CREATE OR REPLACE FUNCTION public.member_pick_level(
  p_store_id bigint, p_amount numeric, p_orders int
)
RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT id FROM public.member_levels
  WHERE store_id = p_store_id
    AND threshold_amount <= p_amount
    AND threshold_orders <= p_orders
  ORDER BY sort_order DESC, threshold_amount DESC, threshold_orders DESC, id DESC
  LIMIT 1;
$$;

-- ========== 6) recalc_member_level（單筆/整店，set-based，尊重 level_locked，#12）==========
CREATE OR REPLACE FUNCTION public.recalc_member_level(
  p_store_id bigint, p_email text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.store_consumers sc
  SET member_level_id = COALESCE(
        (SELECT public.member_pick_level(sc.store_id, mq.amount, mq.orders)
         FROM public.member_qualifying(sc.store_id, c.email, sc.registered_at,
                                       sc.imported_amount, sc.imported_orders) mq),
        (SELECT id FROM public.member_levels ml WHERE ml.store_id = sc.store_id AND ml.is_default LIMIT 1)
      )
  FROM public.consumers c
  WHERE sc.consumer_id = c.id
    AND sc.store_id = p_store_id
    AND sc.level_locked = false
    AND (p_email IS NULL OR public.normalize_email(c.email) = public.normalize_email(p_email));
END;
$$;

-- ========== 7) recalc trigger（AFTER，窄 WHEN，容錯不擋付款，D1/#4）==========
CREATE OR REPLACE FUNCTION public.recalc_member_level_trg()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    PERFORM public.recalc_member_level(NEW.store_id, NEW.email);
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- 等級為附屬計算，絕不可讓「標記已付清」rollback
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_recalc_member_level_upd ON public.consumer_orders;
CREATE TRIGGER trg_recalc_member_level_upd
  AFTER UPDATE ON public.consumer_orders
  FOR EACH ROW
  WHEN (NEW.payment_status = '已付清' AND OLD.payment_status IS DISTINCT FROM '已付清')
  EXECUTE FUNCTION public.recalc_member_level_trg();

DROP TRIGGER IF EXISTS trg_recalc_member_level_ins ON public.consumer_orders;
CREATE TRIGGER trg_recalc_member_level_ins
  AFTER INSERT ON public.consumer_orders
  FOR EACH ROW
  WHEN (NEW.payment_status = '已付清')
  EXECUTE FUNCTION public.recalc_member_level_trg();

-- ========== 8) import_members（admin only，內查角色，#13；冪等，#10）==========
CREATE OR REPLACE FUNCTION public.import_members(p_store_id bigint, p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count int := 0;
BEGIN
  IF NOT public.has_store_role(p_store_id, ARRAY['super_admin','admin']) THEN
    RAISE EXCEPTION '無權限匯入此店會員';
  END IF;

  INSERT INTO public.imported_members (
    store_id, source, external_id, email, name, phone,
    registered_at, imported_amount, imported_orders, accepts_marketing
  )
  SELECT
    p_store_id,
    COALESCE(r->>'source', 'shopline'),
    r->>'external_id',
    public.normalize_email(r->>'email'),
    NULLIF(r->>'name', ''),
    NULLIF(r->>'phone', ''),
    (r->>'registered_at')::timestamptz,
    COALESCE((r->>'imported_amount')::numeric, 0),
    COALESCE((r->>'imported_orders')::int, 0),
    CASE WHEN r->>'accepts_marketing' IS NULL THEN NULL
         ELSE (r->>'accepts_marketing')::boolean END
  FROM jsonb_array_elements(p_rows) AS r
  WHERE r->>'email' IS NOT NULL AND trim(r->>'email') <> ''
  ON CONFLICT (store_id, source, external_id) DO UPDATE SET
    email = EXCLUDED.email,
    name = EXCLUDED.name,
    phone = EXCLUDED.phone,
    imported_amount = EXCLUDED.imported_amount,
    imported_orders = EXCLUDED.imported_orders,
    accepts_marketing = EXCLUDED.accepts_marketing,
    registered_at = COALESCE(public.imported_members.registered_at, EXCLUDED.registered_at), -- 不重置
    updated_at = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'processed', v_count);
END;
$$;

-- ========== 9) promote_member（登入時 email 相符 → 晉升進 store_consumers，#1/#8/#11）==========
CREATE OR REPLACE FUNCTION public.promote_member(p_store_id bigint)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_email text;
  v_im record;
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;  -- #11

  SELECT public.normalize_email(email) INTO v_email FROM public.consumers WHERE id = v_uid;
  IF v_email IS NULL THEN
    v_email := public.normalize_email(auth.jwt() ->> 'email');
  END IF;
  IF v_email IS NULL THEN RETURN; END IF;

  -- 確保此店有一筆 store_consumers（首次到訪）
  INSERT INTO public.store_consumers (store_id, consumer_id, registered_at)
  SELECT p_store_id, v_uid, (SELECT created_at FROM public.consumers WHERE id = v_uid)
  ON CONFLICT (store_id, consumer_id) DO NOTHING;

  -- 合併尚未晉升的匯入名單（#8 在此單點處理）
  FOR v_im IN
    SELECT * FROM public.imported_members
    WHERE store_id = p_store_id
      AND public.normalize_email(email) = v_email
      AND promoted_consumer_id IS NULL
  LOOP
    UPDATE public.store_consumers sc
    SET registered_at  = LEAST(COALESCE(sc.registered_at, v_im.registered_at),
                               COALESCE(v_im.registered_at, sc.registered_at)),
        imported_amount = sc.imported_amount + v_im.imported_amount,
        imported_orders = sc.imported_orders + v_im.imported_orders,
        member_level_id = COALESCE(sc.member_level_id, v_im.manual_level_id)
    WHERE sc.store_id = p_store_id AND sc.consumer_id = v_uid;

    UPDATE public.imported_members
    SET promoted_consumer_id = v_uid, updated_at = now()
    WHERE id = v_im.id;
  END LOOP;

  PERFORM public.recalc_member_level(p_store_id, v_email);
END;
$$;

-- ========== 10) set_member_level（手動升級，admin only）==========
CREATE OR REPLACE FUNCTION public.set_member_level(
  p_store_id bigint,
  p_level_id bigint,
  p_consumer_id uuid DEFAULT NULL,
  p_imported_id bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_store_role(p_store_id, ARRAY['super_admin','admin']) THEN
    RAISE EXCEPTION '無權限調整此店會員等級';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.member_levels WHERE id = p_level_id AND store_id = p_store_id) THEN
    RAISE EXCEPTION '等級不存在或不屬於本店';
  END IF;

  IF p_consumer_id IS NOT NULL THEN
    UPDATE public.store_consumers
    SET member_level_id = p_level_id, level_locked = true
    WHERE store_id = p_store_id AND consumer_id = p_consumer_id;
  ELSIF p_imported_id IS NOT NULL THEN
    UPDATE public.imported_members
    SET manual_level_id = p_level_id, updated_at = now()
    WHERE id = p_imported_id AND store_id = p_store_id;
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ========== 11) get_my_membership（消費者端，只讀 store_consumers，#1/#2/#11）==========
CREATE OR REPLACE FUNCTION public.get_my_membership(p_store_id bigint)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_sc record;
  v_email text;
  v_amount numeric; v_orders int;
  v_level record;
  v_next record;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('joined', false); END IF;

  SELECT * INTO v_sc FROM public.store_consumers
  WHERE store_id = p_store_id AND consumer_id = v_uid;
  IF v_sc IS NULL THEN RETURN jsonb_build_object('joined', false); END IF;

  SELECT public.normalize_email(email) INTO v_email FROM public.consumers WHERE id = v_uid;
  SELECT amount, orders INTO v_amount, v_orders
  FROM public.member_qualifying(p_store_id, v_email, v_sc.registered_at,
                                v_sc.imported_amount, v_sc.imported_orders);

  SELECT * INTO v_level FROM public.member_levels WHERE id = v_sc.member_level_id;
  IF v_level IS NULL THEN
    SELECT * INTO v_level FROM public.member_levels
    WHERE store_id = p_store_id AND is_default LIMIT 1;
  END IF;

  SELECT * INTO v_next FROM public.member_levels
  WHERE store_id = p_store_id AND sort_order > COALESCE(v_level.sort_order, -1)
  ORDER BY sort_order ASC LIMIT 1;

  RETURN jsonb_build_object(
    'joined', true,
    'level_name', v_level.name,
    'level_sort', v_level.sort_order,
    'discount_percent', v_level.discount_percent,
    'qualifying_amount', v_amount,
    'qualifying_orders', v_orders,
    'next_level_name', v_next.name,
    'next_threshold_amount', v_next.threshold_amount,
    'amount_to_next', CASE WHEN v_next.id IS NOT NULL
                           THEN GREATEST(v_next.threshold_amount - v_amount, 0) END
  );
END;
$$;

-- ========== 12) list_members（後台列表，DEFINER + 角色檢查，union 已註冊＋匯入）==========
CREATE OR REPLACE FUNCTION public.list_members(p_store_id bigint)
RETURNS TABLE (
  kind text, ref_id text, email text, name text, phone text, source text,
  registered_at timestamptz, level_locked boolean,
  level_id bigint, level_name text,
  qualifying_amount numeric, qualifying_orders int
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_store_member(p_store_id) THEN
    RAISE EXCEPTION '無權限';
  END IF;

  RETURN QUERY
  SELECT 'registered'::text, sc.consumer_id::text, c.email, c.name, c.phone, 'native'::text,
         sc.registered_at, sc.level_locked,
         lvl.id, lvl.name, q.amount, q.orders
  FROM public.store_consumers sc
  JOIN public.consumers c ON c.id = sc.consumer_id
  CROSS JOIN LATERAL public.member_qualifying(p_store_id, c.email, sc.registered_at,
                                              sc.imported_amount, sc.imported_orders) q
  LEFT JOIN public.member_levels lvl
    ON lvl.id = COALESCE(sc.member_level_id,
         (SELECT id FROM public.member_levels WHERE store_id = p_store_id AND is_default LIMIT 1))
  WHERE sc.store_id = p_store_id

  UNION ALL

  SELECT 'imported'::text, im.id::text, im.email, im.name, im.phone, im.source,
         im.registered_at, false,
         lvl2.id, lvl2.name, im.imported_amount, im.imported_orders
  FROM public.imported_members im
  LEFT JOIN LATERAL (
    SELECT COALESCE(im.manual_level_id,
                    public.member_pick_level(p_store_id, im.imported_amount, im.imported_orders),
                    (SELECT id FROM public.member_levels WHERE store_id = p_store_id AND is_default LIMIT 1)) AS lid
  ) pick ON true
  LEFT JOIN public.member_levels lvl2 ON lvl2.id = pick.lid
  WHERE im.store_id = p_store_id AND im.promoted_consumer_id IS NULL

  ORDER BY 11 DESC NULLS LAST;
END;
$$;

-- ========== 13) RLS ==========
ALTER TABLE public.member_levels ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "staff read member_levels" ON public.member_levels;
CREATE POLICY "staff read member_levels" ON public.member_levels
  FOR SELECT TO authenticated USING (public.is_store_member(store_id));
DROP POLICY IF EXISTS "admin write member_levels" ON public.member_levels;
CREATE POLICY "admin write member_levels" ON public.member_levels
  FOR ALL TO authenticated
  USING (public.has_store_role(store_id, ARRAY['super_admin','admin']))
  WITH CHECK (public.has_store_role(store_id, ARRAY['super_admin','admin']));

ALTER TABLE public.imported_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "staff read imported_members" ON public.imported_members;
CREATE POLICY "staff read imported_members" ON public.imported_members
  FOR SELECT TO authenticated USING (public.is_store_member(store_id));
-- 寫入一律走 import_members / set_member_level RPC（DEFINER），不開放 client 直接寫

-- ========== 14) Grants ==========
GRANT SELECT, INSERT, UPDATE, DELETE ON public.member_levels TO authenticated;
GRANT USAGE ON SEQUENCE public.member_levels_id_seq TO authenticated;
GRANT SELECT ON public.imported_members TO authenticated;

GRANT EXECUTE ON FUNCTION public.normalize_email(text) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.member_qualifying(bigint,text,timestamptz,numeric,int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.member_pick_level(bigint,numeric,int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.recalc_member_level(bigint,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.import_members(bigint,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.promote_member(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_member_level(bigint,bigint,uuid,bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_membership(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_members(bigint) TO authenticated;

-- ========== 15) Seed + 回填（Daigogo = store 1）==========
-- 預設等級（每店至少一個，#6）
INSERT INTO public.member_levels (store_id, name, sort_order, threshold_amount, threshold_orders, is_default)
SELECT 1, '一般會員', 0, 0, 0, true
WHERE NOT EXISTS (SELECT 1 FROM public.member_levels WHERE store_id = 1);

-- 既有會員 registered_at 回填 = 帳號建立時間
UPDATE public.store_consumers sc
SET registered_at = c.created_at
FROM public.consumers c
WHERE c.id = sc.consumer_id AND sc.registered_at IS NULL;

-- 既有會員套預設等級
UPDATE public.store_consumers
SET member_level_id = (SELECT id FROM public.member_levels WHERE store_id = 1 AND is_default LIMIT 1)
WHERE store_id = 1 AND member_level_id IS NULL AND level_locked = false;

-- ========== 16) 每間店都要有預設等級（現存回填 + 新店自動建，#6）==========
-- 新店建立時自動建一筆預設「一般會員」（不論用平台流程或任何方式建店）
CREATE OR REPLACE FUNCTION public.seed_default_member_level()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.member_levels (store_id, name, sort_order, threshold_amount, threshold_orders, is_default)
  VALUES (NEW.id, '一般會員', 0, 0, 0, true)
  ON CONFLICT (store_id, name) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_seed_default_member_level ON public.stores;
CREATE TRIGGER trg_seed_default_member_level
  AFTER INSERT ON public.stores
  FOR EACH ROW EXECUTE FUNCTION public.seed_default_member_level();

-- 回填：所有目前沒有預設等級的店，補一筆預設「一般會員」
INSERT INTO public.member_levels (store_id, name, sort_order, threshold_amount, threshold_orders, is_default)
SELECT s.id, '一般會員', 0, 0, 0, true
FROM public.stores s
WHERE NOT EXISTS (SELECT 1 FROM public.member_levels ml WHERE ml.store_id = s.id AND ml.is_default)
ON CONFLICT (store_id, name) DO UPDATE SET is_default = true;
