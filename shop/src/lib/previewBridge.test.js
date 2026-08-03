import { describe, it, expect } from 'vitest'
import {
  isSafeOrigin, readPreviewMessage, readHighlightMessage,
  PREVIEW_CONTENT, PREVIEW_HIGHLIGHT,
} from './previewBridge'

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
    expect(readPreviewMessage(msg(), PARENT))
      .toEqual({ content, editing: false, selectedId: null })
  })

  it('編輯模式的旗標從訊息頂層讀（不在 content 裡，那邊會被正規化剝掉）', () => {
    const e = msg({ data: { type: PREVIEW_CONTENT, content, editing: true, selectedId: 'blk-1' } })
    expect(readPreviewMessage(e, PARENT))
      .toEqual({ content, editing: true, selectedId: 'blk-1' })
  })

  it('旗標形狀不對就退回安全值，不讓奇怪的東西流進渲染層', () => {
    const e = msg({ data: { type: PREVIEW_CONTENT, content, editing: 'yes', selectedId: 42 } })
    expect(readPreviewMessage(e, PARENT))
      .toEqual({ content, editing: true, selectedId: null })
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

describe('readHighlightMessage', () => {
  const hi = (data) => ({ origin: PARENT, data })

  it('收到 blockId 就回那個 id', () => {
    expect(readHighlightMessage(hi({ type: PREVIEW_HIGHLIGHT, blockId: 'blk-2' }), PARENT)).toBe('blk-2')
  })

  it('blockId 為 null（滑鼠移開）回 null，與「沒收到訊息」的 undefined 分得開', () => {
    expect(readHighlightMessage(hi({ type: PREVIEW_HIGHLIGHT, blockId: null }), PARENT)).toBe(null)
    expect(readHighlightMessage(hi({ type: PREVIEW_CONTENT, content }), PARENT)).toBe(undefined)
    expect(readHighlightMessage(hi({ type: PREVIEW_HIGHLIGHT }), PARENT)).toBe(null)
  })

  it('來源不符一樣不收', () => {
    const e = { origin: 'https://evil.example.com', data: { type: PREVIEW_HIGHLIGHT, blockId: 'blk-2' } }
    expect(readHighlightMessage(e, PARENT)).toBe(undefined)
  })
})
