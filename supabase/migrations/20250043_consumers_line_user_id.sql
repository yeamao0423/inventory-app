-- ============================================================
-- LINE 智慧客服 Phase B：消費者 LINE 綁定欄位
--   consumers.line_user_id = 經 LINE 驗證的 userId（U... 33 碼），與自填的 line_id 不同。
--   只能由伺服器綁定流程(service role)寫入；前端(authenticated/anon)不得竄改，防冒綁。
-- ============================================================

alter table public.consumers add column if not exists line_user_id text;

-- 一個 LINE 帳號只能綁一位消費者（允許多筆 NULL）
create unique index if not exists consumers_line_user_id_uidx
  on public.consumers (line_user_id)
  where line_user_id is not null;

-- 保護：前端(authenticated/anon)不可修改 line_user_id，只有伺服器綁定流程能設定
create or replace function public.protect_consumer_line_user_id()
returns trigger
language plpgsql
as $$
begin
  if new.line_user_id is distinct from old.line_user_id
     and coalesce(current_setting('request.jwt.claims', true)::json ->> 'role', '') in ('authenticated', 'anon') then
    raise exception 'line_user_id 只能由伺服器綁定流程設定';
  end if;
  return new;
end;
$$;

drop trigger if exists consumers_protect_line_user_id on public.consumers;
create trigger consumers_protect_line_user_id
  before update on public.consumers
  for each row execute function public.protect_consumer_line_user_id();
