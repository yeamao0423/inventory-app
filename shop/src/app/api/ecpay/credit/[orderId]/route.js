// 信用卡：載入訂單 → 組綠界 AIO 參數 → 回自動送出表單導轉到綠界付款頁
//
// 持有證明：這支是「消費者」用的（沒有員工 JWT 可驗），而路徑上的數字 id 可枚舉，
// 所以一律要求 ?t=<public_token>，且**用 token 查訂單**（不信任路徑上的 id，只拿它做
// 一致性比對）。沒有 token 就沒有任何回應——避免用可枚舉的流水號換到不可猜的 token
// （token 一旦外流即可讀 get_consumer_order 的 PII，並可呼叫 append_to_order 竄改訂單）。
import { supabaseAdmin } from '../../../../../lib/supabase-admin'
import { getEcpayConfigForStore, callbackBaseUrl } from '../../../../../lib/ecpayStore'
import {
  genPaymentCheckMac,
  formatEcpayDate,
  genMerchantTradeNo,
  buildAutoSubmitForm,
} from '../../../../../lib/ecpay'

export const dynamic = 'force-dynamic'

function htmlError(msg) {
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>無法前往付款</h2><p>${msg}</p><a href="/cart">返回購物車</a></body></html>`,
    { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  )
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(request, { params }) {
  if (!supabaseAdmin) return htmlError('伺服器未設定（缺少 service key）')

  const token = new URL(request.url).searchParams.get('t') || ''
  // 格式先擋掉，避免把亂字串丟給 uuid 欄位查詢
  if (!UUID_RE.test(token)) return htmlError('付款連結不完整或已失效，請從訂單頁重新進入')

  // 以 public_token 查訂單（唯一的持有證明），路徑上的數字 id 只做一致性比對
  const { data: order, error: qErr } = await supabaseAdmin
    .from('consumer_orders')
    .select('id, store_id, total_amount, paid_amount, payment_method, payment_status, items, public_token')
    .eq('public_token', token)
    .maybeSingle()
  if (qErr || !order) return htmlError('找不到訂單')
  if (String(order.id) !== String(params.orderId)) return htmlError('找不到訂單')

  let cfg
  try {
    cfg = await getEcpayConfigForStore(order.store_id)
  } catch (e) {
    // makeEcpayConfig 在正式環境金鑰不完整時會 throw，寧可失敗也不要用公開測試金鑰
    return htmlError(e.message)
  }
  if (!cfg) return htmlError('此店家尚未設定綠界金鑰')

  if (order.payment_method !== 'credit') return htmlError('此訂單非信用卡付款')

  // 未付餘額，而非訂單總額——支援棄單重付與加購補差額（一張訂單多筆交易）
  const amount = Math.round(Number(order.total_amount || 0) - Number(order.paid_amount || 0))
  if (amount <= 0) return htmlError('此訂單已無待付金額')

  // 產生綠界交易編號並登記為一筆待處理交易
  const tradeNo = genMerchantTradeNo(order.id)
  const { error: txnErr } = await supabaseAdmin.rpc('create_ecpay_transaction', {
    p_order_id: order.id,
    p_trade_no: tradeNo,
    p_amount: amount,
  })
  if (txnErr) return htmlError('建立交易失敗：' + txnErr.message)

  // 商品名稱：綠界以 # 分隔多筆，長度上限 400，去除可能破壞的字元
  const itemName =
    (order.items || '商品')
      .replace(/[#&<>]/g, ' ')
      .slice(0, 400) || '商品'

  const origin = new URL(request.url).origin // 消費者當下所在的店家網域
  const callbackBase = callbackBaseUrl() || origin // 綠界背景通知的固定網域

  const ecpayParams = {
    MerchantID: cfg.merchantId,
    MerchantTradeNo: tradeNo,
    MerchantTradeDate: formatEcpayDate(),
    PaymentType: 'aio',
    TotalAmount: amount,
    TradeDesc: 'Order',
    ItemName: itemName,
    ReturnURL: `${callbackBase}/api/ecpay/notify`,
    OrderResultURL: `${origin}/api/ecpay/result`,
    // 導回消費者訂單頁 /order/<token>（uuid，見 20250031 migration）。
    // 這裡的 token 是呼叫端本來就持有、也是本路由用來查訂單的那一個，
    // 所以寫進表單不構成外洩（沒有 token 根本進不來這支路由）。
    ClientBackURL: `${origin}/order/${token}`,
    ChoosePayment: 'Credit',
    EncryptType: 1,
    NeedExtraPaidInfo: 'Y',
    CustomField1: String(order.id),
  }
  ecpayParams.CheckMacValue = genPaymentCheckMac(ecpayParams, cfg)

  const html = buildAutoSubmitForm(cfg.urls.aio, ecpayParams, {
    title: '前往綠界付款...',
  })
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}
