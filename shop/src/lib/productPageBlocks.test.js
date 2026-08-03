// 商品頁要畫哪一份內容 —— 解析順序與遷移的產出形狀。
//
// 這裡測的是整個功能的安全閥：解析回 null 時商品頁走的是原本的 ProductDetail，
// 也就是「沒編排過的店，畫面一個像素都不會變」。這條路徑壞掉是全店級別的事故，
// 所以邊界（空陣列 vs null、壞資料、未知型別）一條一條寫清楚。
import { describe, it, expect } from 'vitest'
import {
  resolveProductContent, mergeIntroIntoTemplate, buildProductTemplate,
  normalizeContent, CONTENT_VERSION,
} from './contentBlocks'

const content = (...types) => ({
  version: CONTENT_VERSION,
  blocks: types.map((type, i) => ({ id: `${type}-${i}`, type })),
})

describe('resolveProductContent', () => {
  it('覆寫優先於範本', () => {
    const out = resolveProductContent({
      override: content('product_title'),
      template: content('product_gallery'),
    })
    expect(out.blocks.map(b => b.type)).toEqual(['product_title'])
  })

  it('沒有覆寫就用範本', () => {
    const out = resolveProductContent({ override: null, template: content('product_gallery') })
    expect(out.blocks.map(b => b.type)).toEqual(['product_gallery'])
  })

  it('兩邊都沒編過回 null —— 呼叫端據此走內建版型', () => {
    expect(resolveProductContent({ override: null, template: null })).toBe(null)
    expect(resolveProductContent({})).toBe(null)
  })

  it('覆寫是空陣列＝店主刻意清空，不偷偷 fallback 回範本', () => {
    const out = resolveProductContent({
      override: { version: 1, blocks: [] },
      template: content('product_gallery', 'product_cta'),
    })
    expect(out).not.toBe(null)
    expect(out.blocks).toEqual([])
  })

  it('範本本身是空陣列時同理：空版面不等於沒編過', () => {
    const out = resolveProductContent({ override: null, template: { version: 1, blocks: [] } })
    expect(out.blocks).toEqual([])
  })

  it('覆寫根本不是內容（字串／陣列／數字）時當作沒有覆寫，落到範本', () => {
    const template = content('product_cta')
    for (const override of ['x', [], 42]) {
      expect(resolveProductContent({ override, template }).blocks.map(b => b.type))
        .toEqual(['product_cta'])
    }
  })

  it('覆寫是物件但沒有 blocks 陣列 → 視同空版面，不是「沒編過」', () => {
    // 這是形狀對、內容空的資料（例如編輯器存了 { version: 1 }）。
    // 它與 null 的差別會決定客人看到範本還是一片空白，所以刻意在這裡釘住。
    const out = resolveProductContent({ override: { version: 1 }, template: content('product_cta') })
    expect(out.blocks).toEqual([])
  })

  it('動態區塊只有商品頁放行：同一份內容給首頁的正規化會被清空', () => {
    const raw = content('product_gallery', 'hero')
    expect(resolveProductContent({ template: raw }).blocks.map(b => b.type))
      .toEqual(['product_gallery', 'hero'])
    expect(normalizeContent(raw).blocks.map(b => b.type)).toEqual(['hero'])
  })

  it('未知型別被丟掉，其餘照畫', () => {
    const raw = { version: 1, blocks: [{ type: 'product_title' }, { type: 'product_video' }, { type: 'text' }] }
    expect(resolveProductContent({ template: raw }).blocks.map(b => b.type))
      .toEqual(['product_title', 'text'])
  })

  it('舊資料沒有 span 就補 12（＝加這個欄位之前的全寬行為）', () => {
    const out = resolveProductContent({ template: content('product_title') })
    expect(out.blocks[0].span).toBe(12)
  })

  it('span 超出範圍或不是數字時退回 12', () => {
    const raw = { version: 1, blocks: [
      { type: 'product_title', span: 0 },
      { type: 'product_price', span: 13 },
      { type: 'product_desc', span: '6' },
      { type: 'product_cta', span: null },
    ] }
    expect(resolveProductContent({ template: raw }).blocks.map(b => b.span)).toEqual([12, 12, 6, 12])
  })
})

describe('buildProductTemplate', () => {
  it('重建目前的商品頁：九個動態區塊、桌機各半', () => {
    const tpl = buildProductTemplate()
    expect(tpl.version).toBe(CONTENT_VERSION)
    expect(tpl.blocks.map(b => b.type)).toEqual([
      'product_gallery', 'product_title', 'product_price', 'product_desc',
      'product_options', 'product_status', 'product_qty', 'product_note', 'product_cta',
    ])
    expect(tpl.blocks.every(b => b.span === 6)).toBe(true)
    expect(new Set(tpl.blocks.map(b => b.id)).size).toBe(tpl.blocks.length)
  })
})

describe('mergeIntroIntoTemplate', () => {
  const intro = { version: 1, blocks: [{ type: 'text', title: '購買須知', body: '出貨時間' }] }

  it('intro 接在範本最後、各佔滿版一列（＝它今天顯示的位置）', () => {
    const out = mergeIntroIntoTemplate(content('product_gallery', 'product_cta'), intro)
    expect(out.blocks.map(b => b.type)).toEqual(['product_gallery', 'product_cta', 'text'])
    expect(out.blocks.at(-1).span).toBe(12)
    expect(out.blocks.at(-1).title).toBe('購買須知')
  })

  it('接進來的區塊拿到新的 id，不會跟範本裡的撞在一起', () => {
    const out = mergeIntroIntoTemplate(content('text'), intro)
    expect(new Set(out.blocks.map(b => b.id)).size).toBe(out.blocks.length)
  })

  it('沒有 intro（null／空／壞資料）就原樣回範本', () => {
    const base = content('product_cta')
    for (const raw of [null, { version: 1, blocks: [] }, 'x']) {
      expect(mergeIntroIntoTemplate(base, raw).blocks.map(b => b.type)).toEqual(['product_cta'])
    }
  })

  it('範本是空的（還沒編過）就從預設版型長出來，不會只剩 intro', () => {
    const out = mergeIntroIntoTemplate(null, intro)
    expect(out.blocks[0].type).toBe('product_gallery')
    expect(out.blocks.at(-1).type).toBe('text')
  })

  it('intro 裡的動態區塊不放行（intro 本來就只有靜態那四種）', () => {
    const out = mergeIntroIntoTemplate(content('product_cta'), content('product_gallery', 'text'))
    expect(out.blocks.map(b => b.type)).toEqual(['product_cta', 'text'])
  })

  it('合併後仍受區塊數上限保護', () => {
    const many = { version: 1, blocks: Array.from({ length: 80 }, () => ({ type: 'text' })) }
    expect(mergeIntroIntoTemplate(buildProductTemplate(), many).blocks.length).toBeLessThanOrEqual(60)
  })
})
