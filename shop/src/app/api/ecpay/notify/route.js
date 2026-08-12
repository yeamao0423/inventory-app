// 金流 ReturnURL：綠界背景 POST 付款結果 → 反查店家 → 驗章 → 記帳 → 回 1|OK
// 付款金額一律經 apply_ecpay_payment 寫進 paid_amount，payment_status 由 trigger 推導。
// 直接 UPDATE payment_status 會被 sync_payment_status trigger 蓋掉。
import { supabaseAdmin } from '../../../../lib/supabase-admin'
import { getEcpayConfigForStore } from '../../../../lib/ecpayStore'
import { verifyCheckMacValue } from '../../../../lib/ecpay'

export const dynamic = 'force-dynamic'

function text(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}

export async function POST(request) {
  const form = await request.formData()
  const data = Object.fromEntries(form)
  const tradeNo = data.MerchantTradeNo || null

  if (!supabaseAdmin) return text('0|server not configured')

  // 綠界不會告訴我們是哪家店 —— 用交易編號反查（trade_no 有唯一索引）
  const { data: txn } = await supabaseAdmin
    .from('ecpay_transactions')
    .select('order_id, store_id')
    .eq('trade_no', tradeNo)
    .maybeSingle()

  const cfg = txn ? await getEcpayConfigForStore(txn.store_id) : null
  const macValid = cfg
    ? verifyCheckMacValue(data, { hashKey: cfg.hashKey, hashIV: cfg.hashIV, algo: 'sha256' })
    : false

  // 留底（驗章失敗也要記，對帳與查弊都靠它）
  await supabaseAdmin.from('ecpay_payment_logs').insert({
    order_id: txn?.order_id ?? null,
    source: 'payment_notify',
    trade_no: tradeNo,
    rtn_code: data.RtnCode != null ? String(data.RtnCode) : null,
    rtn_msg: data.RtnMsg || null,
    mac_valid: macValid,
    raw: data,
  })

  if (!macValid) return text('0|CheckMacValue Error')

  await supabaseAdmin.rpc('apply_ecpay_payment', {
    p_trade_no: tradeNo,
    p_rtn_code: data.RtnCode != null ? String(data.RtnCode) : null,
    p_payment_type: data.PaymentType || null,
  })

  return text('1|OK')
}
