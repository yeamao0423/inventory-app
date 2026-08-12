import { describe, it, expect } from 'vitest'
import { stockKey, buildInTransitMap, needFor } from './procurementNeed'

describe('stockKey', () => {
  it('無規格時 variantId 留空', () => {
    expect(stockKey(42, null)).toBe('42:')
  })
  it('有規格時帶上 variantId', () => {
    expect(stockKey(42, 117)).toBe('42:117')
  })
})

describe('needFor', () => {
  it('庫存為正 → 不用買', () => {
    expect(needFor(3, 0)).toBe(0)
  })
  it('庫存為負 → 要買負的那些', () => {
    expect(needFor(-12, 0)).toBe(12)
  })
  it('在途量先抵掉', () => {
    expect(needFor(-8, 5)).toBe(3)
  })
  it('在途量超過缺口 → 不用再買', () => {
    expect(needFor(-2, 5)).toBe(0)
  })
  it('null 當 0 處理', () => {
    expect(needFor(null, null)).toBe(0)
  })
  it('庫存為正又有在途 → 仍然不用買', () => {
    expect(needFor(4, 3)).toBe(0)
  })
})

describe('buildInTransitMap', () => {
  const items = [
    // 已入庫的批次不算在途
    { product_id: 1, variant_id: null, quantity: 5, actual_qty: 5, status: 'bought', batch: { inventory_synced: true } },
    // 未入庫、已買到 → 用 actual_qty
    { product_id: 2, variant_id: null, quantity: 5, actual_qty: 3, status: 'partial', batch: { inventory_synced: false } },
    // 未入庫、還沒去買 → 用 quantity
    { product_id: 3, variant_id: 9, quantity: 4, actual_qty: null, status: 'pending', batch: { inventory_synced: false } },
    // 沒買到 → 不算
    { product_id: 4, variant_id: null, quantity: 6, actual_qty: 0, status: 'missed', batch: { inventory_synced: false } },
  ]

  it('已入庫的批次不列入在途', () => {
    expect(buildInTransitMap(items)['1:']).toBeUndefined()
  })
  it('partial 用 actual_qty', () => {
    expect(buildInTransitMap(items)['2:']).toBe(3)
  })
  it('pending 用 quantity', () => {
    expect(buildInTransitMap(items)['3:9']).toBe(4)
  })
  it('missed 不算', () => {
    expect(buildInTransitMap(items)['4:']).toBeUndefined()
  })
  it('同一個 key 多筆會累加', () => {
    const dup = [
      { product_id: 7, variant_id: null, quantity: 2, actual_qty: 2, status: 'bought', batch: { inventory_synced: false } },
      { product_id: 7, variant_id: null, quantity: 3, actual_qty: 3, status: 'bought', batch: { inventory_synced: false } },
    ]
    expect(buildInTransitMap(dup)['7:']).toBe(5)
  })
  it('bought 但沒填 actual_qty → 退回用 quantity', () => {
    const noActual = [{ product_id: 9, variant_id: null, quantity: 6, actual_qty: null, status: 'bought', batch: { inventory_synced: false } }]
    expect(buildInTransitMap(noActual)['9:']).toBe(6)
  })
  it('batch 為 null 時視為未入庫', () => {
    const orphan = [{ product_id: 8, variant_id: null, quantity: 1, actual_qty: 1, status: 'bought', batch: null }]
    expect(buildInTransitMap(orphan)['8:']).toBe(1)
  })
})
