-- apply_ecpay_payment 三項補強：優惠券還原（I1）、溢收守衛（I3）、例外收斂（I4）
--
-- ══ I1：棄單退券抬高了 total_amount，遲到補救復活後變成「部分付款」 ══
-- refund_coupon（20260812130100:67-71）退券時會 total_amount = total_amount +
-- discount_amount，並清掉 coupon_id / discount_amount / coupon_usage。
-- 棄單清理對每張被取消的訂單都呼叫它，所以：
--   1000 元、折 200 → total_amount=800、交易金額 800
--   → 逾時被當棄單取消＋退券 → total_amount 回到 1000
--   → 綠界通知遲到、訂單復活、記入 800 → derive_payment_status(800,1000)='部分付款'
--   → 後台去跟已經付清的客人要 200，客人的券還一併蒸發。
--
-- 選擇的做法：**還原優惠券**（而不是「不要在退券時動 total_amount」或
-- 「復活時只把 total_amount 減回去」）。理由：
--   (a) refund_coupon 的 total_amount += discount_amount 對它原本的用途（後台人工
--       退券，客人之後要補足全額）是正確的，改它會傷到既有後台流程；
--   (b) 只調 total_amount 不還券的話，訂單會停在「金額像有折扣、但沒掛任何券、
--       coupon_usage 也不見」的狀態，優惠券的用量統計與 unique 券的核銷會永久對不起來；
--   (c) 還原是退券的精確反向操作，事後看得出這張單真的用過那張券。
-- 資訊來源是 abandoned_order_coupons 快照（20260812170000 在退券前寫入），
-- 只有「被排程判定為棄單」的訂單才有快照，所以後台人工退券不會被這條路徑還原。
--
-- 還原的優先順序是**金額先於券**：即使優惠券已被刪、或 unique 券的碼在這段空窗
-- 期被別人用掉，也一定要把 total_amount 調回去——客人付的是折扣後金額，不能因為
-- 券的狀態變了就變成欠錢。券還不回去的情形改寫進 payment_alert 讓店家知道。
--
-- ══ I3：同一張訂單兩筆全額 pending 交易，兩筆都付會重複收款 ══
-- 冪等鍵是 trade_no，但每次進付款頁都會產生新的 trade_no，金額都等於當下未付餘額。
-- 消費者開兩個分頁各刷一次 → paid_amount = 2 倍。錢是真的收到了，所以照實記帳，
-- 但標 payment_alert 說明溢收多少、要去綠界退刷。
--
-- ══ I4：EXCEPTION WHEN others 把暫時性錯誤吞成永久不一致 ══
-- 復活那句 UPDATE 撞上 deadlock_detected / lock_not_available / statement_timeout
-- 時，原本的 when others 會吞掉、標成「庫存不足」，但交易照樣被設成 'paid'——
-- 綠界重送時第一段冪等檢查直接短路，復活永遠不會再被嘗試。
-- reconcile_stock trigger（20260812100000:105/110/117）用的是不帶 USING ERRCODE 的
-- RAISE EXCEPTION，SQLSTATE 一律是 P0001（raise_exception）；暫時性錯誤則落在
-- 40001/40P01/55P03/57014 等 class。所以只捕捉 raise_exception，其餘一律往上丟，
-- 讓整筆 rollback、綠界重送時重新來過。警示訊息帶上 sqlerrm 與 sqlstate。

-- ========== 優惠券還原（供 apply_ecpay_payment 內部呼叫） ==========
create or replace function public.restore_abandoned_order_coupon(p_order_id bigint)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_snap    record;
  v_order   record;
  v_coupon  record;
  v_code    record;
  v_code_id bigint := null;
  v_note    text   := null;
  v_has_coupon boolean := false;
begin
  select * into v_snap from public.abandoned_order_coupons
    where order_id = p_order_id for update;
  if not found then
    return jsonb_build_object('ok', true, 'restored', false);
  end if;

  select * into v_order from public.consumer_orders where id = p_order_id;
  if not found then
    delete from public.abandoned_order_coupons where order_id = p_order_id;
    return jsonb_build_object('ok', false, 'error', '訂單不存在');
  end if;

  -- 訂單已經掛著券（例如店家人工重新套用）就不要覆蓋，直接丟掉快照
  if v_order.coupon_id is not null then
    delete from public.abandoned_order_coupons where order_id = p_order_id;
    return jsonb_build_object('ok', true, 'restored', false,
                              'note', '訂單已有優惠券，未套用快照');
  end if;

  select * into v_coupon from public.coupons where id = v_snap.coupon_id for update;
  v_has_coupon := found;

  if v_has_coupon then
    -- unique 券的碼在空窗期可能已被別人用掉，被用掉就不搶回來，只還金額與券次
    if v_snap.coupon_code_id is not null then
      select * into v_code from public.coupon_codes where id = v_snap.coupon_code_id for update;
      if found and coalesce(v_code.is_used, false) = false then
        update public.coupon_codes
           set is_used = true, used_by = v_order.email, used_at = now(), order_id = p_order_id
         where id = v_code.id;
        v_code_id := v_code.id;
      else
        v_note := '原優惠碼已被他人使用或已刪除，僅還原訂單金額與優惠券用量';
      end if;
    end if;

    update public.coupons
       set usage_count = coalesce(usage_count, 0) + 1, updated_at = now()
     where id = v_coupon.id;

    insert into public.coupon_usage
      (coupon_id, coupon_code_id, order_id, consumer_email, discount_amount)
    values
      (v_snap.coupon_id, v_code_id, p_order_id, v_order.email,
       coalesce(v_snap.discount_amount, 0));
  else
    v_note := '原優惠券已不存在，僅還原訂單金額';
  end if;

  -- 金額一定要還：客人付的是折扣後金額。coupon_id 只在券還在時才掛回去。
  update public.consumer_orders
     set total_amount    = greatest(coalesce(total_amount, 0)
                                    - coalesce(v_snap.discount_amount, 0), 0),
         discount_amount = coalesce(v_snap.discount_amount, 0),
         coupon_id       = case when v_has_coupon then v_snap.coupon_id else null end
   where id = p_order_id;

  delete from public.abandoned_order_coupons where order_id = p_order_id;

  return jsonb_build_object('ok', true, 'restored', true,
                            'discount_amount', coalesce(v_snap.discount_amount, 0),
                            'note', v_note);
end $$;

-- ========== 套用付款結果（整支重貼） ==========
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

  -- 遲到補救：通知晚於棄單清理，訂單已被取消、庫存也已回補、優惠券也已退。
  if v_order.status = '已取消' then
    -- (I1) 先還原優惠券——這一步刻意放在復活狀態的 sub-transaction 之外：
    -- 就算庫存不足導致訂單復活失敗、維持「已取消」，客人付的金額也必須對得上
    -- 他當初該付的金額，否則店家會拿著一張「顯示還欠錢」的單去找已經付清的客人。
    v_restore := public.restore_abandoned_order_coupon(v_order.id);
    if coalesce(v_restore->>'note', '') <> '' then
      v_alerts := v_alerts || (v_restore->>'note');
    end if;

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

    -- 還原與復活都可能動過訂單，重讀一次再算金額
    select * into v_order from public.consumer_orders where id = v_txn.order_id;
  end if;

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

-- 權限：兩支都只由商城 API route（service role）或本檔內部呼叫，不開給 anon/authenticated
revoke all on function public.restore_abandoned_order_coupon(bigint) from public, anon, authenticated;
revoke all on function public.apply_ecpay_payment(text, text, text) from public, anon, authenticated;
