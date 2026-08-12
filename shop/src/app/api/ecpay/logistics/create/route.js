// 後台履約：依訂單建立綠界物流單（Express/Create，C2C 超商取貨）
// 由後台按鈕手動觸發——代購是先收單後調貨，下單當下未必有貨，不可自動建單。
// 這支會實際扣該店綠界帳戶餘額。
// 貨到付款訂單 → IsCollection=Y + CollectionAmount=訂單總額（綠界代收）。
// 回傳並保存 AllPayLogisticsID / CVSPaymentNo / CVSValidationNo。
// 建單成功不改訂單 status——狀態機只在取件完成時（logistics/notify）推「完成」。
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '../../../../../lib/supabase-admin'
import { loadOrderForEcpay, callbackBaseUrl } from '../../../../../lib/ecpayStore'
import {
  genLogisticsCheckMac,
  formatEcpayDate,
  genLogisticsTradeNo,
  parseLogisticsResponse,
} from '../../../../../lib/ecpay'

export const dynamic = 'force-dynamic'

// 後台（Vite，不同網域）會跨域呼叫這支；此端點不吐機密，只吐物流編號，
// 沒設定 ADMIN_ORIGIN 就開放 *。
const corsHeaders = {
  'Access-Control-Allow-Origin': process.env.ADMIN_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function OPTIONS() {
  return NextResponse.json(null, { headers: corsHeaders })
}

function fail(msg, status = 400) {
  return NextResponse.json({ ok: false, error: msg }, { status, headers: corsHeaders })
}

export async function POST(request) {
  if (!supabaseAdmin) return fail('伺服器未設定（缺少 service key）', 500)

  let orderId
  try {
    ({ orderId } = await request.json())
  } catch {
    return fail('請帶入 orderId')
  }
  if (!orderId) return fail('請帶入 orderId')

  const { order, cfg, error } = await loadOrderForEcpay(
    orderId,
    'id, store_id, total_amount, payment_method, shipping_subtype, cvs_store_id, customer_name, phone, email, items, allpay_logistics_id'
  )
  if (error) return fail(error)
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
