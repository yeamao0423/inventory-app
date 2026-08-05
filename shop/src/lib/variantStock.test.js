import { describe, it, expect } from 'vitest'
import { isValueSoldOut, initialOptions, valuesForType } from './variantStock'

// 兩個維度：1 = 尺寸（S=10、M=11、L=12），2 = 顏色（黑=20、白=21）
const SIZE = {
  id: 1,
  name: '尺寸',
  variant_option_values: [
    { id: 10, value: 'S', sort_order: 1 },
    { id: 11, value: 'M', sort_order: 2 },
    { id: 12, value: 'L', sort_order: 3 },
  ],
}
const COLOR = {
  id: 2,
  name: '顏色',
  variant_option_values: [
    { id: 20, value: '黑', sort_order: 1 },
    { id: 21, value: '白', sort_order: 2 },
  ],
}

function v(id, size, color, stock) {
  return { id, options: { 1: size, 2: color }, stock }
}

// S 黑缺貨、S 白有貨、M 全缺貨、L 黑有貨
const VARIANTS = [
  v(1, 10, 20, 0),
  v(2, 10, 21, 3),
  v(3, 11, 20, 0),
  v(4, 11, 21, 0),
  v(5, 12, 20, 5),
]

describe('isValueSoldOut — 這個規格值在目前的其他選擇下還有沒有貨', () => {
  it('預購／收單商品（skipStock）一律不算缺貨', () => {
    expect(isValueSoldOut(VARIANTS, { 1: 11 }, 1, 11, true)).toBe(false)
    expect(isValueSoldOut([], {}, 1, 99, true)).toBe(false)
  })

  it('沒有任何 variant 對得上這個值 → 缺貨', () => {
    expect(isValueSoldOut(VARIANTS, {}, 1, 99, false)).toBe(true)
  })

  it('對得上但全部 stock <= 0 → 缺貨', () => {
    expect(isValueSoldOut(VARIANTS, {}, 1, 11, false)).toBe(true)
  })

  it('只要有一個有貨就不算缺貨', () => {
    expect(isValueSoldOut(VARIANTS, {}, 1, 10, false)).toBe(false)
  })

  it('會受其他維度目前的選擇限制：選了黑色時 S 就缺貨了', () => {
    expect(isValueSoldOut(VARIANTS, { 2: 20 }, 1, 10, false)).toBe(true)
    expect(isValueSoldOut(VARIANTS, { 2: 21 }, 1, 10, false)).toBe(false)
  })

  it('自己這個維度目前選了什麼不影響判斷', () => {
    expect(isValueSoldOut(VARIANTS, { 1: 11 }, 1, 10, false)).toBe(false)
  })

  it('某維度在 variant 上沒有值時不設限（undefined 不算不匹配）', () => {
    const mixed = [{ id: 9, options: { 1: 10 }, stock: 4 }]
    expect(isValueSoldOut(mixed, { 2: 20 }, 1, 10, false)).toBe(false)
  })

  it('selectedOptions 或 variants 是空的也不丟例外', () => {
    expect(isValueSoldOut(null, null, 1, 10, false)).toBe(true)
    expect(isValueSoldOut(VARIANTS, null, 1, 10, false)).toBe(false)
  })
})

describe('valuesForType — 這件商品在該維度實際用到的值，依 sort_order 排', () => {
  it('只回 variants 用到的值，並照 sort_order 排序', () => {
    const only = [v(1, 12, 20, 1), v(2, 10, 20, 1)]
    expect(valuesForType(SIZE, only).map(x => x.value)).toEqual(['S', 'L'])
  })

  it('沒有 variants 時回空陣列', () => {
    expect(valuesForType(SIZE, [])).toEqual([])
    expect(valuesForType(SIZE, null)).toEqual([])
  })
})

describe('initialOptions — 每個維度挑第一個還有貨的值', () => {
  it('跳過缺貨的值，挑第一個有貨的', () => {
    // 尺寸：S 有貨（S 白）→ 選 S；顏色在 S 之下只有白有貨 → 選白
    expect(initialOptions(VARIANTS, [SIZE, COLOR], false)).toEqual({ 1: 10, 2: 21 })
  })

  it('全部缺貨時退回第一個值，不是留空', () => {
    const allGone = VARIANTS.map(x => ({ ...x, stock: 0 }))
    expect(initialOptions(allGone, [SIZE], false)).toEqual({ 1: 10 })
  })

  it('skipStock 為真時直接取第一個（預購商品不看庫存數字）', () => {
    const allGone = VARIANTS.map(x => ({ ...x, stock: 0 }))
    expect(initialOptions(allGone, [SIZE, COLOR], true)).toEqual({ 1: 10, 2: 20 })
  })

  it('沒有規格維度時回空物件', () => {
    expect(initialOptions(VARIANTS, [], false)).toEqual({})
  })

  it('該維度在這件商品上沒有任何值時不塞 key', () => {
    const onlySize = [{ id: 1, options: { 1: 10 }, stock: 1 }]
    expect(initialOptions(onlySize, [SIZE, COLOR], false)).toEqual({ 1: 10 })
  })
})
