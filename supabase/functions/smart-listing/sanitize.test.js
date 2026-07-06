import { describe, it, expect } from 'vitest'
import { parseClaudeJson, sanitizeSuggestion, SUPPORTED_CURRENCIES } from './sanitize.ts'

const CATS = ['藥妝', '零食', '服飾']
const TAGS = ['熱銷', '新品', '限量', '日本', '韓國', '現貨']

const FULL = {
  name: '休足時間 清涼舒緩貼片 18枚入',
  source: 'Kiribai 桐灰',
  desc_zh: '日本藥妝定番舒緩貼片\n清涼薄荷配方\n一盒 18 枚',
  cost: 498,
  currency: 'JPY',
  category_suggestion: '藥妝',
  category_new: null,
  tag_suggestions: ['熱銷', '日本'],
  tag_new_suggestions: [],
  notes: '價標為稅込價',
}

describe('sanitizeSuggestion', () => {
  it('完整合法輸入 → 全欄位保留', () => {
    expect(sanitizeSuggestion(FULL, CATS, TAGS)).toEqual(FULL)
  })

  it('currency 不在白名單 → cost/currency 成對留空', () => {
    const out = sanitizeSuggestion({ ...FULL, currency: 'XYZ' }, CATS, TAGS)
    expect(out.cost).toBeNull()
    expect(out.currency).toBeNull()
  })

  it('cost 缺漏 → currency 也留空（不讓幣別單獨進表單）', () => {
    const out = sanitizeSuggestion({ ...FULL, cost: null }, CATS, TAGS)
    expect(out.cost).toBeNull()
    expect(out.currency).toBeNull()
  })

  it('cost 為字串 → 不轉型，成對留空', () => {
    const out = sanitizeSuggestion({ ...FULL, cost: '498' }, CATS, TAGS)
    expect(out.cost).toBeNull()
    expect(out.currency).toBeNull()
  })

  it('cost 為 0 / 負數 / NaN / Infinity → 留空', () => {
    for (const bad of [0, -10, NaN, Infinity]) {
      expect(sanitizeSuggestion({ ...FULL, cost: bad }, CATS, TAGS).cost).toBeNull()
    }
  })

  it('currency 小寫 → 轉大寫後接受', () => {
    const out = sanitizeSuggestion({ ...FULL, currency: 'jpy' }, CATS, TAGS)
    expect(out.currency).toBe('JPY')
    expect(out.cost).toBe(498)
  })

  it('幻覺分類（不在清單）→ null', () => {
    const out = sanitizeSuggestion({ ...FULL, category_suggestion: '美妝保養' }, CATS, TAGS)
    expect(out.category_suggestion).toBeNull()
  })

  it('幻覺標籤 → 過濾，只留清單內的', () => {
    const out = sanitizeSuggestion(
      { ...FULL, tag_suggestions: ['熱銷', '爆品', '日本', '必買'] },
      CATS, TAGS,
    )
    expect(out.tag_suggestions).toEqual(['熱銷', '日本'])
  })

  it('標籤重複 → 去重且最多 5 個', () => {
    const out = sanitizeSuggestion(
      { ...FULL, tag_suggestions: ['熱銷', '熱銷', '新品', '限量', '日本', '韓國', '現貨'] },
      CATS, TAGS,
    )
    expect(out.tag_suggestions).toEqual(['熱銷', '新品', '限量', '日本', '韓國'])
  })

  it('tag_suggestions 非陣列 → []', () => {
    expect(sanitizeSuggestion({ ...FULL, tag_suggestions: '熱銷' }, CATS, TAGS).tag_suggestions).toEqual([])
  })

  it('name 空白字串 → null', () => {
    expect(sanitizeSuggestion({ ...FULL, name: '   ' }, CATS, TAGS).name).toBeNull()
  })

  it('超長 name → 截斷為 200 字', () => {
    const out = sanitizeSuggestion({ ...FULL, name: 'あ'.repeat(300) }, CATS, TAGS)
    expect(out.name.length).toBe(200)
  })

  it('欄位全缺 / 空物件 → 全空建議', () => {
    expect(sanitizeSuggestion({}, CATS, TAGS)).toEqual({
      name: null, source: null, desc_zh: null, cost: null, currency: null,
      category_suggestion: null, category_new: null,
      tag_suggestions: [], tag_new_suggestions: [], notes: null,
    })
  })

  it('source 非字串 / 空白 → null；超長截斷 100 字', () => {
    expect(sanitizeSuggestion({ ...FULL, source: 42 }, CATS, TAGS).source).toBeNull()
    expect(sanitizeSuggestion({ ...FULL, source: '  ' }, CATS, TAGS).source).toBeNull()
    expect(sanitizeSuggestion({ ...FULL, source: 'B'.repeat(150) }, CATS, TAGS).source.length).toBe(100)
  })

  it('brand_confident 等未知欄位 → 不進消毒後輸出', () => {
    const out = sanitizeSuggestion({ ...FULL, brand_confident: false }, CATS, TAGS)
    expect(out).not.toHaveProperty('brand_confident')
    expect(out.source).toBe(FULL.source)
  })

  it('清單沒有合適分類 → category_new 提議保留', () => {
    const out = sanitizeSuggestion(
      { ...FULL, category_suggestion: null, category_new: '食品' },
      CATS, TAGS,
    )
    expect(out.category_suggestion).toBeNull()
    expect(out.category_new).toBe('食品')
  })

  it('category_new 與現有分類同名 → 轉成一般建議，不重複建立', () => {
    const out = sanitizeSuggestion(
      { ...FULL, category_suggestion: null, category_new: '藥妝' },
      CATS, TAGS,
    )
    expect(out.category_suggestion).toBe('藥妝')
    expect(out.category_new).toBeNull()
  })

  it('category_new 超長（>30 字）→ 截斷', () => {
    const out = sanitizeSuggestion({ ...FULL, category_new: '超'.repeat(50) }, CATS, TAGS)
    expect(out.category_new.length).toBe(30)
  })

  it('tag_new_suggestions：新的保留（去重、最多 3）、已存在的併入一般建議', () => {
    const out = sanitizeSuggestion(
      { ...FULL, tag_suggestions: [], tag_new_suggestions: ['零食', '零食', '現貨', 'Costco', '團購', '爆款'] },
      CATS, TAGS,
    )
    expect(out.tag_suggestions).toEqual(['現貨'])                 // 已存在 → 一般建議
    expect(out.tag_new_suggestions).toEqual(['零食', 'Costco', '團購'])  // 新的，cap 3
  })

  it('tag_new_suggestions 非陣列 / 含非字串 → 安全處理', () => {
    expect(sanitizeSuggestion({ ...FULL, tag_new_suggestions: '零食' }, CATS, TAGS).tag_new_suggestions).toEqual([])
    expect(sanitizeSuggestion({ ...FULL, tag_new_suggestions: [42, null, '  ', '零食'] }, CATS, TAGS).tag_new_suggestions).toEqual(['零食'])
  })

  it('輸入非物件（null / 陣列 / 字串）→ 全空建議', () => {
    for (const bad of [null, [], 'x', 42]) {
      expect(sanitizeSuggestion(bad, CATS, TAGS).name).toBeNull()
    }
  })

  it('categories/tags 清單非陣列 → 建議留空不炸', () => {
    const out = sanitizeSuggestion(FULL, null, undefined)
    expect(out.category_suggestion).toBeNull()
    expect(out.tag_suggestions).toEqual([])
    expect(out.name).toBe(FULL.name)
  })
})

describe('parseClaudeJson', () => {
  it('```json 圍欄包裹 → 正常解析', () => {
    const text = '```json\n{"name":"測試"}\n```'
    expect(parseClaudeJson(text)).toEqual({ name: '測試' })
  })

  it('JSON 前後夾雜文字 → 擷取 {...} 解析', () => {
    const text = '好的，以下是結果：\n{"name":"測試"}\n希望有幫助！'
    expect(parseClaudeJson(text)).toEqual({ name: '測試' })
  })

  it('非 JSON 垃圾 / 空值 → null', () => {
    expect(parseClaudeJson('抱歉我無法辨識')).toBeNull()
    expect(parseClaudeJson('')).toBeNull()
    expect(parseClaudeJson(null)).toBeNull()
  })
})

describe('SUPPORTED_CURRENCIES', () => {
  it('與前端 src/constants/currency.js 同步（13 種）', async () => {
    const frontend = await import('../../../src/constants/currency.js')
    expect(SUPPORTED_CURRENCIES).toEqual(frontend.SUPPORTED_CURRENCIES)
  })
})
