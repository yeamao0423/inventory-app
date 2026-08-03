import { describe, it, expect } from 'vitest'
import { isSafeOrigin, readPreviewMessage, PREVIEW_CONTENT } from './previewBridge'

const PARENT = 'https://admin.example.com'
const content = { version: 1, blocks: [] }
const msg = (over = {}) => ({ origin: PARENT, data: { type: PREVIEW_CONTENT, content }, ...over })

describe('isSafeOrigin', () => {
  it('接受純 origin', () => {
    expect(isSafeOrigin('https://admin.example.com')).toBe(true)
    expect(isSafeOrigin('http://localhost:5173')).toBe(true)
  })

  it('拒絕帶路徑、非 http(s)、空值', () => {
    expect(isSafeOrigin('https://admin.example.com/x')).toBe(false)
    expect(isSafeOrigin('https://admin.example.com/')).toBe(false)
    expect(isSafeOrigin('javascript:alert(1)')).toBe(false)
    expect(isSafeOrigin('*')).toBe(false)
    expect(isSafeOrigin('')).toBe(false)
    expect(isSafeOrigin(null)).toBe(false)
  })
})

describe('readPreviewMessage', () => {
  it('來源與型別都對才收下內容', () => {
    expect(readPreviewMessage(msg(), PARENT)).toEqual(content)
  })

  it('別的網站丟進來的訊息一律不收', () => {
    expect(readPreviewMessage(msg({ origin: 'https://evil.example.com' }), PARENT)).toBe(null)
  })

  it('parentOrigin 不合法時什麼都不收', () => {
    expect(readPreviewMessage(msg(), '*')).toBe(null)
    expect(readPreviewMessage(msg(), '')).toBe(null)
  })

  it('型別不符或形狀不對就忽略（HMR、擴充套件的雜訊）', () => {
    expect(readPreviewMessage(msg({ data: { type: 'webpack-hmr' } }), PARENT)).toBe(null)
    expect(readPreviewMessage(msg({ data: 'hello' }), PARENT)).toBe(null)
    expect(readPreviewMessage(msg({ data: { type: PREVIEW_CONTENT } }), PARENT)).toBe(null)
    expect(readPreviewMessage(null, PARENT)).toBe(null)
  })
})
