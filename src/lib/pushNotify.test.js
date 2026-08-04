// 推播支援度判斷。
//
// 這裡釘住的是一個真實踩過的坑：線上漏設 VITE_VAPID_PUBLIC_KEY 時，
// 收件匣顯示「此裝置不支援推播」，害人以為是手機或「加入主畫面」沒做對，
// 實際上是部署設定漏了。裝置能力與設定完整性必須分開回報。
import { describe, it, expect } from 'vitest'
import { evaluateSupport } from './pushNotify'

const capable = {
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  hasVapidKey: true,
}

describe('evaluateSupport', () => {
  it('四項都齊全時可以推播', () => {
    expect(evaluateSupport(capable)).toEqual({ device: true, configured: true, supported: true })
  })

  it('裝置有能力但漏設 VAPID 公鑰：不可歸咎於裝置', () => {
    const r = evaluateSupport({ ...capable, hasVapidKey: false })
    expect(r.device).toBe(true)      // ← 裝置沒問題，訊息不該說「此裝置不支援」
    expect(r.configured).toBe(false) // ← 問題在設定
    expect(r.supported).toBe(false)
  })

  it('設定齊全但裝置沒有 PushManager（iOS 未加入主畫面）', () => {
    const r = evaluateSupport({ ...capable, hasPushManager: false })
    expect(r.device).toBe(false)
    expect(r.configured).toBe(true)
    expect(r.supported).toBe(false)
  })

  it.each(['hasServiceWorker', 'hasPushManager', 'hasNotification'])(
    '缺少 %s 就不算裝置有能力',
    (missing) => {
      expect(evaluateSupport({ ...capable, [missing]: false }).device).toBe(false)
    },
  )

  it('兩邊都缺時兩個旗標都是 false', () => {
    expect(evaluateSupport({})).toEqual({ device: false, configured: false, supported: false })
  })

  it('回傳的是布林值，不是 undefined 之類的假值', () => {
    const r = evaluateSupport({})
    expect(typeof r.device).toBe('boolean')
    expect(typeof r.configured).toBe('boolean')
    expect(typeof r.supported).toBe('boolean')
  })
})
