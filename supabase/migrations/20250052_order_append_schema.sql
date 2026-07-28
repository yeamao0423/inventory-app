-- ══════════════════════════════════════════════
-- 訂單加購（併單）— Schema
--
-- 核心：把「付款」與「加購」拆成兩條互不引用的線
--   加購窗口 = append_deadline（時間）+ status（狀態煞車）
--   付款狀態 = paid_amount 對 total_amount 推導而來
--
-- 拆開之後「已付款的訂單也能加購，加購後自動轉為待補款」才成立——
-- 這是舊設計做不到的，因為 payment_status 是人工標記，與金額無因果關係。
-- ══════════════════════════════════════════════

BEGIN;

-- ── 1. consumer_orders 擴充 ──────────────────────────────

ALTER TABLE public.consumer_orders
  ADD COLUMN IF NOT EXISTS append_deadline timestamptz,
  ADD COLUMN IF NOT EXISTS paid_amount numeric(10,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.consumer_orders.append_deadline IS
  '加購截止時間。下單當下依 stores.settings 快照，NULL = 不開放加購';
COMMENT ON COLUMN public.consumer_orders.paid_amount IS
  '已收金額，由 order_payments 加總自動維護，勿手動寫入';

-- ── 2. 收付款明細 ────────────────────────────────────────
-- 一筆匯款一列，退款記負數。
-- 舊設計只有 remittance_last5 一個欄位（那是匯款人帳號末五碼，不是金額），
-- 補匯差額、訂金、部分退款都無處可放。

CREATE TABLE IF NOT EXISTS public.order_payments (
    id          bigserial PRIMARY KEY,
    store_id    bigint NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
    order_id    bigint NOT NULL REFERENCES public.consumer_orders(id) ON DELETE CASCADE,
    amount      numeric(10,2) NOT NULL,                    -- 正 = 收款、負 = 退款
    method      text NOT NULL DEFAULT 'remittance',        -- remittance / ecpay / cash / migration / other
    note        text,
    created_by  uuid REFERENCES public.profiles(id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT order_payments_amount_nonzero CHECK (amount <> 0)
);

CREATE INDEX IF NOT EXISTS order_payments_order_idx ON public.order_payments(order_id);
CREATE INDEX IF NOT EXISTS order_payments_store_idx ON public.order_payments(store_id, created_at DESC);

-- ── 3. payment_status 由金額推導 ─────────────────────────

CREATE OR REPLACE FUNCTION public.derive_payment_status(p_paid numeric, p_total numeric)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN COALESCE(p_paid, 0) <= 0                    THEN '未付'
    WHEN COALESCE(p_paid, 0) <  COALESCE(p_total, 0) THEN '部分付款'
    WHEN COALESCE(p_paid, 0) =  COALESCE(p_total, 0) THEN '已付清'
    ELSE '待退款'
  END;
$$;

CREATE OR REPLACE FUNCTION public.sync_payment_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.payment_status := public.derive_payment_status(NEW.paid_amount, NEW.total_amount);
  RETURN NEW;
END;
$$;

-- 刻意對「所有 UPDATE」觸發，而不只針對金額欄位：
-- 舊程式碼會直接寫 payment_status，這裡一律覆蓋成推導值，避免兩個真相來源。
DROP TRIGGER IF EXISTS consumer_orders_payment_status ON public.consumer_orders;
CREATE TRIGGER consumer_orders_payment_status
  BEFORE INSERT OR UPDATE ON public.consumer_orders
  FOR EACH ROW EXECUTE FUNCTION public.sync_payment_status();

-- ── 4. order_payments 加總回寫 paid_amount ───────────────

CREATE OR REPLACE FUNCTION public.sync_order_paid_amount()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_order_id bigint := COALESCE(NEW.order_id, OLD.order_id);
BEGIN
  UPDATE public.consumer_orders o
     SET paid_amount = COALESCE(
           (SELECT SUM(p.amount) FROM public.order_payments p WHERE p.order_id = v_order_id),
           0)
   WHERE o.id = v_order_id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS order_payments_sync ON public.order_payments;
CREATE TRIGGER order_payments_sync
  AFTER INSERT OR UPDATE OR DELETE ON public.order_payments
  FOR EACH ROW EXECUTE FUNCTION public.sync_order_paid_amount();

-- ── 5. Backfill ──────────────────────────────────────────
-- 舊的「已付清」必須轉成一筆真實的 order_payments，
-- 否則之後補登任何一筆收款，加總會把原本收到的錢洗掉。

INSERT INTO public.order_payments (store_id, order_id, amount, method, note, created_at)
SELECT o.store_id, o.id, o.total_amount, 'migration',
       '資料轉換：原訂單標記為已付清', COALESCE(o.updated_at, o.created_at)
  FROM public.consumer_orders o
 WHERE o.payment_status = '已付清'
   AND COALESCE(o.total_amount, 0) > 0
   AND NOT EXISTS (SELECT 1 FROM public.order_payments p WHERE p.order_id = o.id);

-- 全表對齊：觸發 BEFORE UPDATE trigger，把 payment_status 重算成推導值
UPDATE public.consumer_orders o
   SET paid_amount = COALESCE(
         (SELECT SUM(p.amount) FROM public.order_payments p WHERE p.order_id = o.id),
         0);

-- ── 6. RLS ───────────────────────────────────────────────
-- 消費者不直讀這張表，金額彙總透過 get_consumer_order 回傳。

ALTER TABLE public.order_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "members read order_payments" ON public.order_payments;
CREATE POLICY "members read order_payments" ON public.order_payments
  FOR SELECT USING (public.is_store_member(store_id));

DROP POLICY IF EXISTS "editors write order_payments" ON public.order_payments;
CREATE POLICY "editors write order_payments" ON public.order_payments
  FOR ALL
  USING      (public.has_store_role(store_id, ARRAY['super_admin','admin','editor']))
  WITH CHECK (public.has_store_role(store_id, ARRAY['super_admin','admin','editor']));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.order_payments TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.order_payments_id_seq TO authenticated;

COMMIT;
