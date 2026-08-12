-- ══════════════════════════════════════════════════════════════
-- 商城綠界金物流的「啟用」開關
--
-- 為什麼要跟「金鑰已設定」分開：設好金鑰不等於想立刻對外開放。
-- 店家會需要先把金鑰填好、在後台把物流單流程走過一遍，確認沒問題才對消費者開。
-- 現在 ecpay_set 一為 true，結帳頁就立刻出現信用卡與貨到付款，沒有緩衝。
--
-- 這支只翻 stores.settings.ecpay_enabled 這個非機密旗標，不碰金鑰，
-- 所以不需要重貼 set_store_ecpay_credentials 那支（它已經很大）。
-- 授權判準與金鑰設定一致：僅平台管理員。
-- ══════════════════════════════════════════════════════════════

create or replace function public.set_store_ecpay_enabled(
  p_store_id bigint,
  p_enabled  boolean
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not public.is_platform_admin() then
    raise exception '僅平台管理員可切換綠界啟用狀態';
  end if;

  update public.stores
     set settings = coalesce(settings, '{}'::jsonb)
                    || jsonb_build_object('ecpay_enabled', coalesce(p_enabled, false))
   where id = p_store_id;
end $$;

revoke all on function public.set_store_ecpay_enabled(bigint, boolean) from public, anon;
grant execute on function public.set_store_ecpay_enabled(bigint, boolean) to authenticated;
