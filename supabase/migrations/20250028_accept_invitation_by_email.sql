-- 以登入者「已驗證的 email」認領 pending 邀請，不依賴網址 token。
-- 解決：驗證信導回時掉了 token、或使用者在沒有 token 的分頁登入 → 角色補不上、被誤判為消費者。
-- 安全性優於 token：token 可被轉傳，email 由 Supabase 驗證為本人。
CREATE OR REPLACE FUNCTION public.accept_invitation_by_email()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_email text;
  v_inv   invitations%ROWTYPE;
  v_count int := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', '請先登入');
  END IF;

  SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();
  IF v_email IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', '找不到帳號');
  END IF;

  -- 認領該 email 名下所有未過期、未使用的邀請（可能跨多店）
  FOR v_inv IN
    SELECT * FROM invitations
    WHERE lower(email) = lower(v_email)
      AND status = 'pending'
      AND expires_at >= now()
    FOR UPDATE
  LOOP
    INSERT INTO user_store_roles (user_id, store_id, role)
    VALUES (auth.uid(), v_inv.store_id, v_inv.role)
    ON CONFLICT (user_id, store_id) DO UPDATE SET role = EXCLUDED.role;

    UPDATE invitations SET status = 'accepted' WHERE id = v_inv.id;
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'accepted', v_count);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.accept_invitation_by_email() FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.accept_invitation_by_email() TO authenticated;
