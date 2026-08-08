import { describe, it, expect } from 'vitest'
import { isWithinTripRange, isOrderInTrip, splitOrdersByTrip } from './tripScope'

const tripA = { id: 1, depart_date: '2026-07-01', return_date: '2026-07-05' }
const tripB = { id: 2, depart_date: '2026-07-04', return_date: '2026-07-08' }

// 區間內的時間點，讓歸屬矩陣的六格只差在 trip_id / trip_excluded
const IN = '2026-07-03T10:00:00+08:00'
const OUT = '2026-07-20T10:00:00+08:00'

describe('isWithinTripRange', () => {
  it('用台北日界線，不是 UTC 午夜', () => {
    expect(isWithinTripRange('2026-06-30T23:59:59+08:00', tripA)).toBe(false)
    expect(isWithinTripRange('2026-07-01T00:00:00+08:00', tripA)).toBe(true)
    expect(isWithinTripRange('2026-07-05T23:59:59+08:00', tripA)).toBe(true)
    expect(isWithinTripRange('2026-07-06T00:00:00+08:00', tripA)).toBe(false)
  })

  it('DB 回傳的 UTC 字串也要判對', () => {
    // 台北 2026-06-30 23:59:59 → 出發日前一刻，不算
    expect(isWithinTripRange('2026-06-30T15:59:59Z', tripA)).toBe(false)
    // 台北 2026-07-01 00:00:00 → 出發日開始，算
    expect(isWithinTripRange('2026-06-30T16:00:00Z', tripA)).toBe(true)
  })

  it('資料不完整就回 false，不要炸', () => {
    expect(isWithinTripRange(null, tripA)).toBe(false)
    expect(isWithinTripRange('not-a-date', tripA)).toBe(false)
    expect(isWithinTripRange(IN, { id: 1 })).toBe(false)
  })
})

describe('isOrderInTrip 歸屬矩陣', () => {
  it('沒人管過 + 區間內 → 納入', () => {
    expect(isOrderInTrip({ trip_id: null, trip_excluded: false, created_at: IN }, tripA)).toBe(true)
  })
  it('沒人管過 + 區間外 → 不納入', () => {
    expect(isOrderInTrip({ trip_id: null, trip_excluded: false, created_at: OUT }, tripA)).toBe(false)
  })
  it('標成常規訂單 + 區間內 → 不納入', () => {
    expect(isOrderInTrip({ trip_id: null, trip_excluded: true, created_at: IN }, tripA)).toBe(false)
  })
  it('標成常規訂單 + 區間外 → 不納入', () => {
    expect(isOrderInTrip({ trip_id: null, trip_excluded: true, created_at: OUT }, tripA)).toBe(false)
  })
  it('釘在本趟 + 區間外 → 仍然納入', () => {
    expect(isOrderInTrip({ trip_id: 1, trip_excluded: false, created_at: OUT }, tripA)).toBe(true)
  })
  it('釘在別趟 + 區間內 → 不納入', () => {
    expect(isOrderInTrip({ trip_id: 2, trip_excluded: false, created_at: IN }, tripA)).toBe(false)
  })

  // 勾掉時只寫 trip_excluded、不清 trip_id：兩個集合同時離開會讓區間外的單
  // 從候撈範圍消失、再也勾不回來，所以 trip_excluded 必須優先於 trip_id。
  it('釘在本趟 + 人工勾掉 + 區間外 → 不納入', () => {
    expect(isOrderInTrip({ trip_id: 1, trip_excluded: true, created_at: OUT }, tripA)).toBe(false)
  })
  it('釘在本趟 + 人工勾掉 + 區間內 → 不納入', () => {
    expect(isOrderInTrip({ trip_id: 1, trip_excluded: true, created_at: IN }, tripA)).toBe(false)
  })
  it('勾掉後再勾回來（trip_excluded 改回 false）→ 重新納入', () => {
    const off = { trip_id: 1, trip_excluded: true, created_at: OUT }
    expect(isOrderInTrip(off, tripA)).toBe(false)
    expect(isOrderInTrip({ ...off, trip_excluded: false }, tripA)).toBe(true)
  })

  it('trip_id 型別不一致也要判對（PostgREST 可能回字串）', () => {
    expect(isOrderInTrip({ trip_id: '1', created_at: OUT }, tripA)).toBe(true)
  })

  it('欄位還沒建好（undefined）時退回純區間判定', () => {
    expect(isOrderInTrip({ created_at: IN }, tripA)).toBe(true)
    expect(isOrderInTrip({ created_at: OUT }, tripA)).toBe(false)
  })

  it('缺參數回 false', () => {
    expect(isOrderInTrip(null, tripA)).toBe(false)
    expect(isOrderInTrip({ created_at: IN }, null)).toBe(false)
  })
})

describe('區間重疊時的搬單', () => {
  const order = { id: 9, trip_id: null, trip_excluded: false, created_at: '2026-07-04T10:00:00+08:00' }

  it('沒人管過時，重疊區間的兩趟都會算到同一張單', () => {
    expect(isOrderInTrip(order, tripA)).toBe(true)
    expect(isOrderInTrip(order, tripB)).toBe(true)
  })

  it('釘給 B 之後，A 自動排除、B 納入', () => {
    const moved = { ...order, trip_id: 2, trip_excluded: false }
    expect(isOrderInTrip(moved, tripA)).toBe(false)
    expect(isOrderInTrip(moved, tripB)).toBe(true)
  })
})

describe('splitOrdersByTrip', () => {
  it('分成納入／排除兩組且不漏單', () => {
    const orders = [
      { id: 1, trip_id: null, trip_excluded: false, created_at: IN },
      { id: 2, trip_id: null, trip_excluded: true, created_at: IN },
      { id: 3, trip_id: 2, trip_excluded: false, created_at: IN },
      { id: 4, trip_id: 1, trip_excluded: false, created_at: OUT },
    ]
    const { included, excluded } = splitOrdersByTrip(orders, tripA)
    expect(included.map(o => o.id)).toEqual([1, 4])
    expect(excluded.map(o => o.id)).toEqual([2, 3])
  })

  it('釘在本趟但被勾掉的單要留在 excluded 那組，清單上才勾得回來', () => {
    const orders = [
      { id: 5, trip_id: 1, trip_excluded: true, created_at: OUT },
      { id: 6, trip_id: 1, trip_excluded: true, created_at: IN },
    ]
    const { included, excluded } = splitOrdersByTrip(orders, tripA)
    expect(included).toEqual([])
    expect(excluded.map(o => o.id)).toEqual([5, 6])
  })

  it('空陣列不炸', () => {
    expect(splitOrdersByTrip([], tripA)).toEqual({ included: [], excluded: [] })
    expect(splitOrdersByTrip(undefined, tripA)).toEqual({ included: [], excluded: [] })
  })
})
