import { describe, it, expect } from 'vitest'
import {
  normalizeEmail, parseAmount, parseCount, parseYN, parseDate,
  parseCSV, mapShoplineRows,
} from './memberImport'

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Foo@Bar.COM ')).toBe('foo@bar.com')
  })
  it('handles null/empty', () => {
    expect(normalizeEmail(null)).toBe('')
    expect(normalizeEmail(undefined)).toBe('')
  })
})

describe('parseAmount', () => {
  it('strips NT$ and thousands comma', () => {
    expect(parseAmount('NT$1,455')).toBe(1455)
    expect(parseAmount('NT$1,234,567')).toBe(1234567)
  })
  it('keeps decimals', () => {
    expect(parseAmount('NT$1,455.50')).toBe(1455.5)
  })
  it('empty / junk → 0', () => {
    expect(parseAmount('')).toBe(0)
    expect(parseAmount(null)).toBe(0)
    expect(parseAmount('NT$')).toBe(0)
    expect(parseAmount('NT$0')).toBe(0)
  })
})

describe('parseCount', () => {
  it('parses ints, blanks → 0', () => {
    expect(parseCount('3')).toBe(3)
    expect(parseCount('')).toBe(0)
    expect(parseCount(null)).toBe(0)
  })
})

describe('parseYN', () => {
  it('Y/N → bool, else null', () => {
    expect(parseYN('Y')).toBe(true)
    expect(parseYN('n')).toBe(false)
    expect(parseYN('')).toBe(null)
    expect(parseYN('x')).toBe(null)
  })
})

describe('parseDate', () => {
  it('space → T, empty → null', () => {
    expect(parseDate('2026-06-05 11:37:39')).toBe('2026-06-05T11:37:39')
    expect(parseDate('')).toBe(null)
    expect(parseDate(null)).toBe(null)
  })
})

describe('parseCSV', () => {
  it('handles quoted fields with internal commas', () => {
    const out = parseCSV('a,b,c\n1,"NT$1,455",y')
    expect(out).toEqual([['a', 'b', 'c'], ['1', 'NT$1,455', 'y']])
  })
  it('handles escaped double quotes', () => {
    const out = parseCSV('x\n"he said ""hi"""')
    expect(out).toEqual([['x'], ['he said "hi"']])
  })
  it('strips \\r and drops blank lines', () => {
    const out = parseCSV('a,b\r\n1,2\r\n\r\n')
    expect(out).toEqual([['a', 'b'], ['1', '2']])
  })
})

describe('mapShoplineRows', () => {
  // 真實 Shopline 表頭
  const HEADER = '顧客 ID,全名,電郵,加入日期,語言,訂單數,累積金額,會員,已設置密碼,接受電郵優惠宣傳,會員綁定手機號碼,地址 1,會員級別,會員有效期,地址 2,城市,地區/州/省份,郵政編號（如適用）,國家／地區'

  it('maps a member row and excludes shipping-free fields', () => {
    const csv = HEADER + '\n' +
      '6a204a668567e789b68da51d,阮佳慧,Abby@Example.com,2026-06-03 23:38:14,zh-hant,1,"NT$1,455",Y,Y,Y,0912345678,,一般會員,,,,,,'
    const { rows, total, imported, skipped } = mapShoplineRows(csv)
    expect(total).toBe(1)
    expect(imported).toBe(1)
    expect(skipped).toBe(0)
    expect(rows[0]).toEqual({
      source: 'shopline',
      external_id: '6a204a668567e789b68da51d',
      email: 'abby@example.com',
      name: '阮佳慧',
      phone: '0912345678',
      registered_at: '2026-06-03T23:38:14',
      imported_amount: 1455,
      imported_orders: 1,
      accepts_marketing: true,
    })
  })

  it('skips 會員=N (guest) rows', () => {
    const csv = HEADER + '\n' +
      'id1,訪客,guest@x.com,2026-01-01 00:00:00,en,0,,N,N,N,,,,,,,,,'
    const { imported, skipped } = mapShoplineRows(csv)
    expect(imported).toBe(0)
    expect(skipped).toBe(1)
  })

  it('skips rows with no email even if 會員=Y', () => {
    const csv = HEADER + '\n' +
      'id2,沒信箱,,2026-01-01 00:00:00,en,0,,Y,Y,N,,,,,,,,,'
    const { imported, skipped } = mapShoplineRows(csv)
    expect(imported).toBe(0)
    expect(skipped).toBe(1)
  })

  it('empty CSV → zeros', () => {
    expect(mapShoplineRows('')).toEqual({ rows: [], total: 0, imported: 0, skipped: 0 })
  })
})
