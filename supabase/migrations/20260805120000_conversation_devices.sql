-- ============================================================
-- 一條對話可以有多個裝置
--
-- 原本對話的找回依據是 (store_id, visitor_token)，而 visitor_token 存在 localStorage。
-- 換瀏覽器、清快取、開無痕、換手機都會拿到新的識別碼 → 同一個人散成好幾條對話。
--
-- 這張表把「裝置」從 conversations 拆出來：對話屬於「人」，裝置只是他從哪裡連進來。
-- conversations.visitor_token 保留不動，語意變成「建立這條對話的第一個裝置」。
-- ============================================================

create table if not exists public.conversation_devices (
  conversation_id bigint not null references public.conversations(id) on delete cascade,
  visitor_token   text   not null,
  -- 冗餘欄位：讓 RLS 與反查不必 join conversations（與 messages.store_id 同一個理由）
  store_id        bigint not null references public.stores(id) on delete cascade,
  first_seen_at   timestamptz not null default now(),
  primary key (conversation_id, visitor_token)
);

-- 訪客回訪：以 (店, 訪客識別碼) 反查對話。取代原本查 conversations.visitor_token 的路徑。
create index if not exists conversation_devices_token_idx
  on public.conversation_devices (store_id, visitor_token);

alter table public.conversation_devices enable row level security;

-- 後台成員唯讀（客服想知道這位客人從幾台裝置來過）。寫入只有 service role（Edge Function）。
drop policy if exists "members read conversation devices" on public.conversation_devices;
create policy "members read conversation devices" on public.conversation_devices
  for select to authenticated
  using (public.is_store_member(store_id));

-- ── 回填 ────────────────────────────────────────────────────
-- 既有每一條對話的建立裝置。沒有 visitor_token 的（理論上不存在，identity_chk 允許
-- 只有 consumer_id 的情況）跳過。
insert into public.conversation_devices (conversation_id, visitor_token, store_id, first_seen_at)
select c.id, c.visitor_token, c.store_id, c.created_at
from public.conversations c
where c.visitor_token is not null
on conflict do nothing;
