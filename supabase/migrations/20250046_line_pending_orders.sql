-- 20250046: LINE 按鈕確認下單（postback）暫存表
--
-- 背景：全對話下單的「確認」步驟改用 LINE Confirm Template 按鈕。
--       Claude 收集完訂單資訊後呼叫 stage_order 工具把訂單暫存到本表，
--       顧客點「確認下單」按鈕 → postback 事件 → edge function 直接呼叫
--       place_order（完全不經 LLM），消除模型幻覺「訂單已成立」的風險。
--
-- 生命週期：pending（等待點擊）→ confirmed / cancelled。
--       按鈕有效期 3 小時（expires_at 即時判斷）；pg_cron 每小時清掃
--       建立超過 3 小時的列。uuid 主鍵不可枚舉，postback 需同時符合
--       line_user_id 才能操作（雙條件防偽造）。

create table if not exists public.line_pending_orders (
  id             uuid primary key default gen_random_uuid(),
  line_user_id   text not null,
  consumer_id    uuid not null,
  store_id       bigint not null,
  items_json     jsonb not null,      -- place_order p_items_json 快照
  items_text     text not null,       -- place_order p_items 文字
  subtotal       numeric not null,
  shipping_fee   numeric not null,
  total_amount   numeric not null,
  address        text not null,
  note           text not null default '',
  payment_method text not null default 'remittance',
  status         text not null default 'pending'
                 check (status in ('pending','confirmed','cancelled')),
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null default now() + interval '3 hours'
);

create index if not exists line_pending_orders_user_idx
  on public.line_pending_orders (line_user_id, status);
create index if not exists line_pending_orders_time_idx
  on public.line_pending_orders (created_at);

-- service_role only（RLS enable、無 policy，跟隨 line_messages / line_rate_log 慣例）
alter table public.line_pending_orders enable row level security;

-- 每小時清掃：未點擊的暫存單保留 3 小時即刪（有效性判斷靠 expires_at，cron 只是打掃）
select cron.schedule(
  'line_pending_orders_cleanup',
  '20 * * * *',
  $$delete from public.line_pending_orders where created_at < now() - interval '3 hours'$$
);
