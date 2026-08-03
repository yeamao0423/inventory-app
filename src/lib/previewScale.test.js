import { describe, it, expect } from 'vitest'
import { DEVICES, computeScale } from './previewScale'

describe('DEVICES', () => {
  it('三段裝置寬度要落在商城斷點的正確那一側', () => {
    // 商城桌機斷點 901px / 1024px（shop globals.css），桌機預覽必須大於它們，
    // 否則 iframe 又會渲染成手機版 —— 這正是這次要修的 bug
    expect(DEVICES.desktop.width).toBeGreaterThan(1024)
    expect(DEVICES.tablet.width).toBeGreaterThan(768)
    expect(DEVICES.tablet.width).toBeLessThan(901)
    expect(DEVICES.mobile.width).toBeLessThan(768)
  })

  it('每個裝置都有給店主看的中文標籤', () => {
    for (const key of Object.keys(DEVICES)) {
      expect(typeof DEVICES[key].label).toBe('string')
      expect(DEVICES[key].label.length).toBeGreaterThan(0)
    }
  })
})

describe('computeScale', () => {
  it('容器放不下時等比縮小', () => {
    expect(computeScale(640, 1280)).toBe(0.5)
    expect(computeScale(960, 1280)).toBe(0.75)
    expect(computeScale(390, 780)).toBe(0.5)
  })

  it('容器比裝置寬時不放大（1280px 的預覽不該被拉成 1600px）', () => {
    expect(computeScale(1600, 1280)).toBe(1)
    expect(computeScale(1280, 1280)).toBe(1)
    expect(computeScale(900, 390)).toBe(1)
  })

  it('容器寬度是 0 或負數時回 1，不回 0', () => {
    // height: calc(100% / var(--lp-scale)) 除以零會讓畫布整個崩掉；
    // ResizeObserver 第一次回報時寬度就是 0，這是常態
    expect(computeScale(0, 1280)).toBe(1)
    expect(computeScale(-100, 1280)).toBe(1)
  })

  it('裝置寬度壞掉時也回 1（DEVICES 查不到 key 的情況）', () => {
    expect(computeScale(640, 0)).toBe(1)
    expect(computeScale(640, -1)).toBe(1)
    expect(computeScale(640, undefined)).toBe(1)
  })

  it('NaN、Infinity、非數字一律回 1', () => {
    expect(computeScale(NaN, 1280)).toBe(1)
    expect(computeScale(640, NaN)).toBe(1)
    expect(computeScale(Infinity, 1280)).toBe(1)
    expect(computeScale(640, Infinity)).toBe(1)
    expect(computeScale('640', 1280)).toBe(1)
    expect(computeScale(null, 1280)).toBe(1)
    expect(computeScale(undefined, 1280)).toBe(1)
    expect(computeScale({}, 1280)).toBe(1)
    expect(computeScale([], 1280)).toBe(1)
    expect(computeScale()).toBe(1)
  })

  it('回傳值永遠是正數且不超過 1', () => {
    const inputs = [0, -5, 1, 100, 390, 834, 1280, 4000, NaN, undefined, '650']
    for (const c of inputs) {
      for (const key of Object.keys(DEVICES)) {
        const s = computeScale(c, DEVICES[key].width)
        expect(s).toBeGreaterThan(0)
        expect(s).toBeLessThanOrEqual(1)
      }
    }
  })
})
