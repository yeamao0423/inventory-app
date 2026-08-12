// 依店家取綠界設定（server only）。
// 金鑰存在 store_ecpay_secrets，該表 RLS 開啟且無任何 policy，
// 只有這裡用的 service role client 讀得到——切勿在 client component import。
import { supabaseAdmin } from './supabase-admin'
import { makeEcpayConfig } from './ecpay'

/**
 * 綠界「背景通知」回呼用的固定網址（ReturnURL、物流 ServerReplyURL）。
 * 讀 ECPAY_CALLBACK_BASE_URL。
 *
 * 注意：這個函式只服務「背景通知」半邊——綠界伺服器直接打回來的網址
 *（金流 ReturnURL、物流 ServerReplyURL），必須是固定、可從外網解析的網域，
 * 不能用請求當下的 origin（本機開發、預覽網域都打不到）。
 *
 * 「消費者導轉」半邊（金流 OrderResultURL / ClientBackURL、電子地圖的
 * ServerReplyURL）則相反：要用當下請求的 origin（`new URL(req.url).origin`
 * 或等效方式），這樣使用者在哪個網域下單就導回哪個網域，*不要*呼叫這個函式。
 */
export function callbackBaseUrl() {
  return process.env.ECPAY_CALLBACK_BASE_URL || ''
}

/** 取某店的綠界設定；該店沒設金鑰回 null（結帳頁據此隱藏綠界付款方式） */
export async function getEcpayConfigForStore(storeId) {
  if (!supabaseAdmin || storeId == null) return null
  const { data, error } = await supabaseAdmin
    .from('store_ecpay_secrets')
    .select('*')
    .eq('store_id', storeId)
    .maybeSingle()
  if (error || !data) return null
  return makeEcpayConfig(data)
}

/**
 * 一次載入訂單與該店綠界設定。
 * 回 { order, cfg } 或 { error }——呼叫端只要判斷 error 就好。
 * columns 需自行包含 store_id。
 */
export async function loadOrderForEcpay(orderId, columns) {
  if (!supabaseAdmin) return { error: '伺服器未設定（缺少 service key）' }

  const { data: order, error } = await supabaseAdmin
    .from('consumer_orders')
    .select(columns)
    .eq('id', orderId)
    .maybeSingle()

  if (error || !order) return { error: '找不到訂單' }

  const cfg = await getEcpayConfigForStore(order.store_id)
  if (!cfg) return { error: '此店家尚未設定綠界金鑰' }

  return { order, cfg }
}
