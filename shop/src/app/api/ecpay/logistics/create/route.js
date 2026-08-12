// 後台履約：依訂單建立綠界物流單（Express/Create，C2C 超商取貨）
// 由後台按鈕手動觸發——代購是先收單後調貨，下單當下未必有貨，不可自動建單。
// 這支會實際扣該店綠界帳戶餘額。
// 貨到付款訂單 → IsCollection=Y + CollectionAmount=訂單總額（綠界代收）。
// 回傳並保存 AllPayLogisticsID / CVSPaymentNo / CVSValidationNo。
// 建單成功不改訂單 status——狀態機只在取件完成時（logistics/notify）推「完成」。
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '../../../../../lib/supabase-admin'
import { loadOrderForEcpay, callbackBaseUrl } from '../../../../../lib/ecpayStore'
import {
  genLogisticsCheckMac,
  formatEcpayDate,
  genLogisticsTradeNo,
  parseLogisticsResponse,
  logisticsUnavailableMessage,
} from '../../../../../lib/ecpay'

export const dynamic = 'force-dynamic'

// 後台（Vite，不同網域）會跨域呼叫這支；呼叫端必須帶 Authorization: Bearer <後台 JWT>，
// 所以 preflight 要放行 Authorization 標頭。
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
// 回 { sb, user } 或 { error, status }。
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

export async function POST(request) {
  if (!supabaseAdmin) return fail('伺服器未設定（缺少 service key）', 500)

  // 先驗身分再碰訂單：這支會真的向綠界建單並扣店家餘額，且回應含寄件編號與驗證碼。
  const { sb, user, error: authError, status: authStatus } = await authCaller(request)
  if (authError) return fail(authError, authStatus)

  let orderId
  try {
    ({ orderId } = await request.json())
  } catch {
    return fail('請帶入 orderId')
  }
  if (!orderId) return fail('請帶入 orderId')

  let order, cfg, error
  try {
    ({ order, cfg, error } = await loadOrderForEcpay(
      orderId,
      'id, store_id, total_amount, payment_method, shipping_subtype, cvs_store_id, customer_name, phone, email, items, allpay_logistics_id'
    ))
  } catch (e) {
    // makeEcpayConfig 在正式環境「金流」金鑰不完整時會 throw，寧可失敗也不要用公開測試金鑰
    return fail(e.message, 500)
  }
  if (error) return fail(error)

  if (!(await hasStoreRole(sb, user, order.store_id))) {
    return fail('無此店家的操作權限', 403)
  }

  // 物流金鑰是延後檢查的（金流與物流在綠界分開申請，只有金流的店照樣能刷卡），
  // 但走到這支就非有不可——沒有就給店家一句看得懂的話，別讓它爛在 CheckMacValue。
  const logisticsBlocked = logisticsUnavailableMessage(cfg)
  if (logisticsBlocked) return fail(logisticsBlocked)
  if (order.allpay_logistics_id) return fail('此訂單已建立物流單', 409)
  if (!order.shipping_subtype || !order.cvs_store_id) return fail('訂單缺少超商門市資訊')
  if (!cfg.senderName || !cfg.senderPhone) {
    return fail('此店家尚未設定綠界寄件人資訊')
  }

  const amount = Math.round(Number(order.total_amount) || 0)
  if (amount < 1 || amount > cfg.codMax) {
    return fail(`超商取貨商品金額需介於 1~${cfg.codMax.toLocaleString()} 元`)
  }

  const isCOD = order.payment_method === 'cod'
  const tradeNo = genLogisticsTradeNo(order.id)
  const goodsName = (order.items || '商品').replace(/[#&<>^'`]/g, ' ').slice(0, 50) || '商品'
  const callbackBase = callbackBaseUrl() || new URL(request.url).origin // 綠界背景通知的固定網域

  const params = {
    MerchantID: cfg.logisticsMerchantId,
    MerchantTradeNo: tradeNo,
    MerchantTradeDate: formatEcpayDate(),
    LogisticsType: 'CVS',
    LogisticsSubType: order.shipping_subtype,
    GoodsAmount: amount,
    CollectionAmount: isCOD ? amount : 0,
    IsCollection: isCOD ? 'Y' : 'N',
    GoodsName: goodsName,
    SenderName: cfg.senderName,
    SenderCellPhone: cfg.senderPhone,
    ReceiverName: order.customer_name || '',
    ReceiverCellPhone: order.phone || '',
    ReceiverEmail: order.email || '',
    ReceiverStoreID: order.cvs_store_id,
    ServerReplyURL: `${callbackBase}/api/ecpay/logistics/notify`,
  }
  params.CheckMacValue = genLogisticsCheckMac(params, cfg)

  let respText
  try {
    const resp = await fetch(cfg.urls.logisticsCreate, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    })
    respText = await resp.text()
  } catch (e) {
    return fail(`呼叫綠界失敗：${e.message}`, 502)
  }

  const parsed = parseLogisticsResponse(respText)

  // 留底
  await supabaseAdmin.from('ecpay_payment_logs').insert({
    order_id: order.id,
    source: 'logistics_create',
    trade_no: tradeNo,
    rtn_code: parsed.ok ? (parsed.params.RtnCode || null) : '0',
    rtn_msg: parsed.ok ? (parsed.params.RtnMsg || null) : parsed.error,
    mac_valid: null,
    raw: parsed.ok ? parsed.params : { error: parsed.error, raw: respText },
  })

  if (!parsed.ok) return fail(`綠界建單失敗：${parsed.error}`, 502)

  const p = parsed.params
  await supabaseAdmin
    .from('consumer_orders')
    .update({
      ecpay_logistics_trade_no: tradeNo,
      allpay_logistics_id: p.AllPayLogisticsID || null,
      cvs_payment_no: p.CVSPaymentNo || null,
      cvs_validation_no: p.CVSValidationNo || null,
      logistics_status: p.RtnCode || null,
      logistics_status_msg: p.RtnMsg || null,
      logistics_status_at: new Date().toISOString(),
      // 注意：不寫 status——建單本身不推進訂單主狀態，物流只在取件完成時推「完成」。
    })
    .eq('id', order.id)

  return NextResponse.json({
    ok: true,
    allPayLogisticsID: p.AllPayLogisticsID,
    cvsPaymentNo: p.CVSPaymentNo,
    cvsValidationNo: p.CVSValidationNo || null,
    rtnCode: p.RtnCode,
    rtnMsg: p.RtnMsg,
  }, { headers: corsHeaders })
}
