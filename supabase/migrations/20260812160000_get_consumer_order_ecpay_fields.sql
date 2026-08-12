-- get_consumer_order 補綠界欄位，讓訂單頁（消費者持不可猜 public_token 查詢）
-- 能顯示付款方式／超商門市／物流狀態。
--
-- 整支重貼（本 repo 慣例），只在 jsonb_build_object 追加以下七欄，其餘邏輯一字不動：
--   payment_method / shipping_subtype / cvs_store_id / cvs_store_name / cvs_address
--   / logistics_status_msg / logistics_status_at
--
-- 刻意不加的欄位（這支 RPC 吐給匿名訪客，不是店家後台）：
--   payment_alert      — 給店家看的內部處理備註（例如已收款但庫存不足待人工確認），
--                         消費者看到只會造成恐慌與客訴。
--   cvs_payment_no / cvs_validation_no — 超商寄貨用的寄件編號與驗證碼，外流等於
--                         任何人都能冒領/冒寄這張貨。
--   ecpay_transactions 的任何欄位 — 該表本來就對 anon/authenticated 零 policy，
--                         這裡也不該繞過去挖它的內容出來。

BEGIN;

CREATE OR REPLACE FUNCTION public.get_consumer_order(p_token uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT jsonb_build_object(
    'id', co.id,
    'store_order_no', co.store_order_no,
    'email', co.email,
    'remittance_last5', co.remittance_last5,
    'items', co.items,
    'items_json', co.items_json,
    'total_amount', co.total_amount,
    'discount_amount', co.discount_amount,
    'shipping_fee', co.shipping_fee,
    'status', co.status,
    'payment_status', co.payment_status,
    'paid_amount', co.paid_amount,
    'balance_due', COALESCE(co.total_amount, 0) - COALESCE(co.paid_amount, 0),
    'append_deadline', co.append_deadline,
    'can_append', (
      co.status IN ('待確認', '處理中')
      AND co.append_deadline IS NOT NULL
      AND now() < co.append_deadline
    ),
    'payment_method', co.payment_method,
    'shipping_subtype', co.shipping_subtype,
    'cvs_store_id', co.cvs_store_id,
    'cvs_store_name', co.cvs_store_name,
    'cvs_address', co.cvs_address,
    'logistics_status_msg', co.logistics_status_msg,
    'logistics_status_at', co.logistics_status_at
  )
  FROM consumer_orders co WHERE co.public_token = p_token
$$;

REVOKE ALL ON FUNCTION public.get_consumer_order(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_consumer_order(uuid) TO anon, authenticated;

COMMIT;
