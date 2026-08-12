-- 每店綠界金鑰（機密）：獨立表、零 client policy
-- stores.settings 會整包送到商城前端（含匿名訪客），HashKey/HashIV 不能放那裡；
-- 此表啟用 RLS 且故意不建任何 policy → anon/authenticated 完全碰不到，
-- 只有商城的 API route（service role，繞過 RLS）讀得到。
--
-- 金流與物流是綠界分開申請的兩組特店編號與金鑰，故各存三欄。
create table if not exists public.store_ecpay_secrets (
  store_id                bigint primary key references public.stores(id) on delete cascade,
  env                     text not null default 'stage',   -- 'stage' | 'production'
  merchant_id             text not null,
  hash_key                text not null,
  hash_iv                 text not null,
  logistics_merchant_id   text,
  logistics_hash_key      text,
  logistics_hash_iv       text,
  sender_name             text,
  sender_phone            text,
  cod_max                 integer not null default 20000,  -- 貨到付款金額上限
  updated_at              timestamptz not null default now()
);
alter table public.store_ecpay_secrets enable row level security;

comment on table public.store_ecpay_secrets is
  '每店綠界金鑰。RLS 開啟且無任何 policy，僅 service role 可讀；寫入走 set_store_ecpay_credentials。';

-- 店主寫入口（寫得進、讀不出）：僅平台管理員可設定。
-- 綠界金鑰填錯的代價是收款失敗或進錯帳戶，本輪不開放店主自助設定。
-- hash 類欄位傳 null/空字串＝維持原值（後台只改寄件人時不必重打金鑰）。
create or replace function public.set_store_ecpay_credentials(
  p_store_id              bigint,
  p_env                   text default 'stage',
  p_merchant_id           text default null,
  p_hash_key              text default null,
  p_hash_iv               text default null,
  p_logistics_merchant_id text default null,
  p_logistics_hash_key    text default null,
  p_logistics_hash_iv     text default null,
  p_sender_name           text default null,
  p_sender_phone          text default null,
  p_cod_max               integer default 20000
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_env text := case when p_env = 'production' then 'production' else 'stage' end;
  v_cod integer := greatest(1, least(coalesce(p_cod_max, 20000), 20000));
begin
  if not public.is_platform_admin() then
    raise exception '僅平台管理員可設定綠界金鑰';
  end if;

  -- 特店編號傳空＝整組清除
  if p_merchant_id is not null and length(trim(p_merchant_id)) = 0 then
    delete from public.store_ecpay_secrets where store_id = p_store_id;
    update public.stores
    set settings = coalesce(settings, '{}'::jsonb)
                   || jsonb_build_object('ecpay_set', false, 'ecpay_env', v_env, 'ecpay_cod_max', v_cod)
    where id = p_store_id;
    return;
  end if;

  insert into public.store_ecpay_secrets as s (
    store_id, env, merchant_id, hash_key, hash_iv,
    logistics_merchant_id, logistics_hash_key, logistics_hash_iv,
    sender_name, sender_phone, cod_max, updated_at
  ) values (
    p_store_id, v_env,
    coalesce(nullif(trim(p_merchant_id), ''), ''),
    coalesce(nullif(trim(p_hash_key), ''), ''),
    coalesce(nullif(trim(p_hash_iv), ''), ''),
    nullif(trim(p_logistics_merchant_id), ''),
    nullif(trim(p_logistics_hash_key), ''),
    nullif(trim(p_logistics_hash_iv), ''),
    nullif(trim(p_sender_name), ''),
    nullif(trim(p_sender_phone), ''),
    v_cod, now()
  )
  on conflict (store_id) do update set
    env                   = v_env,
    merchant_id           = coalesce(nullif(trim(p_merchant_id), ''), s.merchant_id),
    hash_key              = coalesce(nullif(trim(p_hash_key), ''), s.hash_key),
    hash_iv               = coalesce(nullif(trim(p_hash_iv), ''), s.hash_iv),
    logistics_merchant_id = coalesce(nullif(trim(p_logistics_merchant_id), ''), s.logistics_merchant_id),
    logistics_hash_key    = coalesce(nullif(trim(p_logistics_hash_key), ''), s.logistics_hash_key),
    logistics_hash_iv     = coalesce(nullif(trim(p_logistics_hash_iv), ''), s.logistics_hash_iv),
    sender_name           = coalesce(nullif(trim(p_sender_name), ''), s.sender_name),
    sender_phone          = coalesce(nullif(trim(p_sender_phone), ''), s.sender_phone),
    cod_max               = v_cod,
    updated_at            = now();

  -- 非機密旗標進 settings，讓後台顯示「已設定/未設定」、讓結帳頁決定要不要出現綠界選項
  update public.stores
  set settings = coalesce(settings, '{}'::jsonb)
                 || jsonb_build_object('ecpay_set', true, 'ecpay_env', v_env, 'ecpay_cod_max', v_cod)
  where id = p_store_id;
end;
$$;

revoke all on function public.set_store_ecpay_credentials(bigint, text, text, text, text, text, text, text, text, text, integer) from public, anon;
grant execute on function public.set_store_ecpay_credentials(bigint, text, text, text, text, text, text, text, text, text, integer) to authenticated;
