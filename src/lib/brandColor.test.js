import { describe, it, expect } from 'vitest'
import {
  BRAND_PRESETS, DEFAULT_BRAND_COLOR,
  normalizeHex, relativeLuminance, contrastRatio, foregroundFor, mixWithWhite, brandVars,
} from './brandColor'

describe('normalizeHex', () => {
  it('補上 #、補齊三碼縮寫、統一小寫', () => {
    expect(normalizeHex('#ABCDEF')).toBe('#abcdef')
    expect(normalizeHex('abcdef')).toBe('#abcdef')
    expect(normalizeHex('#f00')).toBe('#ff0000')
    expect(normalizeHex('  #0A0b0C  ')).toBe('#0a0b0c')
  })

  it('壞值回 null（呼叫端據此退回預設色，不是把壞字串塞進 CSS）', () => {
    expect(normalizeHex('')).toBe(null)
    expect(normalizeHex(null)).toBe(null)
    expect(normalizeHex(undefined)).toBe(null)
    expect(normalizeHex(123)).toBe(null)
    expect(normalizeHex('#12345')).toBe(null)
    expect(normalizeHex('#gggggg')).toBe(null)
    expect(normalizeHex('red')).toBe(null)
    // CSS 注入：分號想跳出宣告，必須在這裡就被擋下
    expect(normalizeHex('#fff;background:url(x)')).toBe(null)
    expect(normalizeHex('rgb(1,2,3)')).toBe(null)
  })
})

describe('relativeLuminance / contrastRatio — WCAG', () => {
  it('黑白的亮度是 0 與 1', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5)
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5)
  })

  it('黑白對比是 21:1，自己對自己是 1:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 2)
    expect(contrastRatio('#123456', '#123456')).toBeCloseTo(1, 5)
  })

  it('對比與順序無關', () => {
    expect(contrastRatio('#ff0000', '#ffffff')).toBeCloseTo(contrastRatio('#ffffff', '#ff0000'), 6)
  })
})

describe('foregroundFor — 自動決定前景色', () => {
  it('深色主色配白字', () => {
    expect(foregroundFor('#1a1a1a')).toBe('#ffffff')
    expect(foregroundFor('#0b5cd5')).toBe('#ffffff')
    expect(foregroundFor('#8a2be2')).toBe('#ffffff')
  })

  it('淺色主色配深字 —— 這就是「店主選淺黃色，白字按鈕看不見」要解的問題', () => {
    expect(foregroundFor('#ffe680')).toBe('#111111')
    expect(foregroundFor('#ffffff')).toBe('#111111')
    expect(foregroundFor('#f5f5dc')).toBe('#111111')
    expect(foregroundFor('#00ff00')).toBe('#111111')
  })

  it('選出來的前景色一定是兩個候選中對比較高的那個', () => {
    const samples = ['#ffe680', '#1a1a1a', '#7f7f7f', '#0b5cd5', '#00ff00', '#c0392b']
    for (const hex of samples) {
      const fg = foregroundFor(hex)
      const other = fg === '#ffffff' ? '#111111' : '#ffffff'
      expect(contrastRatio(hex, fg)).toBeGreaterThanOrEqual(contrastRatio(hex, other))
    }
  })

  it('壞值不丟例外，退回白字（配預設深色主色）', () => {
    expect(foregroundFor('nope')).toBe('#ffffff')
    expect(foregroundFor(null)).toBe('#ffffff')
  })

  it('所有預設色票的按鈕對比都達到 WCAG AA（4.5:1）', () => {
    for (const preset of BRAND_PRESETS) {
      const fg = foregroundFor(preset.hex)
      expect(contrastRatio(preset.hex, fg)).toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe('mixWithWhite — 徽章底色', () => {
  it('比例 0 是白色、1 是原色', () => {
    expect(mixWithWhite('#123456', 0)).toBe('#ffffff')
    expect(mixWithWhite('#123456', 1)).toBe('#123456')
  })

  it('會產生比原色淺的顏色', () => {
    const soft = mixWithWhite('#0b5cd5', 0.12)
    expect(relativeLuminance(soft)).toBeGreaterThan(relativeLuminance('#0b5cd5'))
  })

  it('壞值回 null', () => {
    expect(mixWithWhite('nope', 0.5)).toBe(null)
  })
})

describe('brandVars — 給 CSS 變數用', () => {
  it('沒設定主色時回 null，商城就完全不注入樣式（維持既有外觀）', () => {
    expect(brandVars(null)).toBe(null)
    expect(brandVars('')).toBe(null)
    expect(brandVars('#zzz')).toBe(null)
  })

  it('設定後吐出主色、前景色與淡底色', () => {
    const vars = brandVars('#0b5cd5')
    expect(vars['--brand']).toBe('#0b5cd5')
    expect(vars['--brand-fg']).toBe('#ffffff')
    expect(vars['--brand-soft']).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('淺色主色的文字色會被壓深，避免淺黃色連結在白底上看不見', () => {
    const vars = brandVars('#ffe680')
    expect(vars['--brand']).toBe('#ffe680')
    expect(vars['--brand-fg']).toBe('#111111')
    // 連結／價格是畫在白底上的文字，必須另外挑一個對白底夠深的顏色
    expect(contrastRatio(vars['--brand-text'], '#ffffff')).toBeGreaterThanOrEqual(4.5)
  })

  it('深色主色時文字色就是主色本身', () => {
    expect(brandVars('#0b5cd5')['--brand-text']).toBe('#0b5cd5')
  })

  it('預設色票每一個都能產生完整的變數組，且文字色對白底都達 AA', () => {
    for (const preset of BRAND_PRESETS) {
      const vars = brandVars(preset.hex)
      expect(vars).not.toBe(null)
      expect(contrastRatio(vars['--brand-text'], '#ffffff')).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('預設主色本身也是合法的', () => {
    expect(normalizeHex(DEFAULT_BRAND_COLOR)).toBe(DEFAULT_BRAND_COLOR)
  })

  it('色票數量落在 8–10 之間、hex 都合法、名稱不重複', () => {
    expect(BRAND_PRESETS.length).toBeGreaterThanOrEqual(8)
    expect(BRAND_PRESETS.length).toBeLessThanOrEqual(10)
    for (const p of BRAND_PRESETS) expect(normalizeHex(p.hex)).toBe(p.hex)
    expect(new Set(BRAND_PRESETS.map(p => p.name)).size).toBe(BRAND_PRESETS.length)
  })
})
