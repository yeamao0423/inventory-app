-- N2：ecpay_set=true 不代表金流三欄都有值
--
-- set_store_ecpay_credentials（20260812170300）首次 insert 時 merchant_id／
-- hash_key／hash_iv 用 '' 頂著（not null 欄位），但收尾一律把 ecpay_set 設成
-- true，沒有檢查這三欄「upsert 之後」是否真的都有值。makeEcpayConfig（生產
-- 環境）對空字串會 fail-closed 直接 throw，方向是對的，但旗標沒跟著——於是
-- 平台管理員漏貼 HashKey 時：ecpay_set=true → 結帳頁顯示信用卡選項 → 消費者
-- 下單成功、庫存被佔用 → 導轉到綠界建立付款頁時才撞到金鑰不完整的錯誤頁。
--
-- 修法：照抄 v_logistics_set 的算法，比照算一個 v_payment_set（merchant_id／
-- hash_key／hash_iv 三欄皆非空字串），用它取代寫死的 true。
--
-- 整支重貼自 20260812170300（同一組 12 個參數），只改 v_payment_set 這段與
-- 對應的 settings 寫入，其餘邏輯不動。
drop function if exists public.set_store_ecpay_credentials(
  bigint, text, text, text, text, text, text, text, text, text, integer, boolean
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
  v_hash_key text;
  v_hash_iv text;
  v_logistics_merchant_id text;
  v_logistics_hash_key text;
  v_logistics_hash_iv text;
  v_logistics_set boolean;
  v_payment_set boolean;
begin
  if not public.is_platform_admin() then
    raise exception '僅平台管理員可設定綠界金鑰';
  end if;

  -- 清除整組設定：只能由 p_clear 顯式觸發，不再由「特店編號留空」隱含觸發
  if p_clear then
    delete from public.store_ecpay_secrets where store_id = p_store_id;
    update public.stores
    set settings = (coalesce(settings, '{}'::jsonb) || jsonb_build_object('ecpay_set', false, 'ecpay_logistics_set', false))
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

  select merchant_id, hash_key, hash_iv,
         logistics_merchant_id, logistics_hash_key, logistics_hash_iv
    into v_merchant_id, v_hash_key, v_hash_iv,
         v_logistics_merchant_id, v_logistics_hash_key, v_logistics_hash_iv
  from public.store_ecpay_secrets where store_id = p_store_id;

  -- 物流是否就緒：三欄（特店編號／HashKey／HashIV）在這次 upsert 之後是否全部有值。
  v_logistics_set := v_logistics_merchant_id is not null
                      and v_logistics_hash_key is not null
                      and v_logistics_hash_iv is not null;

  -- (N2) 金流是否就緒：同一套算法，三欄皆非空字串才算數。首次 insert 時
  -- hash_key/hash_iv 可能被 '' 頂著（沒 not null 擋不了），這裡要當作「沒填」。
  v_payment_set := v_merchant_id is not null and length(v_merchant_id) > 0
                    and v_hash_key is not null and length(v_hash_key) > 0
                    and v_hash_iv is not null and length(v_hash_iv) > 0;

  -- 非機密旗標＋兩個特店編號進 settings：特店編號本來就會出現在送往綠界的付款表單裡
  -- （消費者瀏覽器看得到），不算機密，讓後台能顯示目前掛的是哪一組帳號。
  -- HashKey/HashIV/寄件人資訊絕對不可以放進 settings —— 那會整包送到商城前端給匿名訪客。
  update public.stores
  set settings = coalesce(settings, '{}'::jsonb)
                 || jsonb_build_object(
                      'ecpay_set', v_payment_set,
                      'ecpay_env', v_env,
                      'ecpay_cod_max', v_cod,
                      'ecpay_merchant_id', v_merchant_id,
                      'ecpay_logistics_merchant_id', v_logistics_merchant_id,
                      'ecpay_logistics_set', v_logistics_set
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
