// 金流 OrderResultURL：綠界付款後把消費者瀏覽器 POST 導回這裡 → 轉址到訂單頁
// 付款狀態仍以 ReturnURL(notify) 為主要真相；但此頁同樣帶有付款結果＋CheckMacValue，
// 故在「驗章通過」前提下也做一次後援記帳——解決 notify 延遲/漏送（含 localhost 收不到背景通知）。
// apply_ecpay_payment 本身冪等，notify 與這裡都做也只會算一次錢。
//
// 導回網址用當下請求的 origin（消費者原本所在的店家網域），不可用 callbackBaseUrl()——
// 那個只給綠界機器背景通知（notify）用的固定網域。
//
// 注意兩支路由吃的鍵不一樣，別搞混：
// - /api/ecpay/credit/<id>：數字主鍵（consumer_orders.id / ecpay_transactions.order_id）
// - /order/<token>（消費者看的訂單頁）：不可猜的 public_token（uuid，見 20250031 migration），
//   頁面內部用它呼叫 get_consumer_order({ p_token })。這裡導回消費者一定要用 public_token，
//   組數字 id 進這個路徑訂單頁會查不到資料，變成一片空白。
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '../../../../lib/supabase-admin'
import { getEcpayConfigForStore } from '../../../../lib/ecpayStore'
import { verifyCheckMacValue } from '../../../../lib/ecpay'

export const dynamic = 'force-dynamic'

async function resolve(request) {
  const origin = new URL(request.url).origin

  let data = null
  try {
    const form = await request.formData()
    data = Object.fromEntries(form)
  } catch {
    // 非表單（例如直接 GET 無 body）——沒有綠界帶回的交易編號可反查訂單，
    // 底下會因 data 為 null 直接落到「查不到就導回首頁」，不強猜路徑。
  }

  const rtnCode = data?.RtnCode ?? null
  let publicToken = null

  // 後援確認：只在綠界帶回完整結果（data 存在）且設定了 service key 時處理
  if (data && supabaseAdmin) {
    const tradeNo = data.MerchantTradeNo || null

    // 綠界不會告訴我們是哪家店 —— 用交易編號反查（trade_no 有唯一索引），
    // 與 notify 完全相同的作法：先反查店家，才能取得該店金鑰驗章；
    // 順便把 consumer_orders.public_token 一併帶出來（見上方注意事項）。
    const { data: txn } = await supabaseAdmin
      .from('ecpay_transactions')
      .select('order_id, store_id, consumer_orders(public_token)')
      .eq('trade_no', tradeNo)
      .maybeSingle()

    // makeEcpayConfig 在正式環境金流金鑰不齊時會 throw，而 throw 會穿過 getEcpayConfigForStore。
    // 這支是「消費者瀏覽器」導轉，不能因此炸成 500 讓客人看到錯誤頁——接住、留底、照常導轉，
    // 付款真相仍以 notify 為主（那支會 fail-closed 讓綠界重送）。
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
        source: 'payment_result',
        trade_no: tradeNo,
        rtn_code: data.RtnCode != null ? String(data.RtnCode) : null,
        rtn_msg: `取得綠界金鑰失敗，無法驗章與後援記帳：${cfgError.message}`,
        mac_valid: false,
        raw: { config_error: cfgError.message, result: data },
      })
    }

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

    // 驗章通過就記帳——apply_ecpay_payment 冪等，即使 notify 已經處理過也只會算一次錢。
    //
    // 與 notify 的差別：這支是消費者導轉，綠界不看它的回應決定要不要重送，所以記帳失敗
    // **不擋導轉**——客人該看到自己的訂單頁。但失敗一定要留痕，否則「後援記帳整條壞掉」
    // 這件事沒有任何人會知道（notify 若同時漏送，錢就這樣不見了）。
    if (macValid && tradeNo) {
      const { data: applied, error: applyError } = await supabaseAdmin.rpc('apply_ecpay_payment', {
        p_trade_no: tradeNo,
        p_rtn_code: data.RtnCode != null ? String(data.RtnCode) : null,
        p_payment_type: data.PaymentType || null,
      })
      if (applyError || applied?.ok !== true) {
        await supabaseAdmin.from('ecpay_payment_logs').insert({
          order_id: txn?.order_id ?? null,
          source: 'payment_result',
          trade_no: tradeNo,
          rtn_code: data.RtnCode != null ? String(data.RtnCode) : null,
          rtn_msg: `後援記帳失敗（apply_ecpay_payment）：${applyError?.message || applied?.error || '未知錯誤'}`
            + '；已照常導轉消費者，付款真相以 ReturnURL(notify) 為準，請人工確認此筆是否入帳。',
          mac_valid: macValid,
          raw: { apply_error: applyError?.message ?? null, apply_result: applied ?? null, result: data },
        })
      }
    }

    // CustomField1 是數字主鍵，不是 public_token，不能拿來當導回訂單頁的路徑；
    // 反查失敗（trade_no 對不上、舊資料沒 token）就沒有 publicToken 可用，
    // 底下會退回導首頁，不組出查不到訂單的壞網址。
    publicToken = txn?.consumer_orders?.public_token ?? null
  }

  if (publicToken) {
    const paid = String(rtnCode) === '1' ? '1' : '0'
    return NextResponse.redirect(`${origin}/order/${publicToken}?paid=${paid}`, 303)
  }
  return NextResponse.redirect(`${origin}/`, 303)
}

export async function POST(request) {
  return resolve(request)
}

export async function GET(request) {
  return resolve(request)
}
