-- ============================================================
-- 客服收件匣 — 站內閉環（第一版）
--   對話（conversations）／訊息（messages）：與管道無關的資料模型，
--   本版只寫入 channel='web'（商城站內聊天），LINE 維持現行的 line_messages 不動。
--
--   消費者端不直接連資料庫（ADR-0002）：讀寫一律走 chat Edge Function（service role），
--   所以這裡只需要「後台端」的 RLS policy，anon／consumer 一律無 policy＝預設拒絕。
--
--   跨店紅線：同一位消費者在 A 店與 B 店的對話絕對不能互見 —— 靠 store_id + has_store_role。
-- ============================================================

-- ── 對話 ────────────────────────────────────────────────────
create table if not exists public.conversations (
  id               bigserial primary key,
  store_id         bigint not null references public.stores(id) on delete cascade,
  -- 管道：本版只有 'web'，'line' 是第二階段併入時的預留值
  channel          text not null default 'web' check (channel in ('web', 'line')),
  -- 身分：登入後為 consumer_id；尚未識別的訪客只有 visitor_token
  consumer_id      uuid   references public.consumers(id) on delete set null,
  visitor_token    text,
  -- 第二階段放 line_user_id（同一管道內的外部使用者識別碼）
  external_user_id text,
  status           text not null default 'bot'
                     check (status in ('bot', 'waiting_human', 'human', 'closed')),
  -- 誰在處理（只顯示，不做鎖）
  assigned_to      uuid   references auth.users(id) on delete set null,
  last_message_at  timestamptz not null default now(),
  unread_for_store integer not null default 0,
  created_at       timestamptz not null default now(),
  -- 至少要認得出是誰：登入的消費者，或帶著訪客識別碼的訪客
  constraint conversations_identity_chk
    check (consumer_id is not null or visitor_token is not null)
);

-- 工作台列表：某店的對話依最後訊息排序（waiting_human 置頂由前端排）
create index if not exists conversations_store_time_idx
  on public.conversations (store_id, last_message_at desc);
-- 訪客回訪／認領：以 (店, 訪客識別碼) 反查
create index if not exists conversations_store_visitor_idx
  on public.conversations (store_id, visitor_token) where visitor_token is not null;
-- 記憶取用：以 (店, 消費者) 撈該人在該店的歷史
create index if not exists conversations_store_consumer_idx
  on public.conversations (store_id, consumer_id) where consumer_id is not null;

-- ── 訊息 ────────────────────────────────────────────────────
create table if not exists public.messages (
  id              bigserial primary key,
  conversation_id bigint not null references public.conversations(id) on delete cascade,
  -- 冗餘欄位：讓 RLS 不必 join conversations
  store_id        bigint not null references public.stores(id) on delete cascade,
  sender          text not null check (sender in ('consumer', 'assistant', 'staff')),
  -- sender='staff' 時記錄是哪位後台成員回的
  sender_user_id  uuid references auth.users(id) on delete set null,
  content         text not null,
  created_at      timestamptz not null default now()
);

create index if not exists messages_conversation_idx
  on public.messages (conversation_id, id);
create index if not exists messages_store_time_idx
  on public.messages (store_id, created_at desc);

-- ── 限流計數 ────────────────────────────────────────────────
-- 兩層：每訪客每分鐘、每店每日。匿名訪客能直接觸發 Anthropic API，
-- 這是公開網路上的帳單風險，不是可選項。
create table if not exists public.chat_rate_log (
  id          bigserial primary key,
  store_id    bigint not null,
  -- 訪客識別碼或 consumer_id，看誰發的
  visitor_key text not null,
  created_at  timestamptz not null default now()
);
create index if not exists chat_rate_log_visitor_time_idx
  on public.chat_rate_log (visitor_key, created_at);
create index if not exists chat_rate_log_store_time_idx
  on public.chat_rate_log (store_id, created_at);

-- ── PWA 推播訂閱 ────────────────────────────────────────────
-- 一位後台成員可能在多個裝置訂閱（手機＋桌機），所以 endpoint 才是唯一鍵。
create table if not exists public.push_subscriptions (
  id           bigserial primary key,
  user_id      uuid   not null references auth.users(id) on delete cascade,
  store_id     bigint not null references public.stores(id) on delete cascade,
  endpoint     text   not null unique,
  p256dh       text   not null,
  auth         text   not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists push_subscriptions_store_idx
  on public.push_subscriptions (store_id);

-- ============================================================
-- RLS：只開後台端。消費者端走 Edge Function（service role），
-- 所以 anon／authenticated-消費者 一律沒有 policy＝讀不到任何一列。
-- ============================================================
alter table public.conversations      enable row level security;
alter table public.messages           enable row level security;
alter table public.chat_rate_log      enable row level security;  -- 無 policy：僅 service role
alter table public.push_subscriptions enable row level security;

-- ── conversations ───────────────────────────────────────────
-- 讀：該店所有後台成員（含 viewer）。客服對話沒有成本等敏感欄位，viewer 可看。
drop policy if exists "members read conversations" on public.conversations;
create policy "members read conversations" on public.conversations
  for select to authenticated
  using (public.is_store_member(store_id));

-- 寫：接管／交還／關閉／清未讀 = editor 以上（viewer 只讀）
drop policy if exists "editors update conversations" on public.conversations;
create policy "editors update conversations" on public.conversations
  for update to authenticated
  using      (public.has_store_role(store_id, array['super_admin','admin','editor']))
  with check (public.has_store_role(store_id, array['super_admin','admin','editor']));

-- ── messages ────────────────────────────────────────────────
drop policy if exists "members read messages" on public.messages;
create policy "members read messages" on public.messages
  for select to authenticated
  using (public.is_store_member(store_id));

-- 後台只能以「真人客服」身分發言，且必須掛自己的名字（不可冒充助理或消費者）
drop policy if exists "editors insert staff messages" on public.messages;
create policy "editors insert staff messages" on public.messages
  for insert to authenticated
  with check (
    public.has_store_role(store_id, array['super_admin','admin','editor'])
    and sender = 'staff'
    and sender_user_id = auth.uid()
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.store_id = messages.store_id
    )
  );

-- ── push_subscriptions：只管自己的裝置，且必須是該店成員 ────
drop policy if exists "members manage own push subscriptions" on public.push_subscriptions;
create policy "members manage own push subscriptions" on public.push_subscriptions
  for all to authenticated
  using      (user_id = auth.uid() and public.is_store_member(store_id))
  with check (user_id = auth.uid() and public.is_store_member(store_id));

-- ============================================================
-- 定期回收：限流 log 不需要留（對話與訊息「不自動刪除」，見規格）
-- ============================================================
select cron.schedule(
  'chat_rate_log_cleanup',
  '20 4 * * *',
  $$delete from public.chat_rate_log where created_at < now() - interval '2 days'$$
);
