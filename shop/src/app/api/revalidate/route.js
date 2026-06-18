// 後台清除商城快取的端點。
// 安全：用呼叫者的 Supabase JWT 驗證身分 + 確認他是該店後台成員（super_admin/admin/editor），
//       不使用靜態密鑰（後台是 client SPA，靜態密鑰會被打包外洩）。
// 動作：revalidateTag(`store-${storeId}`) 會清掉這家店的商品列表、商品詳情、店家資訊快取。
import { NextResponse } from 'next/server'
import { revalidateTag } from 'next/cache'
import { createClient } from '@supabase/supabase-js'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

// 後台（不同網域的 client SPA）會跨來源呼叫 → 需要 CORS。
// 端點本身有 JWT + 成員身分驗證，故允許任意來源 POST 是安全的。
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS })
}

export async function POST(req) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  const { storeId, productIds, slug } = await req.json().catch(() => ({}))

  if (!token || storeId == null) {
    return NextResponse.json({ ok: false, error: 'missing token or storeId' }, { status: 400, headers: CORS })
  }
  if (!URL || !ANON) {
    return NextResponse.json({ ok: false, error: 'server not configured' }, { status: 500, headers: CORS })
  }

  // 用呼叫者的 token 建 client → RLS 視角即為該使用者
  const sb = createClient(URL, ANON, { global: { headers: { Authorization: `Bearer ${token}` } } })

  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401, headers: CORS })

  // 確認此 user 是該店後台成員（RLS 允許讀自己的 roles）
  const { data: role } = await sb
    .from('user_store_roles').select('role')
    .eq('user_id', user.id).eq('store_id', storeId)
    .in('role', ['super_admin', 'admin', 'editor'])
    .maybeSingle()
  if (!role) return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403, headers: CORS })

  // 清快取：store tag 會涵蓋列表/詳情/店家資訊；slug/domain 視情況一併清
  const tags = [`store-${storeId}`]
  if (slug) tags.push(`store-slug-${slug}`)
  if (Array.isArray(productIds)) productIds.forEach(id => tags.push(`product-${id}`))
  tags.forEach(t => revalidateTag(t))

  return NextResponse.json({ ok: true, revalidated: tags }, { headers: CORS })
}
