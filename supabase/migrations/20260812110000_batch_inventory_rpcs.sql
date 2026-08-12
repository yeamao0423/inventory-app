-- ══════════════════════════════════════════════════════════════
-- 批次入庫／退庫／行程批次
--
-- 入庫改成 DB 端 stock = stock + n，取代前端的讀-改-寫
-- （原 src/components/ProcurementBatchTab.jsx:589 連點會重複計數）。
-- 防重入靠 UPDATE ... WHERE inventory_synced IS NOT TRUE 的受影響列數，
-- 不靠前端旗標。
-- ══════════════════════════════════════════════════════════════

-- 這三支 RPC 是後台專用，且都是 SECURITY DEFINER —— 繞過 RLS，所以必須自己擋權限。
-- 本系統的消費者（consumers）也是 authenticated 身分，不擋的話任何登入者只要猜到
-- batch id，就能把別家店的批次入庫、刪掉，連帶改動對方庫存。
--
-- auth.uid() 為 NULL 只會發生在直連 DB 或 service_role（SQL 測試、後端維運），
-- 這兩者本來就有完整權限，放行。anon 沒有 EXECUTE 權限，到不了這裡。
CREATE OR REPLACE FUNCTION public.assert_store_admin(p_store_id bigint)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN; END IF;
  IF public.is_platform_admin() THEN RETURN; END IF;
  IF public.has_store_role(p_store_id, ARRAY['super_admin', 'admin', 'editor']) THEN RETURN; END IF;
  RAISE EXCEPTION '沒有權限操作這家店的採購批次';
END $$;

CREATE OR REPLACE FUNCTION public.receive_batch_inventory(p_batch_id bigint)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_store_id bigint;
  v_updated  integer;
  v_item     record;
BEGIN
  SELECT store_id INTO v_store_id
    FROM public.procurement_batches WHERE id = p_batch_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', '批次不存在');
  END IF;
  PERFORM public.assert_store_admin(v_store_id);

  UPDATE public.procurement_batches
     SET inventory_synced = true
   WHERE id = p_batch_id
     AND inventory_synced IS NOT TRUE;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RETURN jsonb_build_object('ok', true, 'already_synced', true);
  END IF;

  FOR v_item IN
    SELECT product_id, variant_id, COALESCE(actual_qty, 0) AS qty
      FROM public.procurement_items
     WHERE batch_id = p_batch_id
       AND status IN ('bought', 'partial')
       AND COALESCE(actual_qty, 0) > 0
     ORDER BY product_id, variant_id
  LOOP
    IF v_item.variant_id IS NOT NULL THEN
      UPDATE public.product_variants SET stock = stock + v_item.qty WHERE id = v_item.variant_id;
    ELSE
      UPDATE public.products SET quantity = quantity + v_item.qty WHERE id = v_item.product_id;
    END IF;

    -- history.store_id 是 NOT NULL，批次的 store_id 可為空，落回商品的
    INSERT INTO public.history (product_id, change, reason, store_id)
    SELECT v_item.product_id, v_item.qty,
           '採購入庫（批次 #' || p_batch_id || '）',
           COALESCE(v_store_id, p.store_id)
      FROM public.products p WHERE p.id = v_item.product_id;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'already_synced', false);
END $$;

CREATE OR REPLACE FUNCTION public.delete_batch(p_batch_id bigint)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_batch  public.procurement_batches;
  v_item   record;
BEGIN
  SELECT * INTO v_batch FROM public.procurement_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', '批次不存在');
  END IF;
  PERFORM public.assert_store_admin(v_batch.store_id);

  IF v_batch.inventory_synced IS TRUE THEN
    FOR v_item IN
      SELECT product_id, variant_id, COALESCE(actual_qty, 0) AS qty
        FROM public.procurement_items
       WHERE batch_id = p_batch_id
         AND status IN ('bought', 'partial')
         AND COALESCE(actual_qty, 0) > 0
       ORDER BY product_id, variant_id
    LOOP
      IF v_item.variant_id IS NOT NULL THEN
        UPDATE public.product_variants SET stock = stock - v_item.qty WHERE id = v_item.variant_id;
      ELSE
        UPDATE public.products SET quantity = quantity - v_item.qty WHERE id = v_item.product_id;
      END IF;

      INSERT INTO public.history (product_id, change, reason, store_id)
      SELECT v_item.product_id, -v_item.qty,
             '取消批次退庫（批次 #' || p_batch_id || '）',
             COALESCE(v_batch.store_id, p.store_id)
        FROM public.products p WHERE p.id = v_item.product_id;
    END LOOP;
  END IF;

  -- procurement_items 有 ON DELETE CASCADE
  DELETE FROM public.procurement_batches WHERE id = p_batch_id;

  RETURN jsonb_build_object('ok', true, 'reverted', v_batch.inventory_synced IS TRUE);
END $$;

-- 行程批次：以庫存為概念，建立當下就入庫。批次、品項、庫存全在同一個交易內。
CREATE OR REPLACE FUNCTION public.create_trip_batch(
  p_store_id   bigint,
  p_trip_id    bigint,
  p_batch_date date,
  p_buyer_id   uuid,
  p_manager_id uuid,
  p_note       text,
  p_source     text,
  p_items      jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_batch_id bigint;
  v_item     jsonb;
BEGIN
  PERFORM public.assert_store_admin(p_store_id);

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', '沒有要入庫的品項');
  END IF;

  INSERT INTO public.procurement_batches
    (store_id, batch_date, source, buyer_id, manager_id, note, status, trip_id, inventory_synced)
  VALUES
    (p_store_id, p_batch_date, COALESCE(p_source, '行程採購'), p_buyer_id, p_manager_id,
     p_note, 'done', p_trip_id, false)
  RETURNING id INTO v_batch_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    CONTINUE WHEN COALESCE((v_item->>'qty')::integer, 0) <= 0;
    INSERT INTO public.procurement_items
      (batch_id, product_id, variant_id, quantity, actual_qty, unit_cost, currency, paid_by, status)
    VALUES (
      v_batch_id,
      (v_item->>'productId')::bigint,
      NULLIF(v_item->>'variantId', '')::bigint,
      (v_item->>'qty')::integer,
      (v_item->>'qty')::integer,
      COALESCE((v_item->>'cost')::numeric, 0),
      COALESCE(NULLIF(v_item->>'currency', ''), 'TWD'),
      p_buyer_id,
      'bought'
    );
  END LOOP;

  PERFORM public.receive_batch_inventory(v_batch_id);

  RETURN jsonb_build_object('ok', true, 'batch_id', v_batch_id);
END $$;

GRANT EXECUTE ON FUNCTION public.assert_store_admin(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.receive_batch_inventory(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_batch(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_trip_batch(bigint, bigint, date, uuid, uuid, text, text, jsonb) TO authenticated;
