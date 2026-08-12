-- consumer_orders：擋住「訂單本人可以改任意欄位」的既有 RLS 洞
--
-- ══ 問題 ══════════════════════════════════════════════════════
-- 20250029_rls_rpc_hardening.sql:105-111 的 UPDATE policy：
--   USING/WITH CHECK ( has_store_role(store_id, ARRAY['super_admin','admin','editor'])
--                      OR email = ((SELECT auth.jwt()) ->> 'email') )
-- RLS 只能決定「這一列給不給改」，不能決定「哪些欄位給改」。所以任何登入的商城會員
-- 在瀏覽器 console 執行一行：
--   await supabase.from('consumer_orders').update({ paid_amount: 99999 }).eq('id', 自己的訂單)
-- sync_payment_status trigger 就會把 payment_status 推成「已付清」，然後照常出貨。
-- 綠界串接做完之後 paid_amount 是刷卡與代收金額的唯一真相來源，也是棄單清理與出貨判斷
-- 的依據，所以這條路徑等於金流的正門。同一條路還能改 items_json（觸發 reconcile_stock
-- 去動別人的庫存）、total_amount、status、trip_id、stock_committed（改大再取消，
-- 讓 trigger 回補從來沒佔用過的庫存）。
--
-- ══ 修法 ══════════════════════════════════════════════════════
-- 加一支 BEFORE UPDATE trigger 做欄位層級的守衛。三段放行、一段收斂：
--   1) auth.uid() IS NULL → service role、pg_cron、直連 DB 的維運，放行
--   2) current_user 不是 authenticated/anon → 放行
--   3) 本店店員（或平台管理員）→ 放行
--   4) 其餘（＝訂單本人這條路徑）→ 只准把 status 從非取消狀態改成 '已取消'
--
-- 第 2 條是這支 trigger 能不破壞既有功能的關鍵：
-- PostgREST 只有在幫前端做「直接對表 CRUD」時才會把角色切成 authenticated/anon；
-- SECURITY DEFINER 的 RPC 執行時 current_user 是函式 owner（postgres）。所以
--   - append_to_order（GRANT 給 anon/authenticated，會改 items_json/total_amount/updated_at）
--   - apply_ecpay_payment / apply_cod_payment / refund_coupon / cancel_abandoned_credit_orders
--   - reconcile_order_stock 對 stock_committed 的回寫（它自己就是 SECURITY DEFINER）
-- 全部不受影響；只有「瀏覽器直接打 PostgREST 改表」這條路會被收斂。
-- 這正好對應這個洞的攻擊面：消費者手上只有直接改表這一招，RPC 是被審過的程式碼。
--
-- 用 OLD.store_id 而不是 NEW.store_id 判斷店員身分：那是「這筆資料屬於誰」的判準。
-- 若用 NEW.store_id，在別家店有身分的人只要把 store_id 一起改成那家店就能整段繞過。
--
-- ══ 為什麼用「差集」而不是白名單逐欄比對 ══════════════════════
-- 比對 to_jsonb(OLD) 與 to_jsonb(NEW) 找出有變動的鍵，扣掉允許的那個，剩下不為空就 raise。
-- 未來 consumer_orders 加欄位時不必回頭改這支 trigger——白名單式的逐欄比對會在加欄位時
-- 默默失守，而這張表這半年已經加了 ecpay 相關的 8 個欄位。
--
-- ══ 排除的欄位：只有 payment_status ══════════════════════════
-- 掛在 public.consumer_orders 上的 trigger 共 7 支（pg_trigger 查證）：
--   BEFORE INSERT       trg_assign_store_order_no
--   BEFORE INSERT/UPDATE consumer_orders_payment_status（sync_payment_status）
--   BEFORE INSERT/UPDATE OF shipping_subtype  trg_snapshot_order_shipping_cost
--   AFTER  INSERT/UPDATE OF items_json/status reconcile_stock
--   AFTER  INSERT/UPDATE OF items_json        trg_snapshot_order_item_costs
--   AFTER  INSERT/UPDATE                      trg_recalc_member_level_upd
--   AFTER  INSERT                             trg_recalc_member_level_ins
-- 其中會在「同一個 UPDATE 語句內」改動 NEW 欄位、又比本 trigger 早執行的，只有
-- sync_payment_status（'consumer_orders_payment_status' 字母序早於 'trg_...'）。
-- 它一定會把 NEW.payment_status 覆寫成 derive_payment_status(NEW.paid_amount, NEW.total_amount)，
-- 而 20250054 的「已付清訂單退款後鎖住狀態」讓 OLD.payment_status 可能是被鎖住的舊值——
-- 於是一次單純的取消也會讓 payment_status 從「已付清」翻成「部分付款」。
-- 不排除它，本人取消訂單會被自己擋下。排除它也不會開後門：它的值完全由
-- paid_amount / total_amount 推導，而這兩欄已經被本 trigger 凍結，消費者送什麼進來都會被覆寫。
--
-- 其餘欄位一律不排除：
--   - updated_at 這張表**沒有**自動維護的 trigger（沒有 moddatetime），只有 append_to_order
--     這類 RPC 會明寫，而 RPC 走第 2 條放行，所以不需要排除；商城端的取消
--     （shop/src/app/account/page.jsx:93 的 .update({ status: '已取消' })）也沒有帶它。
--   - stock_committed 由 reconcile_order_stock 以 SECURITY DEFINER 另一句 UPDATE 寫回，
--     走第 2 條放行。**刻意不排除**：若排除，消費者可以先把 stock_committed 灌大再取消，
--     讓 trigger 回補從來沒佔用過的庫存。
--   - shipping_cost 只在 shipping_subtype 變動時由 trg_snapshot_order_shipping_cost 寫入，
--     而那支比本 trigger 晚執行（'trg_c...' < 'trg_s...'），且 shipping_subtype 本身已被擋。

create or replace function public.guard_consumer_order_update()
returns trigger
language plpgsql
-- 刻意**不是** SECURITY DEFINER：本函式必須看得到真正的 current_user，
-- 才能分辨「瀏覽器直接改表」與「SECURITY DEFINER RPC 內部改表」。
set search_path to 'public'
as $$
declare
  v_old     jsonb;
  v_new     jsonb;
  v_changed text[];
begin
  -- 1) 無 JWT ＝ service role／pg_cron／直連 DB 的內部呼叫
  if auth.uid() is null then
    return new;
  end if;

  -- 2) 不是 PostgREST 幫前端做的「直接對表 UPDATE」
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  -- 3) 本店店員或平台管理員
  if coalesce(public.has_store_role(old.store_id, array['super_admin','admin','editor']), false)
     or coalesce(public.is_platform_admin(), false) then
    return new;
  end if;

  -- 4) 訂單本人：只准取消
  v_old := to_jsonb(old);
  v_new := to_jsonb(new);

  select coalesce(array_agg(e.key order by e.key), '{}'::text[])
    into v_changed
    from jsonb_each(v_new) as e
   where e.value is distinct from (v_old -> e.key)
     and e.key <> 'payment_status';

  if array_length(v_changed, 1) is null then
    return new;                       -- 實際上什麼都沒變
  end if;

  if array_length(v_changed, 1) = 1
     and v_changed[1] = 'status'
     and new.status = '已取消'
     and coalesce(old.status, '') <> '已取消' then
    return new;
  end if;

  raise exception '訂單只能由本人取消（把狀態改成「已取消」），其他欄位請聯繫店家處理。這次試圖變更：%',
    array_to_string(v_changed, '、');
end $$;

-- trigger 觸發不檢查 invoker 的 EXECUTE（只在 CREATE TRIGGER 當下檢查），
-- 所以這裡照 20250029 B1 的慣例把函式從 PUBLIC 收回，不影響觸發。
revoke execute on function public.guard_consumer_order_update() from public, anon, authenticated;

-- 名稱刻意排在 'trg_snapshot_order_shipping_cost' 之前、
-- 'consumer_orders_payment_status' 之後（BEFORE trigger 依名稱字母序執行）。
drop trigger if exists trg_consumer_order_update_guard on public.consumer_orders;
create trigger trg_consumer_order_update_guard
before update on public.consumer_orders
for each row execute function public.guard_consumer_order_update();
