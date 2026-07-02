import { describe, it, expect } from 'vitest'
import {
  renderTemplate,
  buildShareUrl,
  buildProductUrl,
  resolveShopBaseUrl,
  DEFAULT_SHARE_TEMPLATE,
} from './socialShare'

describe('renderTemplate', () => {
  it('代入所有變數', () => {
    const out = renderTemplate(DEFAULT_SHARE_TEMPLATE, {
      name: '日本限定餅乾', price: 580, link: 'https://x.com/products/12',
    })
    expect(out).toContain('日本限定餅乾')
    expect(out).toContain('NT$580')
    expect(out).toContain('https://x.com/products/12')
  })

  it('售價加千分位', () => {
    expect(renderTemplate('{售價}', { price: 12800 })).toBe('12,800')
  })

  it('缺值變數代為空字串', () => {
    expect(renderTemplate('A{商品名稱}B', {})).toBe('AB')
  })

  it('未知變數原樣保留', () => {
    expect(renderTemplate('{不存在}', { name: 'x' })).toBe('{不存在}')
  })

  it('店名變數', () => {
    expect(renderTemplate('{商店名稱}', { storeName: 'Daigoking' })).toBe('Daigoking')
  })
})

describe('buildShareUrl', () => {
  it('Line 帶整段文字並 encode', () => {
    const url = buildShareUrl('line', 'hi 你好\nhttps://x.com/p/1')
    expect(url.startsWith('https://line.me/R/msg/text/?')).toBe(true)
    expect(url).toContain(encodeURIComponent('hi 你好\nhttps://x.com/p/1'))
  })

  it('Threads 帶 text', () => {
    expect(buildShareUrl('threads', 'abc')).toBe('https://www.threads.net/intent/post?text=abc')
  })

  it('Facebook 只帶網址', () => {
    expect(buildShareUrl('facebook', 'ignored', 'https://x.com/p/1'))
      .toBe('https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent('https://x.com/p/1'))
  })

  it('未知平台回空字串', () => {
    expect(buildShareUrl('instagram', 'x', 'y')).toBe('')
  })
})

describe('resolveShopBaseUrl', () => {
  it('有自訂網域優先（自動補 https）', () => {
    expect(resolveShopBaseUrl({ custom_domain: 'shop.abc.com', slug: 's' })).toBe('https://shop.abc.com')
  })

  it('自訂網域已含協定則保留、去尾斜線', () => {
    expect(resolveShopBaseUrl({ custom_domain: 'https://shop.abc.com/', slug: 's' })).toBe('https://shop.abc.com')
  })

  it('無自訂網域用 slug 子網域', () => {
    expect(resolveShopBaseUrl({ slug: 'daigoking' })).toBe('https://daigoking.daigogotw.com')
  })

  it('無資料回空字串', () => {
    expect(resolveShopBaseUrl(null)).toBe('')
  })
})

describe('buildProductUrl', () => {
  it('組商品連結', () => {
    expect(buildProductUrl('https://daigoking.daigogotw.com', 42))
      .toBe('https://daigoking.daigogotw.com/products/42')
  })

  it('base 去尾斜線', () => {
    expect(buildProductUrl('https://x.com/', 7)).toBe('https://x.com/products/7')
  })

  it('無 base 回空字串', () => {
    expect(buildProductUrl('', 7)).toBe('')
  })
})
