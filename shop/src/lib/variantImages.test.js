import { describe, it, expect } from 'vitest'
import { imageMatches, repImageFor, visibleImages } from './variantImages'

// 規格維度：3 = 顏色（7 藍、9 紅、11 綠），5 = 尺寸（21 M、22 L）
const COLOR = 3
const SIZE = 5
const BLUE = 7
const RED = 9
const GREEN = 11

function img(id, tagFilter = null) {
  return { id, url: `https://img.example/${id}.jpg`, sort_order: id, tag_filter: tagFilter }
}

const blueImg = img(1, { [COLOR]: [BLUE] })
const redImg = img(2, { [COLOR]: [RED] })
const sharedImg = img(3, null) // 共用圖：任何規格都顯示

describe('imageMatches', () => {
  it('tag_filter 為 null 或 undefined 是共用圖，任何規格都顯示', () => {
    expect(imageMatches(img(1, null), { [COLOR]: BLUE })).toBe(true)
    expect(imageMatches({ id: 1, url: 'x' }, { [COLOR]: BLUE })).toBe(true)
  })

  it('該維度有設限且選中的值在允許清單內 → 顯示', () => {
    expect(imageMatches(blueImg, { [COLOR]: BLUE })).toBe(true)
    expect(imageMatches(img(1, { [COLOR]: [BLUE, RED] }), { [COLOR]: RED })).toBe(true)
  })

  it('該維度有設限但選中的值不在允許清單內 → 不顯示', () => {
    expect(imageMatches(blueImg, { [COLOR]: RED })).toBe(false)
  })

  it('該維度有設限但目前根本沒選那個維度 → 視為不設限', () => {
    expect(imageMatches(blueImg, {})).toBe(true)
    expect(imageMatches(blueImg, { [SIZE]: 21 })).toBe(true)
  })

  it('允許清單是空陣列 → 視為不設限（店主綁了維度卻沒挑值）', () => {
    expect(imageMatches(img(1, { [COLOR]: [] }), { [COLOR]: BLUE })).toBe(true)
  })

  it('多個維度都要同時成立才顯示', () => {
    const both = img(1, { [COLOR]: [BLUE], [SIZE]: [21] })
    expect(imageMatches(both, { [COLOR]: BLUE, [SIZE]: 21 })).toBe(true)
    expect(imageMatches(both, { [COLOR]: BLUE, [SIZE]: 22 })).toBe(false)
  })

  it('選中的值是字串而清單是數字時仍比對得上（既有的寬鬆型別行為）', () => {
    expect(imageMatches(img(1, { [COLOR]: [7] }), { [COLOR]: '7' })).toBe(true)
    expect(imageMatches(img(1, { [COLOR]: ['7'] }), { [COLOR]: 7 })).toBe(true)
  })

  // tag_filter 是店主在後台手動綁的欄位，壞資料是前提不是例外：
  // 看不懂的一律當作不設限，絕不能丟例外把整個圖庫炸掉。
  it('tag_filter 是字串或數字這種壞資料 → 當作不設限，不丟例外', () => {
    expect(imageMatches(img(1, '藍色'), { [COLOR]: BLUE })).toBe(true)
    expect(imageMatches(img(1, 123), { [COLOR]: BLUE })).toBe(true)
  })

  it('tag_filter 是陣列這種壞資料 → 當作不設限，不丟例外', () => {
    expect(imageMatches(img(1, []), { [COLOR]: BLUE })).toBe(true)
    expect(imageMatches(img(1, [BLUE, RED]), { [COLOR]: BLUE })).toBe(true)
  })

  it('img 是 null / undefined → 不丟例外', () => {
    expect(imageMatches(null, { [COLOR]: BLUE })).toBe(true)
    expect(imageMatches(undefined, { [COLOR]: BLUE })).toBe(true)
  })

  it('selectedOptions 是 null / undefined → 當作什麼都沒選，不丟例外', () => {
    expect(imageMatches(blueImg, null)).toBe(true)
    expect(imageMatches(blueImg, undefined)).toBe(true)
  })
})

describe('repImageFor', () => {
  it('回傳第一張綁到該規格值的圖（images 已依 sort_order 排序，取最前面那張）', () => {
    const first = img(1, { [COLOR]: [BLUE] })
    const second = img(2, { [COLOR]: [BLUE] })
    expect(repImageFor([first, second], COLOR, BLUE)).toBe(first)
  })

  it('允許清單含多個值時，綁到其中之一就算命中', () => {
    const multi = img(1, { [COLOR]: [BLUE, RED] })
    expect(repImageFor([multi], COLOR, RED)).toBe(multi)
  })

  it('沒有任何圖綁到該值 → null（chip 就只有文字）', () => {
    expect(repImageFor([blueImg, sharedImg], COLOR, GREEN)).toBe(null)
  })

  it('共用圖（tag_filter 為 null）不算某個規格值的代表圖', () => {
    expect(repImageFor([sharedImg], COLOR, BLUE)).toBe(null)
  })

  it('圖的 tag_filter 沒有該維度的 key → 不算命中', () => {
    expect(repImageFor([img(1, { [SIZE]: [21] })], COLOR, BLUE)).toBe(null)
  })

  it('images 是 null 或空陣列 → null，不丟例外', () => {
    expect(repImageFor(null, COLOR, BLUE)).toBe(null)
    expect(repImageFor(undefined, COLOR, BLUE)).toBe(null)
    expect(repImageFor([], COLOR, BLUE)).toBe(null)
  })

  it('typeId／valueId 傳字串也比對得上', () => {
    expect(repImageFor([blueImg], String(COLOR), String(BLUE))).toBe(blueImg)
  })
})

describe('visibleImages', () => {
  const all = [blueImg, redImg, sharedImg]

  it('有符合的圖就只顯示符合的', () => {
    expect(visibleImages(all, { [COLOR]: RED })).toEqual([redImg, sharedImg])
  })

  it('共用圖與規格專屬圖混在一起時，兩種都會留下', () => {
    const result = visibleImages(all, { [COLOR]: BLUE })
    expect(result).toContain(blueImg)   // 該規格的專屬圖
    expect(result).toContain(sharedImg) // 沒綁任何規格的共用圖
    expect(result).not.toContain(redImg)
  })

  // 這是這支函式存在的理由：選到的規格既沒有專屬圖、這件商品也沒有任何共用圖時，
  // 過濾結果會是空的。此時必須退回全部，否則整個圖庫會消失、頁面開一個天窗。
  it('一張都不符合時退回全部 —— 該規格沒有專屬圖也沒有共用圖，不能開天窗', () => {
    const onlyTagged = [blueImg, redImg] // 沒有共用圖
    expect(visibleImages(onlyTagged, { [COLOR]: GREEN })).toEqual(onlyTagged)
  })

  it('沒有任何規格設限時，全部照原順序顯示', () => {
    expect(visibleImages(all, {})).toEqual(all)
  })

  it('空陣列或 null 輸入 → 回空陣列，不丟例外', () => {
    expect(visibleImages([], { [COLOR]: BLUE })).toEqual([])
    expect(visibleImages(null, { [COLOR]: BLUE })).toEqual([])
    expect(visibleImages(undefined, { [COLOR]: BLUE })).toEqual([])
  })

  it('selectedOptions 是 null → 當作什麼都沒選，全部顯示', () => {
    expect(visibleImages(all, null)).toEqual(all)
  })

  it('不會改動傳進來的陣列', () => {
    const input = [blueImg, redImg, sharedImg]
    visibleImages(input, { [COLOR]: BLUE })
    expect(input).toEqual([blueImg, redImg, sharedImg])
  })
})
