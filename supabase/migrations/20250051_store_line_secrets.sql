-- 每店 LINE Channel Secret（機密）：獨立表、零 client policy
-- stores.settings 會整包送到商城前端（含匿名訪客），機密不能放那裡；
-- 此表啟用 RLS 且故意不建任何 policy → anon/authenticated 完全碰不到，
-- 只有 Edge Function（service role，繞過 RLS）讀得到。
create table if not exists public.store_line_secrets (
  store_id bigint primary key references public.stores(id) on delete cascade,
  channel_secret text not null,
  updated_at timestamptz not null default now()
);
alter table public.store_line_secrets enable row level security;

-- 店主寫入口（寫得進、讀不出）：驗店主/平台管理員 → upsert；
-- 同時在 stores.settings 併入 line_channel_secret_set 布林旗標，
-- 讓後台顯示「已設定/未設定」而不暴露值本身。傳空值＝清除。
create or replace function public.set_line_channel_secret(p_store_id bigint, p_secret text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not (public.has_store_role(p_store_id, array['super_admin']) or public.is_platform_admin()) then
    raise exception '僅店主可設定 LINE Channel Secret';
  end if;

  if p_secret is null or length(trim(p_secret)) = 0 then
    delete from public.store_line_secrets where store_id = p_store_id;
    update public.stores
    set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('line_channel_secret_set', false)
    where id = p_store_id;
    return;
  end if;

  insert into public.store_line_secrets (store_id, channel_secret, updated_at)
  values (p_store_id, trim(p_secret), now())
  on conflict (store_id) do update
    set channel_secret = excluded.channel_secret, updated_at = now();

  update public.stores
  set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('line_channel_secret_set', true)
  where id = p_store_id;
end;
$$;

revoke all on function public.set_line_channel_secret(bigint, text) from public, anon;
grant execute on function public.set_line_channel_secret(bigint, text) to authenticated;
