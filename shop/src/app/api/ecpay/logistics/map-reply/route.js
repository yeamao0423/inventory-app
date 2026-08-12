// 電子地圖 ServerReplyURL：綠界選完門市後 POST 回門市資訊。
// 導回結帳頁並把門市資訊帶在 query，結帳頁再從 sessionStorage 還原表單。
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST(request) {
  const form = await request.formData()
  const origin = new URL(request.url).origin

  const q = new URLSearchParams({
    cvs_store_id: form.get('CVSStoreID') || '',
    cvs_store_name: form.get('CVSStoreName') || '',
    cvs_address: form.get('CVSAddress') || '',
    cvs_subtype: form.get('LogisticsSubType') || '',
  })

  return NextResponse.redirect(`${origin}/checkout?${q.toString()}`, 303)
}
