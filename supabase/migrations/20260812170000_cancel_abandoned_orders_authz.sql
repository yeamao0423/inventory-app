-- 棄單清理：補授權、夾住 p_minutes、收緊 EXECUTE，並留下優惠券快照
--
-- ── 為什麼（C4，Critical）──────────────────────────────────────
-- 20260812130000 把 cancel_abandoned_credit_orders 這支 SECURITY DEFINER 函式
-- grant execute 給了 authenticated，函式體內卻沒有任何授權檢查。商城消費者是用
-- Supabase Auth 登入的，拿到的就是 authenticated 角色，於是任何會員在瀏覽器
-- console 執行：
--     await supabase.rpc('cancel_abandoned_credit_orders', { p_minutes: -100000 })
-- 就會讓 now() - make_interval(mins => -100000) 變成「現在 + 69 天」，條件對
-- 全平台（含兩家根本沒申請綠界的店）所有未付信用卡訂單成立 → 一次全部取消、
-- 回補庫存、退掉優惠券。migration 一上 remote 就可被打。
--
-- ── 怎麼修 ────────────────────────────────────────────────────
-- 1) 授權：比照 20260812110000_batch_inventory_rpcs.sql:21 的既有慣例——
--    auth.uid() IS NULL ＝ 無 JWT 的內部呼叫（pg_cron／service_role／psql），放行；
--    有 JWT 時要求 public.is_platform_admin()，否則 raise。這支是全平台範圍的
--    掃描，不是單店操作，所以用 platform admin 而非 has_store_role。
-- 2) p_minutes 夾成 greatest(coalesce(p_minutes, 30), 1)：杜絕負數與 0
--    （0 會把「剛剛才建立」的訂單也掃掉）。
-- 3) EXECUTE 收緊成 revoke from public, anon, authenticated。pg_cron 的 job
--    以 username='postgres'（本函式的 owner）執行，owner 自己的 EXECUTE 不會被
--    這個 revoke 拿掉，排程照跑；service_role 保留，後端維運仍可手動掃一次。
--
-- ── 順帶（I1 的前半）──────────────────────────────────────────
-- refund_coupon 會把 total_amount 加回 discount_amount。棄單被取消 → 退券 →
-- total_amount 被抬高；之後綠界通知遲到、apply_ecpay_payment 把訂單復活並記入
-- 「當初折扣後的金額」，就會變成付清了卻顯示「部分付款」。要在復活時把券還原，
-- 就必須在退券**之前**把券的資訊留下來（refund_coupon 會清掉 coupon_id、
-- discount_amount 與 coupon_usage 列，事後無從得知折了多少）。
-- 快照只在「排程判定為棄單」這條路徑上寫，後台手動退券不寫，所以復活的還原
-- 只會發生在它該發生的地方。
-- 表開 RLS 且零 policy（同 store_ecpay_secrets 的做法）：只有 SECURITY DEFINER
-- 函式（以 owner 身分執行、繞過 RLS）碰得到，消費者的 select('*') 打不到。

create table if not exists public.abandoned_order_coupons (
  order_id        bigint primary key references public.consumer_orders(id) on delete cascade,
  coupon_id       bigint not null,
  coupon_code_id  bigint,
  discount_amount numeric(10,2) not null default 0,
  created_at      timestamptz not null default now()
);

comment on table public.abandoned_order_coupons is
  '棄單清理取消訂單前的優惠券快照。綠界通知遲到、訂單被復活時由 restore_abandoned_order_coupon 還原後刪除。刻意不對 coupons 建外鍵：優惠券被刪掉時快照仍要能還原訂單金額。';

alter table public.abandoned_order_coupons enable row level security;
revoke all on table public.abandoned_order_coupons from public, anon, authenticated;

create or replace function public.cancel_abandoned_credit_orders(p_minutes int default 30)
returns int
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id      bigint;
  v_n       int := 0;
  v_minutes int;
begin
  -- 授權：無 JWT ＝ pg_cron／service_role／直連 DB 的內部呼叫，放行；
  -- 有 JWT 就必須是平台管理員（這支的影響範圍是全平台，不是單一店家）。
  if auth.uid() is not null and not public.is_platform_admin() then
    raise exception '沒有權限執行棄單清理';
  end if;

  -- 下限 1 分鐘：負數會把未來的訂單也掃進來，0 會掃掉剛建立的訂單。
  v_minutes := greatest(coalesce(p_minutes, 30), 1);

  for v_id in
    select id from public.consumer_orders
    where payment_method = 'credit'
      and coalesce(paid_amount, 0) <= 0           -- 收到任何錢就不是棄單
      and status not in ('已取消', '完成', '已出貨')
      and allpay_logistics_id is null             -- 已建物流單就不是棄單
      and created_at < now() - make_interval(mins => v_minutes)
  loop
    -- 退券之前先留快照：refund_coupon 之後這些資訊就沒了，遲到補救要靠它還原。
    insert into public.abandoned_order_coupons
      (order_id, coupon_id, coupon_code_id, discount_amount)
    select o.id,
           o.coupon_id,
           (select cu.coupon_code_id from public.coupon_usage cu where cu.order_id = o.id limit 1),
           coalesce(o.discount_amount, 0)
      from public.consumer_orders o
     where o.id = v_id
       and o.coupon_id is not null
    on conflict (order_id) do update
      set coupon_id       = excluded.coupon_id,
          coupon_code_id  = excluded.coupon_code_id,
          discount_amount = excluded.discount_amount,
          created_at      = now();

    -- 狀態改成已取消 → reconcile_stock trigger 把佔用量歸零，庫存自動回補
    update public.consumer_orders set status = '已取消' where id = v_id;

    -- 排程繞過了後台 UI，優惠券要自己退（refund_coupon 對無券/已退自身安全）。
    perform public.refund_coupon(v_id);

    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

revoke all on function public.cancel_abandoned_credit_orders(int) from public, anon, authenticated;

-- 排程本身不變（20260812130000 已建）；這裡重貼一次讓本 migration 單獨重跑也完整。
select cron.unschedule('ecpay-abandon-sweep')
where exists (select 1 from cron.job where jobname = 'ecpay-abandon-sweep');

select cron.schedule(
  'ecpay-abandon-sweep',
  '*/5 * * * *',
  $$select public.cancel_abandoned_credit_orders(30)$$
);
