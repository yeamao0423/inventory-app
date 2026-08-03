// 預覽頁的身分閘門（草稿預覽與即時預覽共用）。
//
// 草稿不公開。預覽不是靠「網址難猜」保護，而是每次都要求呼叫者帶著自己的 Supabase JWT，
// 在 server 端用那顆 token 建 client（RLS 視角＝該使用者），再確認他確實是這家店的後台成員。
// 與 app/api/revalidate 同一套做法：不用靜態密鑰（後台是 client SPA，靜態密鑰會被打包外洩）。
import { createClient } from '@supabase/supabase-js'

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SB_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

export const previewConfigured = !!(SB_URL && SB_KEY)

/** 用呼叫者的 token 建 client → 之後所有查詢都在他的 RLS 視角底下跑 */
export function previewClient(token) {
  if (!previewConfigured || !token) return null
  return createClient(SB_URL, SB_KEY, { global: { headers: { Authorization: `Bearer ${token}` } } })
}

/** 這顆 token 的主人是不是這家店的後台成員（RLS 允許讀自己的 roles） */
export async function isStoreMember(sb, userId, storeId) {
  const { data } = await sb
    .from('user_store_roles').select('role')
    .eq('user_id', userId).eq('store_id', storeId)
    .in('role', ['super_admin', 'admin', 'editor'])
    .maybeSingle()
  return !!data
}
