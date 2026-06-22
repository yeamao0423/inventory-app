-- ============================================
-- Migration: 邀請頁依「被邀請 email 是否已註冊」決定預設顯示登入或註冊
-- get_invitation 多回 email_registered（查 auth.users，僅針對該 token 的 email，
-- 不開放任意列舉）。SECURITY DEFINER 才能讀 auth.users。
-- 前置：20250020（get_invitation 原始定義）
-- 僅先套 local，測試過才上 remote。
-- ============================================

CREATE OR REPLACE FUNCTION public.get_invitation(p_token text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'id', i.id, 'email', i.email, 'role', i.role, 'store_id', i.store_id,
    'status', i.status, 'expires_at', i.expires_at, 'store_name', s.name,
    'email_registered', EXISTS (
      SELECT 1 FROM auth.users u WHERE lower(u.email) = lower(i.email)
    )
  )
  FROM invitations i JOIN stores s ON s.id = i.store_id
  WHERE i.token = p_token
$$;
