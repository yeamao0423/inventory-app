-- I2：與綠界回傳的實收金額（TradeAmt）對帳
--
-- 現況：付款通知進來時，只憑 MerchantTradeNo 找到我方建立的 ecpay_transactions
-- 那一列，就把該列的 amount（我方認知的應收金額）記進訂單的 paid_amount。系統從來
-- 沒有比對過綠界實際回報收到多少錢——如果參數被竄改、幣別出錯、或綠界端設定有誤，
-- 我方會照自己的數字記帳：帳面顯示已付清，但綠界實際只收到零頭。
--
-- 處理原則（與 I3 溢收守衛一致）：錢真的收到了就要記帳，假裝沒收到只會讓客人的
-- 錢憑空從系統裡消失。所以金額不符時改用綠界實收的金額記帳，並標 payment_alert
-- 讓店家人工核對，而不是拒收或悄悄按我方數字結案。
--
-- 簽名新增 p_trade_amt numeric default null（放在最後，既有呼叫端不傳也不受影響）：
--   - null（沒帶）→ 維持現行行為，用 v_txn.amount 記帳。
--   - 有值且與 v_txn.amount 相符（允許 1 元內零頭，因應少數通路的捨入）→ 一樣用
--     v_txn.amount 記帳，不標警示。
--   - 有值但不符 → 改用 p_trade_amt（綠界實收）記帳，並在 payment_alert 追加一句
--     講明「綠界實收 X 元與訂單應收 Y 元不符，請人工核對」。
--
-- 整支重貼自 20260812170500（同一組其餘邏輯：N4 優惠券還原判準、I4 例外收斂、
-- I3 溢收守衛皆不動），只新增這一段對帳。
drop function if exists public.apply_ecpay_payment(text, text, text);

create or replace function public.apply_ecpay_payment(
  p_trade_no text, p_rtn_code text, p_payment_type text default null,
  p_trade_amt numeric default null
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
  v_amount  numeric;
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

  -- (I2) 對帳：比對綠界回傳的實收金額（TradeAmt）與我方交易記錄的應收金額。
  -- 沒帶（null）或在 1 元內零頭都視為相符，照現行行為用 v_txn.amount 記帳；
  -- 不符時改用綠界實收的 p_trade_amt 記帳——錢是真的收到的，不能因為對不上
  -- 就假裝沒收到，只標警示讓店家人工核對。
  v_amount := v_txn.amount;
  if p_trade_amt is not null
     and abs(p_trade_amt - coalesce(v_txn.amount, 0)) > 1 then
    v_amount := p_trade_amt;
    v_alerts := v_alerts || ('綠界實收 NT$' || round(p_trade_amt, 2)::text
                             || ' 元與訂單應收 NT$' || round(coalesce(v_txn.amount, 0), 2)::text
                             || ' 元不符，請人工核對');
  end if;

  -- (I3) 溢收守衛：同一張訂單可能存在多筆全額 pending 交易（兩個分頁各刷一次）。
  -- 錢真的收到了，所以照實累加，但要標出溢收金額讓店家去綠界退刷。
  if coalesce(v_order.paid_amount, 0) + coalesce(v_amount, 0)
     > coalesce(v_order.total_amount, 0) then
    v_over := coalesce(v_order.paid_amount, 0) + coalesce(v_amount, 0)
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
    set paid_amount   = coalesce(paid_amount, 0) + v_amount,
        payment_alert = coalesce(v_alert, payment_alert)
    where id = v_order.id;

  update public.ecpay_transactions
    set status = 'paid', paid_at = now(), payment_type = p_payment_type
    where id = v_txn.id;

  return jsonb_build_object('ok', true, 'already', false, 'paid', true,
                            'order_id', v_order.id, 'alert', v_alert);
end $$;

revoke all on function public.apply_ecpay_payment(text, text, text, numeric) from public, anon, authenticated;
