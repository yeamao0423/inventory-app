import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error('請在 .env 檔案設定 VITE_SUPABASE_URL 和 VITE_SUPABASE_ANON_KEY')
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// ── 角色定義 ────────────────────────────────────────
// admin  → 全部功能（新增/刪除/匯率設定）
// editor → 新增+編輯庫存、訂單、付款
// viewer → 只能查看，不能修改

export const ROLES = {
  ADMIN: 'admin',
  EDITOR: 'editor',
  VIEWER: 'viewer',
}

export const ROLE_LABELS = {
  admin: '管理員',
  editor: '編輯',
  viewer: '檢視者',
}
