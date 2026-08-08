import { taipeiDayStart, taipeiDayEnd } from './orderFinance'

/**
 * 行程訂單納入規則 —— 唯一判定處。
 *
 * 訂單原本完全靠日期區間歸屬行程，但區間內可能混進別趟的單或常規訂單。
 * consumer_orders.trip_id / trip_excluded 讓使用者人工覆寫（見 20260808120000）：
 *
 *   trip_excluded = true               → 人工勾掉，優先於一切，不進任何行程
 *   trip_id === trip.id                → 人工釘住，區間不符也算
 *   trip_id 為 null                     → 沒人管過，落在區間就算
 *   其餘                                → 不算（釘給別趟）
 */

/** 訂單建立時間落在行程區間內嗎（台北日界線，跟報表查詢同一套） */
export function isWithinTripRange(createdAt, trip) {
  if (!createdAt || !trip?.depart_date || !trip?.return_date) return false
  const t = new Date(createdAt).getTime()
  if (Number.isNaN(t)) return false
  const start = new Date(taipeiDayStart(trip.depart_date)).getTime()
  const end = new Date(taipeiDayEnd(trip.return_date)).getTime()
  return t >= start && t <= end
}

export function isOrderInTrip(order, trip) {
  if (!order || !trip) return false
  // 人工勾掉優先於一切。trip_id 保留不清，這樣「曾經釘進哪一趟」的痕跡還在，
  // 區間外被勾掉的單才撈得回清單、隨時可以勾回來。
  if (order.trip_excluded) return false
  // PostgREST 的 bigint 有可能回字串，兩邊都轉字串比
  if (order.trip_id != null) return String(order.trip_id) === String(trip.id)
  return isWithinTripRange(order.created_at, trip)
}

/** 一次判定、兩邊共用：財務吃 included，勾選清單兩組都要畫 */
export function splitOrdersByTrip(orders = [], trip) {
  const included = []
  const excluded = []
  ;(orders || []).forEach(o => {
    if (isOrderInTrip(o, trip)) included.push(o)
    else excluded.push(o)
  })
  return { included, excluded }
}
