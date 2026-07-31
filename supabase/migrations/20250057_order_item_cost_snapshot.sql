-- ══════════════════════════════════════════════
-- 訂單品項成本快照
--
-- 問題：報表與行程報告的成本都現查 products.cost × 當前匯率。
--       老闆改一次商品成本、或匯率動一下，所有歷史行程的毛利就被
--       回頭改寫，已經拆過的帳也對不上。
--
-- 做法：訂單寫入時把換算後的成本凍結下來。
--
--   刻意用 trigger 而不是改 place_order —— 商城結帳、LINE 下單、
--   後台自建訂單、加購走的是不同路徑，掛在表上才不會漏。
--
--   刻意存在獨立表而不是塞進 items_json —— consumer_orders 的 SELECT
--   policy 允許消費者讀自己的訂單（email 相符），成本寫進 items_json
--   等於讓每個客人看得到自己買的東西進價多少。這張表的 RLS 只放行
--   店家成員。
--
-- 成本軸：product_variants.variant_cost ?? products.cost，乘上寫入
--        當下的匯率。跟 src/lib/orderFinance.js 同一套規則。
--
-- 冪等：同一個 (order_id, item_index) 只要商品沒換過就不重寫，
--      重跑不會覆蓋歷史金額。
-- ══════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS public.consumer_order_item_costs (
  order_id      bigint  NOT NULL REFERENCES public.consumer_orders(id) ON DELETE CASCADE,
  item_index    int     NOT NULL,            -- 對應 items_json 的位置（0-based）
  store_id      bigint  NOT NULL,            -- 冗餘一份，RLS 才不用每次回查訂單
  product_id    bigint,
  variant_id    text,
  unit_cost_twd numeric(12,2) NOT NULL,
  cost_orig     numeric(12,2),
  cost_currency text,
  cost_rate     numeric(12,6),
  created_at    timestamptz DEFAULT now(),
  PRIMARY KEY (order_id, item_index)
);

COMMENT ON TABLE public.consumer_order_item_costs IS
  '訂單品項的進貨成本快照（下單當下凍結），避免日後改成本/匯率回頭改寫歷史毛利';

CREATE INDEX IF NOT EXISTS idx_order_item_costs_store ON public.consumer_order_item_costs(store_id);

-- ── RLS：成本只給店家成員，消費者一律讀不到 ──────────────
ALTER TABLE public.consumer_order_item_costs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "store members read order item costs" ON public.consumer_order_item_costs;
CREATE POLICY "store members read order item costs" ON public.consumer_order_item_costs
  FOR SELECT TO authenticated
  USING (public.has_store_role(store_id, ARRAY['super_admin', 'admin']));

-- 寫入一律走 trigger（SECURITY DEFINER），不開放前端直接寫
REVOKE ALL ON public.consumer_order_item_costs FROM anon;
GRANT SELECT ON public.consumer_order_item_costs TO authenticated;

-- ── 寫入 trigger ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.snapshot_order_item_costs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_item  jsonb;
  v_idx   int;
  v_pid   bigint;
  v_vid   text;
  v_cost  numeric;
  v_cur   text;
  v_rate  numeric;
  v_existing_pid bigint;
  v_has_row      boolean;
BEGIN
  IF NEW.items_json IS NULL OR jsonb_typeof(NEW.items_json) <> 'array' THEN
    RETURN NULL;
  END IF;

  FOR v_item, v_idx IN
    SELECT t.item, (t.ord - 1)::int
      FROM jsonb_array_elements(NEW.items_json) WITH ORDINALITY AS t(item, ord)
  LOOP
    v_pid := NULLIF(v_item->>'id', '')::bigint;
    v_vid := NULLIF(v_item->>'variantId', '');

    SELECT true, c.product_id INTO v_has_row, v_existing_pid
      FROM consumer_order_item_costs c
     WHERE c.order_id = NEW.id AND c.item_index = v_idx;

    -- 已有快照且還是同一個商品 → 不動，歷史成本永不被覆寫。
    -- 商品對不上代表品項被換掉（極少數情況），才重新取當下成本。
    IF COALESCE(v_has_row, false) AND v_existing_pid IS NOT DISTINCT FROM v_pid THEN
      CONTINUE;
    END IF;

    v_cost := NULL; v_cur := NULL; v_rate := NULL;

    -- variantId 用文字比對，規格表主鍵是 bigint 或 uuid 都吃得下
    SELECT COALESCE(pv.variant_cost, p.cost), COALESCE(p.currency, 'TWD'), COALESCE(er.rate, 1)
      INTO v_cost, v_cur, v_rate
      FROM products p
      LEFT JOIN product_variants pv ON pv.id::text = v_vid
      LEFT JOIN exchange_rates er   ON er.currency = p.currency
     WHERE p.id = v_pid;

    -- 商品不存在或成本沒填 → 不硬塞 0，交給前端標示「未設定成本」
    CONTINUE WHEN v_cost IS NULL OR v_cost <= 0;

    INSERT INTO consumer_order_item_costs (
      order_id, item_index, store_id, product_id, variant_id,
      unit_cost_twd, cost_orig, cost_currency, cost_rate
    ) VALUES (
      NEW.id, v_idx, NEW.store_id, v_pid, v_vid,
      ROUND(v_cost * COALESCE(v_rate, 1), 2), v_cost, v_cur, COALESCE(v_rate, 1)
    )
    ON CONFLICT (order_id, item_index) DO UPDATE
      SET store_id      = EXCLUDED.store_id,
          product_id    = EXCLUDED.product_id,
          variant_id    = EXCLUDED.variant_id,
          unit_cost_twd = EXCLUDED.unit_cost_twd,
          cost_orig     = EXCLUDED.cost_orig,
          cost_currency = EXCLUDED.cost_currency,
          cost_rate     = EXCLUDED.cost_rate;
  END LOOP;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.snapshot_order_item_costs() IS
  '訂單寫入時凍結品項進貨成本（TWD）到 consumer_order_item_costs';

DROP TRIGGER IF EXISTS trg_snapshot_order_item_costs ON public.consumer_orders;
CREATE TRIGGER trg_snapshot_order_item_costs
  AFTER INSERT OR UPDATE OF items_json ON public.consumer_orders
  FOR EACH ROW EXECUTE FUNCTION public.snapshot_order_item_costs();

-- ── 既有訂單一次性回填 ────────────────────────────────────
-- 用「現在」的成本與匯率補上快照，從這一刻起歷史數字就凍住了。
-- 空指派 items_json = items_json 就會走上面同一支 trigger，邏輯不會分兩份。
-- 會員等級 trigger 有 WHEN (payment_status 由非已付清變已付清) 的守門，
-- 這裡不會誤觸；付款狀態 trigger 是純推導，重算結果相同。
UPDATE public.consumer_orders
   SET items_json = items_json
 WHERE items_json IS NOT NULL
   AND jsonb_typeof(items_json) = 'array';

COMMIT;
