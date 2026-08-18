-- 手動寫 history 的段落交給 20260818100000 新增的 trigger 自動處理，
-- 這裡的 UPDATE stock/quantity 現在會自動觸發 log_stock_change()，
-- 原本的手動 INSERT INTO history 拿掉，否則同一次入庫/退庫會重複寫兩筆。

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
    END LOOP;
  END IF;

  -- procurement_items 有 ON DELETE CASCADE
  DELETE FROM public.procurement_batches WHERE id = p_batch_id;

  RETURN jsonb_build_object('ok', true, 'reverted', v_batch.inventory_synced IS TRUE);
END $$;
