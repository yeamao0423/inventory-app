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

  // makeEcpayConfig 在正式環境金流金鑰不齊時會 throw，而 throw 會穿過 getEcpayConfigForStore。
  // 不接住的話這支就是未捕捉例外 → 500，綠界會重送（fail-closed 沒錯），
  // 但一列 log 都寫不進去，事後沒人查得到為什麼付款一直沒記進來。所以先留底再回非 1|OK。
  let cfg = null
  let cfgError = null
  if (txn) {
    try {
      cfg = await getEcpayConfigForStore(txn.store_id)
    } catch (e) {
      cfgError = e
    }
  }
  if (cfgError) {
    await supabaseAdmin.from('ecpay_payment_logs').insert({
      order_id: txn?.order_id ?? null,
      source: 'payment_notify',
      trade_no: tradeNo,
      rtn_code: data.RtnCode != null ? String(data.RtnCode) : null,
      rtn_msg: `取得綠界金鑰失敗，無法驗章：${cfgError.message}`,
      mac_valid: false,
      raw: { config_error: cfgError.message, notify: data },
    })
    return text('0|config error')
  }

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

  const { data: applied, error: applyError } = await supabaseAdmin.rpc('apply_ecpay_payment', {
    p_trade_no: tradeNo,
    p_rtn_code: data.RtnCode != null ? String(data.RtnCode) : null,
    p_payment_type: data.PaymentType || null,
  })

  // 回 1|OK 等於告訴綠界「已收到，不必再送」——所以必須先確認錢真的記進去了。
  // apply_ecpay_payment 的三種成功形狀都是 ok:true，全部回 1|OK：
  //   已記過（already:true）／剛記成功（paid:true）／付款失敗 RtnCode≠1（paid:false，正常處理完畢）。
  // 失敗有兩種，兩種都要回非 1|OK 讓綠界重送（該 RPC 冪等，重送安全）：
  //   error 非 null（連線逾時、pool 用盡、PostgREST 5xx）／回傳 ok:false（交易編號查不到等）。
  // 沒有這道檢查的話，DB 抖一次就是：卡片已扣款、paid_amount 沒加、30 分鐘後被當棄單取消。
  if (applyError || applied?.ok !== true) {
    await supabaseAdmin.from('ecpay_payment_logs').insert({
      order_id: txn?.order_id ?? null,
      source: 'payment_notify',
      trade_no: tradeNo,
      rtn_code: data.RtnCode != null ? String(data.RtnCode) : null,
      rtn_msg: `apply_ecpay_payment 失敗：${applyError?.message || applied?.error || '未知錯誤'}`,
      mac_valid: macValid,
      raw: { apply_error: applyError?.message ?? null, apply_result: applied ?? null, notify: data },
    })
    return text('0|apply failed')
  }

  return text('1|OK')
}
