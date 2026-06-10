-- ══════════════════════════════════════════════
-- 消費者角色分離 Migration
-- 在 Supabase Dashboard > SQL Editor 執行此檔案
-- ══════════════════════════════════════════════

-- ── Step 1：擴充 role check constraint，加入 consumer ──

ALTER TABLE user_store_roles DROP CONSTRAINT IF EXISTS user_store_roles_role_check;
ALTER TABLE user_store_roles ADD CONSTRAINT user_store_roles_role_check
  CHECK (role IN ('super_admin', 'admin', 'editor', 'viewer', 'consumer'));


-- ── Step 2：修改 trigger，新用戶一律給 consumer ──

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.profiles (id, name, email)
  VALUES (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', new.email),
    new.email
  )
  ON CONFLICT (id) DO NOTHING;

  -- 預設一律 consumer，後台透過 Edge Function 或邀請流程升級
  INSERT INTO public.user_store_roles (user_id, store_id, role)
  VALUES (new.id, 1, 'consumer')
  ON CONFLICT (user_id, store_id) DO NOTHING;

  RETURN new;
END;
$$;


-- ── Step 3：將既有非邀請的 viewer 轉為 consumer ──
-- 邏輯：如果 user_id 在 invitations 中有 accepted 記錄，表示是受邀成員，不轉換
-- 如果 role 是 viewer 且沒有邀請記錄，就轉為 consumer

UPDATE user_store_roles
SET role = 'consumer'
WHERE role = 'viewer'
  AND store_id = 1
  AND user_id NOT IN (
    SELECT DISTINCT au.id
    FROM auth.users au
    JOIN invitations inv ON inv.email = au.email
    WHERE inv.status = 'accepted'
  );
