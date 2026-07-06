-- ============================================================
-- LINE 智慧客服 Phase A：對話記憶 + 儲存回收
--   line_messages：每人最近 8 則 / 30 分鐘 session（載入時控制）
--   保留 3 天，pg_cron 每日清理（line_messages>3天、line_rate_log>2天）
-- ============================================================

-- 對話記憶表（只存最終文字，不存 tool_use 中間過程）
create table if not exists public.line_messages (
  id           bigserial primary key,
  line_user_id text not null,
  role         text not null check (role in ('user', 'assistant')),
  content      text not null,
  created_at   timestamptz not null default now()
);
create index if not exists line_messages_user_time_idx on public.line_messages (line_user_id, created_at);
create index if not exists line_messages_time_idx      on public.line_messages (created_at);
-- 只給 service role（edge function）用
alter table public.line_messages enable row level security;

-- 定期回收：啟用 pg_cron，排兩個每日清理任務（UTC 04:00 ≈ 台灣中午）
create extension if not exists pg_cron;

-- cron.schedule 具名版本會覆蓋同名任務（idempotent）
select cron.schedule(
  'line_messages_cleanup',
  '0 4 * * *',
  $$delete from public.line_messages where created_at < now() - interval '3 days'$$
);
select cron.schedule(
  'line_rate_log_cleanup',
  '10 4 * * *',
  $$delete from public.line_rate_log where created_at < now() - interval '2 days'$$
);
