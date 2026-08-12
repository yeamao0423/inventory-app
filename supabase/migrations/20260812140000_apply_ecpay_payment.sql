-- 綠界收款套用。三個不變量：
-- 1) 不直接寫 payment_status——寫 paid_amount，由 sync_payment_status trigger 推導
-- 2) 冪等——綠界 notify 會重試，result 也做同一件事，同一 trade_no 只能算一次錢
-- 3) 遲到補救——通知晚於棄單清理時要把訂單復活；庫存不足就標警示，不默默吃錢
--
-- 庫存一律交給 reconcile_stock trigger（20260812100000）：這裡只改 status，
-- 佔用量的增減由 trigger 依 stock_committed 差額處理。切勿手寫庫存 UPDATE。

-- ========== 建立 pending 交易 ==========
create or replace function public.create_ecpay_transaction(
  p_order_id bigint, p_trade_no text, p_amount numeric
) returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare v_store_id bigint;
begin
  select store_id into v_store_id from public.consumer_orders where id = p_order_id;
  if v_store_id is null then
    return jsonb_build_object('ok', false, 'error', '訂單不存在');
  end if;

  insert into public.ecpay_transactions (order_id, store_id, trade_no, amount, status)
  values (p_order_id, v_store_id, p_trade_no, p_amount, 'pending')
  on conflict (trade_no) do nothing;

  return jsonb_build_object('ok', true, 'trade_no', p_trade_no);
end $$;

-- ========== 套用付款結果 ==========
create or replace function public.apply_ecpay_payment(
  p_trade_no text, p_rtn_code text, p_payment_type text default null
) returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_txn   record;
  v_order record;
  v_alert text := null;
begin
  select * into v_txn from public.ecpay_transactions
    where trade_no = p_trade_no for update;
  if v_txn is null then
    return jsonb_build_object('ok', false, 'error', '未知的交易編號');
  end if;

  -- 冪等：已處理過就直接回報
  if v_txn.status = 'paid' then
    return jsonb_build_object('ok', true, 'already', true, 'order_id', v_txn.order_id);
  end if;

  -- 付款失敗：標記後結束，不動訂單金額
  if p_rtn_code is distinct from '1' then
    update public.ecpay_transactions set status = 'failed' where id = v_txn.id;
    return jsonb_build_object('ok', true, 'already', false, 'paid', false,
                              'order_id', v_txn.order_id);
  end if;

  select * into v_order from public.consumer_orders where id = v_txn.order_id for update;
  if v_order is null then
    return jsonb_build_object('ok', false, 'error', '訂單不存在');
  end if;

  -- 遲到補救：通知晚於棄單清理，訂單已被取消、庫存也已回補。
  -- 把狀態改回處理中即可——reconcile_stock trigger 會重新佔用庫存，
  -- 現貨不足時它自己會 raise，這裡接住並改標警示，絕不默默把錢吃掉。
  if v_order.status = '已取消' then
    begin
      update public.consumer_orders set status = '處理中' where id = v_order.id;
    exception when others then
      v_alert := '已收款但庫存不足，訂單先前已被當棄單取消，請人工確認出貨或退款（'
                 || sqlerrm || '）';
    end;
  end if;

  -- 記帳：只動 paid_amount 與 payment_alert，不碰 status/items_json，
  -- 因此不會再次觸發 reconcile_stock（它只監看那兩欄）。
  update public.consumer_orders
    set paid_amount   = coalesce(paid_amount, 0) + v_txn.amount,
        payment_alert = coalesce(v_alert, payment_alert)
    where id = v_order.id;

  update public.ecpay_transactions
    set status = 'paid', paid_at = now(), payment_type = p_payment_type
    where id = v_txn.id;

  return jsonb_build_object('ok', true, 'already', false, 'paid', true,
                            'order_id', v_order.id, 'alert', v_alert);
end $$;

-- ========== 貨到付款：取件完成＝綠界代收完成 ==========
create or replace function public.apply_cod_payment(p_order_id bigint)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare v_order record;
begin
  select * into v_order from public.consumer_orders where id = p_order_id for update;
  if v_order is null then
    return jsonb_build_object('ok', false, 'error', '訂單不存在');
  end if;

  -- 冪等：已收滿就不再加
  if coalesce(v_order.paid_amount, 0) >= coalesce(v_order.total_amount, 0) then
    return jsonb_build_object('ok', true, 'already', true);
  end if;

  update public.consumer_orders
    set paid_amount = coalesce(total_amount, 0)
    where id = p_order_id;

  return jsonb_build_object('ok', true, 'already', false);
end $$;

-- 權限：這三支只由商城 API route（service role）呼叫，不開給 anon/authenticated
revoke all on function public.create_ecpay_transaction(bigint, text, numeric) from public, anon, authenticated;
revoke all on function public.apply_ecpay_payment(text, text, text) from public, anon, authenticated;
revoke all on function public.apply_cod_payment(bigint) from public, anon, authenticated;
