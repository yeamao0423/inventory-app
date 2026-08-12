// 信用卡：載入訂單 → 組綠界 AIO 參數 → 回自動送出表單導轉到綠界付款頁
import { supabaseAdmin } from '../../../../../lib/supabase-admin'
import { loadOrderForEcpay, callbackBaseUrl } from '../../../../../lib/ecpayStore'
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

export async function GET(request, { params }) {
  const { order, cfg, error } = await loadOrderForEcpay(
    params.orderId,
    'id, store_id, total_amount, paid_amount, payment_method, payment_status, items'
  )
  if (error) return htmlError(error)
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
    ClientBackURL: `${origin}/order/${order.id}`,
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
