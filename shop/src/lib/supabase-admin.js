// 伺服器端 Supabase client（service role / secret key，繞過 RLS）
// 僅可在 API route（server）使用，切勿在 client component import。
import { createClient } from '@supabase/supabase-js'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SECRET =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  ''

export const supabaseAdmin =
  URL && SECRET
    ? createClient(URL, SECRET, { auth: { persistSession: false, autoRefreshToken: false } })
    : null
