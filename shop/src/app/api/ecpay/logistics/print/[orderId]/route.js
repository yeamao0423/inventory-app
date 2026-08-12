// 列印託運單／繳款單：依訂單的超商子類型路由到對應列印 API，
// 回自動送出表單在新分頁開啟綠界產生的單據（請勿用 iframe，會被導轉阻擋）。
import { loadOrderForEcpay } from '../../../../../../lib/ecpayStore'
import { getPrintUrl, genLogisticsCheckMac, buildAutoSubmitForm } from '../../../../../../lib/ecpay'

export const dynamic = 'force-dynamic'

function htmlError(msg) {
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>無法列印</h2><p>${msg}</p></body></html>`,
    { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  )
}

export async function GET(request, { params }) {
  const { order, cfg, error } = await loadOrderForEcpay(
    params.orderId,
    'id, store_id, shipping_subtype, allpay_logistics_id, cvs_payment_no, cvs_validation_no'
  )
  if (error) return htmlError(error)
  if (!order.allpay_logistics_id) return htmlError('此訂單尚未建立物流單，無法列印')

  const printUrl = getPrintUrl(order.shipping_subtype, cfg)
  if (!printUrl) return htmlError(`不支援的物流類型：${order.shipping_subtype}`)

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
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}
