// 物流狀態通知 ServerReplyURL：綠界每次物流狀態變更 POST 通知 → 反查店家 → 驗章 → 更新訂單 → 回 1|OK
// 狀態機收斂：訂單主狀態只在「取件完成」時推到「完成」，到店／退回只寫物流欄位，
// 後台依 logistics_status 自行亮警示，不新增「待取貨」「退貨/未取」狀態值（會波及六個檔案與報表）。
// 貨到付款：取件＝綠界代收完成，經 apply_cod_payment RPC 記帳（冪等），絕不直接改 payment_status。
import { supabaseAdmin } from '../../../../../lib/supabase-admin'
import { getEcpayConfigForStore } from '../../../../../lib/ecpayStore'
import {
  verifyCheckMacValue,
  logisticsMilestoneDetail,
  logisticsUnavailableMessage,
} from '../../../../../lib/ecpay'

export const dynamic = 'force-dynamic'

function text(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}

// 貨到付款遇到「不能據以自動記帳」的物流通知時，留給店家的提示前綴。
// 固定前綴的用途：下一則通知進來時只覆寫自己上次留的同類提示，
// 絕不蓋掉 apply_ecpay_payment 的庫存不足警示或店家自己填的 payment_alert。
const COD_MANUAL_CHECK_PREFIX = '貨到付款：物流狀態需人工確認'

export async function POST(request) {
  const form = await request.formData()
  const data = Object.fromEntries(form)

  if (!supabaseAdmin) return text('0|server not configured')

  // 綠界不會告訴我們是哪家店 —— 用 AllPayLogisticsID 反查訂單拿 store_id（已建索引）
  const logisticsId = data.AllPayLogisticsID ? String(data.AllPayLogisticsID) : null
  let order = null
  if (logisticsId) {
    const { data: o } = await supabaseAdmin
      .from('consumer_orders')
      .select('id, store_id, payment_method, payment_alert')
      .eq('allpay_logistics_id', logisticsId)
      .maybeSingle()
    order = o || null
  }

  // makeEcpayConfig 在正式環境金流金鑰不齊時會 throw，而 throw 會穿過 getEcpayConfigForStore。
  // 不接住的話這支就是未捕捉例外 → 500，綠界會重送（fail-closed 沒錯），
  // 但一列 log 都寫不進去，事後沒人查得到為什麼一直重送。所以先留底再回非 1|OK。
  let cfg = null
  let cfgError = null
  if (order) {
    try {
      cfg = await getEcpayConfigForStore(order.store_id)
    } catch (e) {
      cfgError = e
    }
  }
  if (cfgError) {
    await supabaseAdmin.from('ecpay_payment_logs').insert({
      order_id: order?.id ?? null,
      source: 'logistics_reply',
      trade_no: logisticsId,
      rtn_code: data.RtnCode != null ? String(data.RtnCode) : null,
      rtn_msg: `取得綠界金鑰失敗，無法驗章：${cfgError.message}`,
      mac_valid: false,
      raw: { config_error: cfgError.message, notify: data },
    })
    return text('0|config error')
  }

  // 物流金鑰不齊（例如只申請了金流）→ 無從驗章，同樣留底後讓綠界重送
  const logisticsBlocked = cfg ? logisticsUnavailableMessage(cfg) : null
  if (logisticsBlocked) {
    await supabaseAdmin.from('ecpay_payment_logs').insert({
      order_id: order?.id ?? null,
      source: 'logistics_reply',
      trade_no: logisticsId,
      rtn_code: data.RtnCode != null ? String(data.RtnCode) : null,
      rtn_msg: `無法處理物流通知：${logisticsBlocked}`,
      mac_valid: false,
      raw: { logistics_error: logisticsBlocked, notify: data },
    })
    return text('0|logistics not configured')
  }

  const macValid = cfg
    ? verifyCheckMacValue(data, { hashKey: cfg.logisticsHashKey, hashIV: cfg.logisticsHashIV, algo: 'md5' })
    : false

  // 留底（驗章失敗也要記，對帳與查弊都靠它）
  await supabaseAdmin.from('ecpay_payment_logs').insert({
    order_id: order?.id ?? null,
    source: 'logistics_reply',
    trade_no: logisticsId,
    rtn_code: data.RtnCode != null ? String(data.RtnCode) : null,
    rtn_msg: data.RtnMsg || null,
    mac_valid: macValid,
    raw: data,
  })

  if (!macValid) return text('0|CheckMacValue Error')

  if (order) {
    const rtnCode = data.RtnCode != null ? String(data.RtnCode) : null
    const rtnMsg = data.RtnMsg || null
    const update = {
      // 判不出里程碑時，原始代碼與訊息仍然完整留在訂單上——後台要靠這兩欄人工判讀
      logistics_status: rtnCode,
      logistics_status_msg: rtnMsg,
      logistics_status_at: new Date().toISOString(),
    }

    const { milestone, source: milestoneSource } = logisticsMilestoneDetail(data.RtnCode, data.RtnMsg)
    // 到店/退回只寫物流欄位，不動訂單主狀態——後台會據此亮警示，由店家決定。
    // 狀態改錯還能改回來，錢記錯不行，所以這裡不看 milestoneSource（記帳那段才看）。
    if (milestone === 'picked') {
      update.status = '完成'
    }

    // 貨到付款的錢是靠「取件成功」才記進去的，而萊爾富／OK 的狀態代碼目前沒有官方對照表
    // （見 lib/ecpay.js 的 LOGISTICS_MILESTONE_CODES）。所以自動記帳只認官方代碼：
    //   milestoneSource === 'code'   → 可信，下面呼叫 apply_cod_payment
    //   milestoneSource === 'keyword' → 關鍵字猜的（一則退貨通知只要訊息含「取件成功」就會中），
    //                                   絕不自動記帳，改寫 payment_alert 請店家確認是否已代收
    //   milestone === null            → 判不出來，同樣寫 payment_alert
    const codAutoApply = milestone === 'picked' && milestoneSource === 'code'
    const codNeedsManualCheck = order.payment_method === 'cod' && !codAutoApply && milestoneSource !== 'code'
    if (codNeedsManualCheck) {
      const prev = order.payment_alert || ''
      if (!prev || prev.startsWith(COD_MANUAL_CHECK_PREFIX)) {
        const why = milestone === null
          ? '未對應到任何已知里程碑'
          : `僅由訊息關鍵字判為「${milestone}」，未經綠界官方狀態代碼確認，已暫不自動記帳`
        update.payment_alert =
          `${COD_MANUAL_CHECK_PREFIX}（代碼 ${rtnCode ?? '無'}：${rtnMsg ?? '無訊息'}）：${why}。`
          + '若客人已取件，請至綠界確認代收貨款是否已入帳並人工補記。'
      }
    }

    const { error: updateError } = await supabaseAdmin
      .from('consumer_orders').update(update).eq('id', order.id)

    // 貨到付款：消費者取件＝綠界代收完成 → 補滿 paid_amount（冪等）。
    // 只在里程碑來自官方代碼（codAutoApply）時才做，關鍵字猜測一律不動錢。
    let codError = null
    let codResult = null
    if (codAutoApply && order.payment_method === 'cod') {
      const res = await supabaseAdmin.rpc('apply_cod_payment', { p_order_id: order.id })
      codError = res.error
      codResult = res.data
    }

    // 與金流 notify 同一個道理：回 1|OK 綠界就不再重送這則通知。訂單沒更新到、
    // 或 COD 記帳沒成功，就回非 1|OK 讓綠界重送（update 與 apply_cod_payment 都冪等）。
    if (updateError || codError || (codResult && codResult.ok !== true)) {
      await supabaseAdmin.from('ecpay_payment_logs').insert({
        order_id: order.id,
        source: 'logistics_reply',
        trade_no: logisticsId,
        rtn_code: rtnCode,
        rtn_msg: `套用物流通知失敗：${updateError?.message || codError?.message || codResult?.error || '未知錯誤'}`,
        mac_valid: macValid,
        raw: {
          update_error: updateError?.message ?? null,
          cod_error: codError?.message ?? null,
          cod_result: codResult ?? null,
          notify: data,
        },
      })
      return text('0|apply failed')
    }
  }

  return text('1|OK')
}
