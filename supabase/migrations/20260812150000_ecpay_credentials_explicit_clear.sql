-- 修正 set_store_ecpay_credentials 的「留空」語意：
-- 原版把 p_merchant_id 傳空字串定義成「清除整組設定」，但其餘欄位（HashKey/HashIV/寄件人）
-- 傳空字串卻是「維持原值」——這個不一致是陷阱：管理員只想改貨到付款上限，若特店編號欄位
-- 在畫面上讀不回來（本來就值只進不出）而維持空白送出，會誤把整組金鑰刪掉，正在收真錢的
-- 店家因此斷金流。改成：清除只能由新增的 p_clear boolean 顯式觸發，其餘所有欄位一律
-- 「留空/傳 null＝維持原值」，包含 p_merchant_id。
--
-- 舊簽名是 11 個參數，新簽名加了 p_clear 變成 12 個，故先 drop 舊的避免 overload 造成呼叫歧義。
drop function if exists public.set_store_ecpay_credentials(
  bigint, text, text, text, text, text, text, text, text, text, integer
);

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
  p_cod_max               integer default 20000,
  p_clear                 boolean default false
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_env text := case when p_env = 'production' then 'production' else 'stage' end;
  v_cod integer := greatest(1, least(coalesce(p_cod_max, 20000), 20000));
  v_exists boolean;
  v_merchant_id text;
  v_logistics_merchant_id text;
begin
  if not public.is_platform_admin() then
    raise exception '僅平台管理員可設定綠界金鑰';
  end if;

  -- 清除整組設定：只能由 p_clear 顯式觸發，不再由「特店編號留空」隱含觸發
  if p_clear then
    delete from public.store_ecpay_secrets where store_id = p_store_id;
    update public.stores
    set settings = (coalesce(settings, '{}'::jsonb) || jsonb_build_object('ecpay_set', false))
                   - 'ecpay_env' - 'ecpay_cod_max' - 'ecpay_merchant_id' - 'ecpay_logistics_merchant_id'
    where id = p_store_id;
    return;
  end if;

  select exists(select 1 from public.store_ecpay_secrets where store_id = p_store_id) into v_exists;

  -- 該店還沒有任何設定時，特店編號不可留空（沒有舊值可以「維持原值」）
  if not v_exists and (p_merchant_id is null or length(trim(p_merchant_id)) = 0) then
    raise exception '首次設定必須填入金流特店編號';
  end if;

  insert into public.store_ecpay_secrets as s (
    store_id, env, merchant_id, hash_key, hash_iv,
    logistics_merchant_id, logistics_hash_key, logistics_hash_iv,
    sender_name, sender_phone, cod_max, updated_at
  ) values (
    p_store_id, v_env,
    -- merchant_id/hash_key/hash_iv 是 not null 欄位，首次 insert 時用空字串頂著、
    -- 真正的「留空＝維持原值」邏輯在下面的 on conflict do update 才生效
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

  select merchant_id, logistics_merchant_id
  into v_merchant_id, v_logistics_merchant_id
  from public.store_ecpay_secrets where store_id = p_store_id;

  -- 非機密旗標＋兩個特店編號進 settings：特店編號本來就會出現在送往綠界的付款表單裡
  -- （消費者瀏覽器看得到），不算機密，讓後台能顯示目前掛的是哪一組帳號。
  -- HashKey/HashIV/寄件人資訊絕對不可以放進 settings —— 那會整包送到商城前端給匿名訪客。
  update public.stores
  set settings = coalesce(settings, '{}'::jsonb)
                 || jsonb_build_object(
                      'ecpay_set', true,
                      'ecpay_env', v_env,
                      'ecpay_cod_max', v_cod,
                      'ecpay_merchant_id', v_merchant_id,
                      'ecpay_logistics_merchant_id', v_logistics_merchant_id
                    )
  where id = p_store_id;
end;
$$;

revoke all on function public.set_store_ecpay_credentials(
  bigint, text, text, text, text, text, text, text, text, text, integer, boolean
) from public, anon;
grant execute on function public.set_store_ecpay_credentials(
  bigint, text, text, text, text, text, text, text, text, text, integer, boolean
) to authenticated;
