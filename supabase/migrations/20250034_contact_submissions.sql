-- contact_submissions：官網 /contact 表單留言。
-- 寫入只能透過 contact-submit Edge Function（service role 繞過 RLS）；
-- 匿名前端禁止直接 insert/select，杜絕拿公開 anon key 直打 REST API 灌注垃圾。
create table if not exists public.contact_submissions (
  id          bigint generated always as identity primary key,
  name        text not null,
  email       text not null,
  message     text not null,
  ip          text,
  created_at  timestamptz not null default now()
);

alter table public.contact_submissions enable row level security;

-- 不建任何 insert policy → 預設全拒匿名寫入；唯一入口是 Edge Function。
-- 只開「平台管理員可讀」，方便日後在後台／SQL 檢視留言。
drop policy if exists "platform admin reads contact_submissions" on public.contact_submissions;
create policy "platform admin reads contact_submissions"
  on public.contact_submissions
  for select to authenticated
  using (public.is_platform_admin());

-- 限流查詢用：依 ip + 時間範圍掃描
create index if not exists contact_submissions_ip_created_idx
  on public.contact_submissions (ip, created_at desc);
