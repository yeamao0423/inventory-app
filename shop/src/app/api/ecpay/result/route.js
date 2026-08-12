// 金流 OrderResultURL：綠界付款後把消費者瀏覽器 POST 導回這裡 → 轉址到訂單頁
// 付款狀態仍以 ReturnURL(notify) 為主要真相；但此頁同樣帶有付款結果＋CheckMacValue，
// 故在「驗章通過」前提下也做一次後援記帳——解決 notify 延遲/漏送（含 localhost 收不到背景通知）。
// apply_ecpay_payment 本身冪等，notify 與這裡都做也只會算一次錢。
//
// 導回網址用當下請求的 origin（消費者原本所在的店家網域），不可用 callbackBaseUrl()——
// 那個只給綠界機器背景通知（notify）用的固定網域。
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '../../../../lib/supabase-admin'
import { getEcpayConfigForStore } from '../../../../lib/ecpayStore'
import { verifyCheckMacValue } from '../../../../lib/ecpay'

export const dynamic = 'force-dynamic'

async function resolve(request) {
  const origin = new URL(request.url).origin

  let data = null
  let orderId = null
  try {
    const form = await request.formData()
    data = Object.fromEntries(form)
  } catch {
    // 非表單（例如直接 GET）——退回讀 query
    const url = new URL(request.url)
    orderId = url.searchParams.get('orderId')
  }

  const rtnCode = data?.RtnCode ?? null

  // 後援確認：只在綠界帶回完整結果（data 存在）且設定了 service key 時處理
  if (data && supabaseAdmin) {
    const tradeNo = data.MerchantTradeNo || null

    // 綠界不會告訴我們是哪家店 —— 用交易編號反查（trade_no 有唯一索引），
    // 與 notify 完全相同的作法：先反查店家，才能取得該店金鑰驗章。
    const { data: txn } = await supabaseAdmin
      .from('ecpay_transactions')
      .select('order_id, store_id')
      .eq('trade_no', tradeNo)
      .maybeSingle()

    const cfg = txn ? await getEcpayConfigForStore(txn.store_id) : null
    const macValid = cfg
      ? verifyCheckMacValue(data, { hashKey: cfg.hashKey, hashIV: cfg.hashIV, algo: 'sha256' })
      : false

    // 留底（驗章失敗也要記，對帳與查弊都靠它；來源標 payment_result 以區隔 notify）
    await supabaseAdmin.from('ecpay_payment_logs').insert({
      order_id: txn?.order_id ?? null,
      source: 'payment_result',
      trade_no: tradeNo,
      rtn_code: data.RtnCode != null ? String(data.RtnCode) : null,
      rtn_msg: data.RtnMsg || null,
      mac_valid: macValid,
      raw: data,
    })

    // 驗章通過就記帳——apply_ecpay_payment 冪等，即使 notify 已經處理過也只會算一次錢
    if (macValid && tradeNo) {
      await supabaseAdmin.rpc('apply_ecpay_payment', {
        p_trade_no: tradeNo,
        p_rtn_code: data.RtnCode != null ? String(data.RtnCode) : null,
        p_payment_type: data.PaymentType || null,
      })
    }

    orderId = txn?.order_id ?? (data.CustomField1 || null)
  }

  if (orderId) {
    const paid = String(rtnCode) === '1' ? '1' : '0'
    return NextResponse.redirect(`${origin}/order/${orderId}?paid=${paid}`, 303)
  }
  return NextResponse.redirect(`${origin}/`, 303)
}

export async function POST(request) {
  return resolve(request)
}

export async function GET(request) {
  return resolve(request)
}
