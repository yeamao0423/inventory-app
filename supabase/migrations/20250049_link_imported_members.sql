-- 匯入名單回連原生會員：修復「先在原生商城註冊、後匯入外部平台(如 Shopline)名單」時，
-- 兩邊（原生會員 store_consumers ↔ imported_members）永遠接不起來的問題。
--
-- 背景：
--   promote_member() 只在「消費者登入/造訪商城」時觸發，用 auth.uid() 合併尚未晉升的
--   匯入名單（取跨平台最早 registered_at、累加 imported_amount/orders）。
--   但 import_members() 過去只做 INSERT，不會回頭去連結「email 已對應到既有原生會員」的
--   匯入列。因此當使用者「先原生註冊、後匯入」時，imported_amount 與更早的註冊時間懸空，
--   會員的累計消費金額算不到身上（member_qualifying 用較晚的原生 registered_at 當時間切點，
--   還會誤殺註冊前的訪客訂單）。
--
-- 解法：
--   1) 新增可重複執行(idempotent)的 link_imported_members()，把「email 已對應到本店原生會員
--      (已有 store_consumers)」的未晉升匯入列，套用與 promote_member 相同的合併邏輯。
--   2) import_members() 於 INSERT 後呼叫它，讓匯入不論早於或晚於原生註冊都會自動接起來。
--   3) 檔尾對現有孤兒資料回填一次。

-- 1) 回連函數：只認 promoted_consumer_id IS NULL 的匯入列，重複執行安全。
CREATE OR REPLACE FUNCTION public.link_imported_members(p_store_id bigint)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_im    record;
  v_count int := 0;
BEGIN
  FOR v_im IN
    SELECT im.*, c.id AS match_consumer_id
    FROM public.imported_members im
    JOIN public.consumers c
      ON public.normalize_email(c.email) = public.normalize_email(im.email)
    JOIN public.store_consumers sc
      ON sc.store_id = im.store_id AND sc.consumer_id = c.id
    WHERE im.store_id = p_store_id
      AND im.promoted_consumer_id IS NULL
  LOOP
    -- 合併進該原生會員的 store_consumers（與 promote_member 相同語意）
    UPDATE public.store_consumers sc
    SET registered_at   = LEAST(COALESCE(sc.registered_at, v_im.registered_at),
                                COALESCE(v_im.registered_at, sc.registered_at)),
        imported_amount = sc.imported_amount + v_im.imported_amount,
        imported_orders = sc.imported_orders + v_im.imported_orders,
        member_level_id = COALESCE(sc.member_level_id, v_im.manual_level_id)
    WHERE sc.store_id = p_store_id AND sc.consumer_id = v_im.match_consumer_id;

    UPDATE public.imported_members
    SET promoted_consumer_id = v_im.match_consumer_id, updated_at = now()
    WHERE id = v_im.id;

    v_count := v_count + 1;
  END LOOP;

  IF v_count > 0 THEN
    PERFORM public.recalc_member_level(p_store_id, NULL);
  END IF;

  RETURN v_count;
END;
$function$;

-- 內部維運函數，不開放給 anon/PUBLIC 直接呼叫（由 import_members 內部呼叫，SECURITY DEFINER）。
REVOKE EXECUTE ON FUNCTION public.link_imported_members(bigint) FROM PUBLIC, anon;

-- 2) import_members()：沿用既有定義，於 INSERT 後新增一行回連呼叫。
CREATE OR REPLACE FUNCTION public.import_members(p_store_id bigint, p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_count int := 0;
BEGIN
  IF NOT public.has_store_role(p_store_id, ARRAY['super_admin','admin']) THEN
    RAISE EXCEPTION '無權限匯入此店會員';
  END IF;

  INSERT INTO public.imported_members (
    store_id, source, external_id, email, name, phone,
    registered_at, imported_amount, imported_orders, accepts_marketing
  )
  SELECT
    p_store_id,
    COALESCE(r->>'source', 'shopline'),
    r->>'external_id',
    public.normalize_email(r->>'email'),
    NULLIF(r->>'name', ''),
    NULLIF(r->>'phone', ''),
    (r->>'registered_at')::timestamptz,
    COALESCE((r->>'imported_amount')::numeric, 0),
    COALESCE((r->>'imported_orders')::int, 0),
    CASE WHEN r->>'accepts_marketing' IS NULL THEN NULL
         ELSE (r->>'accepts_marketing')::boolean END
  FROM jsonb_array_elements(p_rows) AS r
  WHERE r->>'email' IS NOT NULL AND trim(r->>'email') <> ''
  ON CONFLICT (store_id, source, external_id) DO UPDATE SET
    email = EXCLUDED.email,
    name = EXCLUDED.name,
    phone = EXCLUDED.phone,
    imported_amount = EXCLUDED.imported_amount,
    imported_orders = EXCLUDED.imported_orders,
    accepts_marketing = EXCLUDED.accepts_marketing,
    registered_at = COALESCE(public.imported_members.registered_at, EXCLUDED.registered_at), -- 不重置
    updated_at = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- 回連：把 email 已對應到本店既有原生會員的匯入列即時合併，
  -- 使「先原生註冊、後匯入」也能正確算入消費金額與跨平台最早註冊時間。
  PERFORM public.link_imported_members(p_store_id);

  RETURN jsonb_build_object('ok', true, 'processed', v_count);
END;
$function$;

-- 3) 回填：一次修復目前所有「未晉升、但 email 已對應到既有原生會員」的孤兒匯入列。
SELECT public.link_imported_members(s.store_id)
FROM (
  SELECT DISTINCT store_id
  FROM public.imported_members
  WHERE promoted_consumer_id IS NULL
) s;
