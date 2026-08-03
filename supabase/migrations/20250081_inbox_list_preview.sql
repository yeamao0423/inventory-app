-- ============================================================
-- 客服收件匣：列表要能一眼分流
--
-- 後台列表每 6 秒輪詢一次，所以「最後一則訊息」與「顧客名字」不能靠 join 或
-- 額外查詢取得 —— 那會讓輪詢變重。改成寫入時順手更新的快照欄位，
-- 列表查詢維持單表、零成本。
--
-- 這三個欄位都是**衍生資料**，不是真相來源：
--   真相在 messages.content 與 consumer_orders.customer_name，
--   這裡只是為了列表顯示而存的副本，重算隨時可以重來。
-- ============================================================

alter table public.conversations
  add column if not exists last_message_preview text,
  add column if not exists last_message_sender  text,
  add column if not exists customer_label       text;

-- ── 訊息寫入時更新預覽 ──────────────────────────────────────
-- 預覽截到 120 字：列表一行顯示不完會被 CSS 裁掉，存太長只是浪費頻寬。
-- 順便更新 last_message_at，讓排序不必仰賴呼叫端記得更新（現在 Edge Function
-- 與後台各自手動更新過一次，有 trigger 之後那些寫入變成冗餘但無害）。
create or replace function public.touch_conversation_on_message()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  update public.conversations
  set last_message_preview = left(regexp_replace(new.content, '\s+', ' ', 'g'), 120),
      last_message_sender  = new.sender,
      last_message_at      = new.created_at
  where id = new.conversation_id;
  return new;
end;
$$;

drop trigger if exists messages_touch_conversation on public.messages;
create trigger messages_touch_conversation
  after insert on public.messages
  for each row execute function public.touch_conversation_on_message();

-- ── 認領時補上顧客名字 ──────────────────────────────────────
-- consumers 表的 RLS 只讓本人讀，後台看不到；但該店自己的 consumer_orders 看得到，
-- 所以名字從最近一筆訂單取。取不到就留 null，前端顯示「會員」而不是假名字。
create or replace function public.fill_conversation_customer_label()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.consumer_id is not null
     and (old.consumer_id is null or old.consumer_id is distinct from new.consumer_id) then
    select nullif(trim(co.customer_name), '')
      into new.customer_label
      from public.consumer_orders co
     where co.store_id = new.store_id
       and co.consumer_id = new.consumer_id
       and co.customer_name is not null
     order by co.created_at desc
     limit 1;
  end if;
  return new;
end;
$$;

drop trigger if exists conversations_fill_customer_label on public.conversations;
create trigger conversations_fill_customer_label
  before update on public.conversations
  for each row execute function public.fill_conversation_customer_label();

-- ── 回填既有資料 ────────────────────────────────────────────
update public.conversations c
set last_message_preview = left(regexp_replace(m.content, '\s+', ' ', 'g'), 120),
    last_message_sender  = m.sender
from (
  select distinct on (conversation_id) conversation_id, content, sender
  from public.messages
  order by conversation_id, id desc
) m
where m.conversation_id = c.id
  and c.last_message_preview is null;

update public.conversations c
set customer_label = sub.customer_name
from (
  select distinct on (co.store_id, co.consumer_id)
         co.store_id, co.consumer_id, nullif(trim(co.customer_name), '') as customer_name
  from public.consumer_orders co
  where co.consumer_id is not null and co.customer_name is not null
  order by co.store_id, co.consumer_id, co.created_at desc
) sub
where sub.store_id = c.store_id
  and sub.consumer_id = c.consumer_id
  and c.customer_label is null;
