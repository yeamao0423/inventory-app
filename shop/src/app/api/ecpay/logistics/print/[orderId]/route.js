// 列印託運單／繳款單：依訂單的超商子類型路由到對應列印 API，
// 回「自動送出表單」的 HTML（含寄件編號與驗證碼），由後台寫進新開的分頁。
//
// 為什麼是 POST 而不是 GET：這段 HTML 的 hidden input 就是寄件編號與驗證碼，
// 外洩等同任何人都能冒寄／冒領，所以必須驗證後台身分＋店家角色，而 GET
// （後台原本用 window.open 開新分頁）帶不了 Authorization 標頭。
// 後台改成 fetch POST 拿到 HTML 後，再 window.open('', '_blank') + document.write。
// 注意：那個新分頁仍是「頂層視窗」而非 iframe——綠界的導轉阻擋因此不會觸發，
// 這正是原本不能用 iframe 的理由，改法務必保住這點。
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '../../../../../../lib/supabase-admin'
import { loadOrderForEcpay } from '../../../../../../lib/ecpayStore'
import {
  getPrintUrl,
  genLogisticsCheckMac,
  buildAutoSubmitForm,
  logisticsUnavailableMessage,
} from '../../../../../../lib/ecpay'

export const dynamic = 'force-dynamic'

// 後台（Vite，不同網域）跨域呼叫，preflight 要放行 Authorization。
const corsHeaders = {
  'Access-Control-Allow-Origin': process.env.ADMIN_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
}

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

export async function OPTIONS() {
  return NextResponse.json(null, { headers: corsHeaders })
}

function fail(msg, status = 400) {
  return NextResponse.json({ ok: false, error: msg }, { status, headers: corsHeaders })
}

// 後台身分驗證：用呼叫者的 Supabase JWT 建 anon client（同 send-status-email 的 P0-1 做法）。
async function authCaller(request) {
  const jwt = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  if (!jwt) return { error: '未授權（缺少登入憑證）', status: 401 }
  if (!SUPA_URL || !ANON) return { error: '伺服器未設定（缺少 Supabase 連線設定）', status: 500 }
  const sb = createClient(SUPA_URL, ANON, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  })
  const { data } = await sb.auth.getUser()
  const user = data?.user
  if (!user) return { error: '未授權（登入憑證無效）', status: 401 }
  return { sb, user }
}

// 角色驗證：store_id 一律取自 DB 上的訂單，不信任前端傳入的任何店家識別。
async function hasStoreRole(sb, user, storeId) {
  const { data } = await sb
    .from('user_store_roles').select('role')
    .eq('user_id', user.id).eq('store_id', storeId)
    .in('role', ['super_admin', 'admin', 'editor'])
    .maybeSingle()
  return !!data
}

// N6：只查 store_id，趕在載入訂單其餘欄位（與綠界設定）之前先驗角色。
// 訂單不存在／角色不符統一回同一句訊息，避免用「找不到訂單」跟「無權限」
// 的訊息差異當 oracle，讓登入中的任何使用者可以枚舉全平台的訂單 id 分佈。
async function loadOrderStoreId(orderId) {
  const { data } = await supabaseAdmin
    .from('consumer_orders')
    .select('id, store_id')
    .eq('id', orderId)
    .maybeSingle()
  return data
}

export async function POST(request, { params }) {
  const { sb, user, error: authError, status: authStatus } = await authCaller(request)
  if (authError) return fail(authError, authStatus)

  // N6：先只用 store_id 驗角色。訂單不存在與角色不符回同一句、同一個狀態碼，
  // 角色驗證通過之後才載入訂單其餘欄位與該店的綠界設定。
  const minimalOrder = await loadOrderStoreId(params.orderId)
  if (!minimalOrder || !(await hasStoreRole(sb, user, minimalOrder.store_id))) {
    return fail('找不到訂單或無權限', 404)
  }

  let order, cfg, error
  try {
    ({ order, cfg, error } = await loadOrderForEcpay(
      params.orderId,
      'id, store_id, shipping_subtype, allpay_logistics_id, cvs_payment_no, cvs_validation_no'
    ))
  } catch (e) {
    // makeEcpayConfig 在正式環境「金流」金鑰不完整時會 throw，寧可失敗也不要用公開測試金鑰
    return fail(e.message, 500)
  }
  if (error) return fail(error)

  // 物流金鑰是延後檢查的（見 lib/ecpay.js makeEcpayConfig）——沒有就不可能算出正確 CheckMacValue
  const logisticsBlocked = logisticsUnavailableMessage(cfg)
  if (logisticsBlocked) return fail(logisticsBlocked)

  if (!order.allpay_logistics_id) return fail('此訂單尚未建立物流單，無法列印')

  const printUrl = getPrintUrl(order.shipping_subtype, cfg)
  if (!printUrl) return fail(`不支援的物流類型：${order.shipping_subtype}`)

  const printParams = {
    MerchantID: cfg.logisticsMerchantId,
    AllPayLogisticsID: order.allpay_logistics_id,
    CVSPaymentNo: order.cvs_payment_no || '',
  }
  // 7-ELEVEN C2C 需要驗證碼
  if (order.shipping_subtype === 'UNIMARTC2C') {
    printParams.CVSValidationNo = order.cvs_validation_no || ''
  }
  printParams.CheckMacValue = genLogisticsCheckMac(printParams, cfg)

  const html = buildAutoSubmitForm(printUrl, printParams, { title: '產生託運單...' })
  return new Response(html, {
    headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' },
  })
}
