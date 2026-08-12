import { describe, it, expect, beforeEach } from 'vitest'
import {
  CHECKOUT_DRAFT_KEY, saveCheckoutDraft, readCheckoutDraft, cvsFromSearchParams,
} from './checkoutDraft'

function fakeStorage() {
  const m = new Map()
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    _map: m,
  }
}

describe('checkout 草稿', () => {
  let s
  beforeEach(() => { s = fakeStorage() })

  it('存了之後讀得回來', () => {
    saveCheckoutDraft(s, { name: '王小明', phone: '0912' })
    expect(readCheckoutDraft(s)).toEqual({ name: '王小明', phone: '0912' })
  })

  it('讀完就清掉，避免下次結帳被舊資料汙染', () => {
    saveCheckoutDraft(s, { name: '王小明' })
    readCheckoutDraft(s)
    expect(readCheckoutDraft(s)).toBe(null)
    expect(s.getItem(CHECKOUT_DRAFT_KEY)).toBe(null)
  })

  it('沒有草稿時回 null', () => {
    expect(readCheckoutDraft(s)).toBe(null)
  })

  it('草稿壞掉時回 null 而不是丟例外', () => {
    s.setItem(CHECKOUT_DRAFT_KEY, '{壞掉的 JSON')
    expect(readCheckoutDraft(s)).toBe(null)
  })

  it('storage 不可用時不炸（SSR / 隱私模式）', () => {
    expect(() => saveCheckoutDraft(null, { a: 1 })).not.toThrow()
    expect(readCheckoutDraft(null)).toBe(null)
  })
})

describe('cvsFromSearchParams', () => {
  it('帶了門市代碼就解析出門市資訊', () => {
    const p = new URLSearchParams({
      cvs_store_id: '131386', cvs_store_name: '龍安門市',
      cvs_address: '台北市…', cvs_subtype: 'UNIMARTC2C',
    })
    expect(cvsFromSearchParams(p)).toEqual({
      cvs_store_id: '131386',
      cvs_store_name: '龍安門市',
      cvs_address: '台北市…',
      shipping_subtype: 'UNIMARTC2C',
    })
  })

  it('沒有門市代碼就回 null', () => {
    expect(cvsFromSearchParams(new URLSearchParams({ foo: 'bar' }))).toBe(null)
  })

  it('子類型不在白名單時不採信（避免被塞任意值）', () => {
    const p = new URLSearchParams({ cvs_store_id: '1', cvs_subtype: 'EVIL' })
    expect(cvsFromSearchParams(p).shipping_subtype).toBe(null)
  })
})
