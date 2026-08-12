// 電子地圖：回自動送出表單，整頁導轉到綠界門市地圖讓消費者選店。
// 選完綠界會 POST 到 map-reply，那支再把消費者導回結帳頁。
// ServerReplyURL 用請求當下的 origin（這是消費者互動導轉，不是背景通知），
// 才會導回消費者原本所在的店家網域。
import { getEcpayConfigForStore } from '../../../../../lib/ecpayStore'
import { buildAutoSubmitForm, CVS_SUBTYPES } from '../../../../../lib/ecpay'

export const dynamic = 'force-dynamic'

export async function GET(request) {
  const url = new URL(request.url)
  const subtype = url.searchParams.get('subtype') || 'UNIMARTC2C'
  const storeId = url.searchParams.get('storeId')
  const device = url.searchParams.get('device') === '1' ? 1 : 0

  if (!CVS_SUBTYPES.includes(subtype)) {
    return new Response('invalid subtype', { status: 400 })
  }

  const cfg = await getEcpayConfigForStore(storeId)
  if (!cfg) return new Response('此店家尚未設定綠界金鑰', { status: 400 })

  // 電子地圖需要唯一 MerchantTradeNo（此時尚未建單，用臨時值）
  const tradeNo = `MAP${Date.now().toString(36).toUpperCase()}`.slice(0, 20)
  const origin = new URL(request.url).origin

  const params = {
    MerchantID: cfg.logisticsMerchantId,
    MerchantTradeNo: tradeNo,
    LogisticsType: 'CVS',
    LogisticsSubType: subtype,
    IsCollection: 'N',   // 是否代收於建立物流單時才決定，此處僅選店
    ServerReplyURL: `${origin}/api/ecpay/logistics/map-reply`,
    Device: device,
  }

  const html = buildAutoSubmitForm(cfg.urls.logisticsMap, params, { title: '開啟門市地圖...' })
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}
