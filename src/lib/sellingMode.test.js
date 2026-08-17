import { describe, it, expect } from 'vitest'
import { clampStock, deriveSellingMode } from './sellingMode'

describe('clampStock', () => {
  it('略過庫存時一律歸零，不管傳入什麼值', () => {
    expect(clampStock(5, true)).toBe(0)
    expect(clampStock(-3, true)).toBe(0)
    expect(clampStock(0, true)).toBe(0)
  })
  it('不略過庫存時保留原值', () => {
    expect(clampStock(5, false)).toBe(5)
  })
  it('不略過庫存時空值/非數字視為 0', () => {
    expect(clampStock('', false)).toBe(0)
    expect(clampStock(null, false)).toBe(0)
    expect(clampStock(undefined, false)).toBe(0)
  })
  it('不略過庫存時字串數字要轉型', () => {
    expect(clampStock('12', false)).toBe(12)
  })
})

describe('deriveSellingMode', () => {
  it('有 collectionEnd → collection，不管 skipStockCheck', () => {
    expect(deriveSellingMode({ collectionEnd: '2026-09-01T00:00', skipStockCheck: true })).toBe('collection')
    expect(deriveSellingMode({ collectionEnd: '2026-09-01T00:00', skipStockCheck: false })).toBe('collection')
  })
  it('沒有 collectionEnd 但 skipStockCheck 為真 → preorder', () => {
    expect(deriveSellingMode({ collectionEnd: null, skipStockCheck: true })).toBe('preorder')
    expect(deriveSellingMode({ collectionEnd: '', skipStockCheck: true })).toBe('preorder')
  })
  it('都沒有 → stock', () => {
    expect(deriveSellingMode({ collectionEnd: null, skipStockCheck: false })).toBe('stock')
  })
})
