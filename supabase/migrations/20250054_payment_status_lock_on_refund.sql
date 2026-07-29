-- ══════════════════════════════════════════════
-- 已付清訂單退款不自動退回部分付款
--
-- derive_payment_status 是純函式，退款（paid_amount 變小）跟加購
-- （total_amount 變大）都會讓 paid < total，之前一律推導成「部分付款」。
-- 但退款是店家主動退錢給消費者，不代表消費者還欠錢；只有加購才是
-- 真的欠款。所以已付清的訂單如果只是退款（total 沒變），狀態要鎖住
-- 不動；一旦 total 真的增加（加購），才照舊自動落到部分付款。
-- ══════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.sync_payment_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.payment_status = '已付清'
     AND NEW.total_amount = OLD.total_amount
     AND NEW.paid_amount < OLD.paid_amount THEN
    NEW.payment_status := '已付清';
  ELSE
    NEW.payment_status := public.derive_payment_status(NEW.paid_amount, NEW.total_amount);
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
