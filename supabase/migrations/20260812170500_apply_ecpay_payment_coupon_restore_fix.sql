-- N4：優惠券還原不該綁在「通知進來時訂單狀態是已取消」
--
-- apply_ecpay_payment（20260812170100）把還原優惠券的呼叫包在
-- `if v_order.status = '已取消' then ... end if;` 裡面，判準是「這次通知進來
-- 的當下，訂單狀態剛好是已取消」。但棄單清理→退券之後，狀態是可以被人工
-- 改回「處理中」的（例如客人來訊反映已經付款，店員先手動復活訂單）。
-- 之後綠界的遲到通知才進來時，`status <> '已取消'`，整段還原（含把
-- total_amount 調回折扣後金額）被跳過，訂單就會出現「已經收到折扣後金額，
-- 卻顯示還欠折扣額度」的假欠款，而 abandoned_order_coupons 也留下一列永遠
-- 不會被清掉的孤兒快照。
--
-- 修法：把「是否還原優惠券」的判準從「訂單狀態」改成「這張訂單有沒有留下
-- 待還原的優惠券快照」——即 abandoned_order_coupons 是否有對應的行。
-- restore_abandoned_order_coupon 本身已經對「找不到快照」「訂單已掛著別的
-- 券」都做了早退並回報 restored:false，重複呼叫是安全的，所以把它移到
-- if 區塊外面、對所有進來的通知都跑一次，不會影響本來就沒有快照的正常訂單。
-- 「訂單復活」（把 status 改回處理中、佔用庫存）維持只在 status='已取消'
-- 時才做——快照存在不代表訂單目前是已取消狀態，復活與否仍然要看狀態。
--
-- 整支重貼自 20260812170100（同一組參數），I3 溢收守衛與 I4 例外收斂都不動。
create or replace function public.apply_ecpay_payment(
  p_trade_no text, p_rtn_code text, p_payment_type text default null
) returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_txn     record;
  v_order   record;
  v_restore jsonb;
  v_alerts  text[] := '{}';
  v_alert   text := null;
  v_over    numeric;
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

  -- (N4) 優惠券還原：判準是「有沒有留下待還原的快照」，不是訂單目前的狀態。
  -- 快照只在棄單清理判定退券時才會寫（20260812170000），對沒有快照的正常
  -- 訂單這裡是安全早退。刻意放在「訂單復活」的判斷之外：就算店員已經把
  -- 訂單手動改回處理中（狀態不再是已取消），客人付的金額也必須對得上他當初
  -- 該付的折扣後金額，否則店家會拿著一張「顯示還欠錢」的單去找已經付清的客人。
  v_restore := public.restore_abandoned_order_coupon(v_order.id);
  if coalesce(v_restore->>'note', '') <> '' then
    v_alerts := v_alerts || (v_restore->>'note');
  end if;

  -- 遲到補救：通知晚於棄單清理，訂單已被取消、庫存也已回補。
  -- 復活與否仍然只看「訂單目前狀態」——快照存在不代表現在就是已取消狀態
  -- （可能已經被上面的還原或店員手動操作改掉了）。
  if v_order.status = '已取消' then
    -- 把狀態改回處理中 → reconcile_stock trigger 重新佔用庫存，
    -- 現貨不足時它自己會 raise（P0001）。
    begin
      update public.consumer_orders set status = '處理中' where id = v_order.id;
    exception
      -- (I4) 只吞 trigger 主動丟的 raise_exception（P0001，例如「庫存不足」）。
      -- deadlock、lock 逾時、statement_timeout 等暫時性錯誤一律往上丟，讓整筆
      -- rollback、交易維持 pending，綠界重送時可以重來——吞掉才會變成永久不一致。
      when raise_exception then
        v_alerts := v_alerts || ('已收款但訂單無法復活（' || sqlerrm
                                 || '；SQLSTATE ' || sqlstate
                                 || '），此單先前已被當棄單取消，請人工確認出貨或退款');
    end;
  end if;

  -- 還原與復活都可能動過訂單，重讀一次再算金額
  select * into v_order from public.consumer_orders where id = v_txn.order_id;

  -- (I3) 溢收守衛：同一張訂單可能存在多筆全額 pending 交易（兩個分頁各刷一次）。
  -- 錢真的收到了，所以照實累加，但要標出溢收金額讓店家去綠界退刷。
  if coalesce(v_order.paid_amount, 0) + coalesce(v_txn.amount, 0)
     > coalesce(v_order.total_amount, 0) then
    v_over := coalesce(v_order.paid_amount, 0) + coalesce(v_txn.amount, 0)
              - coalesce(v_order.total_amount, 0);
    v_alerts := v_alerts || ('溢收 NT$' || round(v_over, 2)::text
                             || '，請至綠界後台退刷（本筆交易編號 ' || p_trade_no || '）');
  end if;

  if array_length(v_alerts, 1) > 0 then
    v_alert := array_to_string(v_alerts, '；');
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

revoke all on function public.apply_ecpay_payment(text, text, text) from public, anon, authenticated;
