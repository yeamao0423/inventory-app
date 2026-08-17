import { describe, it, expect } from 'vitest'
import { shouldShowStockZeroPrompt } from './stockZeroPrompt'

const base = { nextSkipStockCheck: true, totalStock: 5, snoozedDate: null, today: '2026-08-18' }

describe('shouldShowStockZeroPrompt', () => {
  it('切到略過庫存 + 目前有庫存 + 沒有 snooze → 要問', () => {
    expect(shouldShowStockZeroPrompt(base)).toBe(true)
  })
  it('目標不是略過庫存 → 不用問', () => {
    expect(shouldShowStockZeroPrompt({ ...base, nextSkipStockCheck: false })).toBe(false)
  })
  it('目前庫存為 0 → 不用問', () => {
    expect(shouldShowStockZeroPrompt({ ...base, totalStock: 0 })).toBe(false)
  })
  it('目前庫存為負 → 不用問（沒有正庫存可歸零）', () => {
    expect(shouldShowStockZeroPrompt({ ...base, totalStock: -3 })).toBe(false)
  })
  it('今天已經按過「不再提醒」→ 不用問', () => {
    expect(shouldShowStockZeroPrompt({ ...base, snoozedDate: '2026-08-18' })).toBe(false)
  })
  it('snooze 是別天的 → 還是要問', () => {
    expect(shouldShowStockZeroPrompt({ ...base, snoozedDate: '2026-08-17' })).toBe(true)
  })
})
