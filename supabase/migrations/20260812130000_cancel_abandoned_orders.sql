-- 信用卡棄單自動清理
--
-- 導轉綠界後沒付款的訂單會一直壓著庫存。匯款是填完後五碼才送出（等於已成交意圖），
-- 信用卡是跳走後可能直接關掉，棄單率完全不同量級，所以只掃信用卡。
--
-- 庫存回補交給 reconcile_stock trigger（20260812100000）：狀態設成「已取消」，
-- 目標佔用量即為 0，trigger 自己算差額還庫存。此處不可手動改 products.quantity。
--
-- 退券直接呼叫 public.refund_coupon，不再吞例外：20260812130100_refund_coupon_internal_calls.sql
-- 已經把 refund_coupon 的授權檢查改成「auth.uid() IS NULL（無 JWT 的內部呼叫）就放行」，
-- 所以這裡的呼叫在 pg_cron／service role 情境下不會再被誤擋。真的失敗（例如未來
-- refund_coupon 邏輯改了、丟出非預期例外）就該讓它整筆 rollback，不要靜默吞掉。
create or replace function public.cancel_abandoned_credit_orders(p_minutes int default 30)
returns int
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id bigint;
  v_n  int := 0;
begin
  for v_id in
    select id from public.consumer_orders
    where payment_method = 'credit'
      and coalesce(paid_amount, 0) <= 0           -- 收到任何錢就不是棄單
      and status not in ('已取消', '完成', '已出貨')
      and allpay_logistics_id is null             -- 已建物流單就不是棄單
      and created_at < now() - make_interval(mins => p_minutes)
  loop
    -- 狀態改成已取消 → reconcile_stock trigger 把佔用量歸零，庫存自動回補
    update public.consumer_orders set status = '已取消' where id = v_id;

    -- 排程繞過了後台 UI，優惠券要自己退（refund_coupon 對無券/已退自身安全）。
    perform public.refund_coupon(v_id);

    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

revoke all on function public.cancel_abandoned_credit_orders(int) from public, anon;
grant execute on function public.cancel_abandoned_credit_orders(int) to authenticated;

-- 每 5 分鐘掃一次（pg_cron 已裝，版本 1.6.4）
-- 30 分鐘足以涵蓋「開了付款頁去找卡片」，又不會讓熱門商品被殭屍訂單壓住。
select cron.unschedule('ecpay-abandon-sweep')
where exists (select 1 from cron.job where jobname = 'ecpay-abandon-sweep');

select cron.schedule(
  'ecpay-abandon-sweep',
  '*/5 * * * *',
  $$select public.cancel_abandoned_credit_orders(30)$$
);
