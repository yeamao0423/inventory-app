// 物流狀態通知 ServerReplyURL：綠界每次物流狀態變更 POST 通知 → 反查店家 → 驗章 → 更新訂單 → 回 1|OK
// 狀態機收斂：訂單主狀態只在「取件完成」時推到「完成」，到店／退回只寫物流欄位，
// 後台依 logistics_status 自行亮警示，不新增「待取貨」「退貨/未取」狀態值（會波及六個檔案與報表）。
// 貨到付款：取件＝綠界代收完成，經 apply_cod_payment RPC 記帳（冪等），絕不直接改 payment_status。
import { supabaseAdmin } from '../../../../../lib/supabase-admin'
import { getEcpayConfigForStore } from '../../../../../lib/ecpayStore'
import { verifyCheckMacValue, logisticsMilestone } from '../../../../../lib/ecpay'

export const dynamic = 'force-dynamic'

function text(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}

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
      .select('id, store_id, payment_method')
      .eq('allpay_logistics_id', logisticsId)
      .maybeSingle()
    order = o || null
  }

  const cfg = order ? await getEcpayConfigForStore(order.store_id) : null
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
    const update = {
      logistics_status: data.RtnCode != null ? String(data.RtnCode) : null,
      logistics_status_msg: data.RtnMsg || null,
      logistics_status_at: new Date().toISOString(),
    }

    const milestone = logisticsMilestone(data.RtnCode, data.RtnMsg)
    // 到店/退回只寫物流欄位，不動訂單主狀態——後台會據此亮警示，由店家決定
    if (milestone === 'picked') {
      update.status = '完成'
    }
    await supabaseAdmin.from('consumer_orders').update(update).eq('id', order.id)

    // 貨到付款：消費者取件＝綠界代收完成 → 補滿 paid_amount（冪等）
    if (milestone === 'picked' && order.payment_method === 'cod') {
      await supabaseAdmin.rpc('apply_cod_payment', { p_order_id: order.id })
    }
  }

  return text('1|OK')
}
