import { describe, it, expect } from 'vitest'
import {
  IDLE_HANDBACK_MS,
  shouldRunAssistant,
  initialStatus,
  nextStatusOnConsumerMessage,
  nextStatusOnRequestHuman,
  nextStatusOnTakeover,
  nextStatusOnHandback,
  rateLimitDecision,
  memoryScope,
  memoryWindow,
  isValidVisitorToken,
  sortConversations,
} from './customerInbox'

describe('狀態機', () => {
  it('只有 bot 狀態的對話助理才自動回覆（接管期間靜音）', () => {
    expect(shouldRunAssistant('bot')).toBe(true)
    expect(shouldRunAssistant('waiting_human')).toBe(false)
    expect(shouldRunAssistant('human')).toBe(false)
    expect(shouldRunAssistant('closed')).toBe(false)
  })

  it('舉手：bot / waiting_human / closed 都進 waiting_human，已有真人則不動', () => {
    expect(nextStatusOnRequestHuman('bot')).toBe('waiting_human')
    expect(nextStatusOnRequestHuman('waiting_human')).toBe('waiting_human')
    expect(nextStatusOnRequestHuman('closed')).toBe('waiting_human')
    expect(nextStatusOnRequestHuman('human')).toBe('human')
  })

  it('接管 → human，交還 → bot', () => {
    expect(nextStatusOnTakeover()).toBe('human')
    expect(nextStatusOnHandback()).toBe('bot')
  })

  it('消費者發話：bot / waiting_human 維持原狀', () => {
    const now = Date.parse('2026-08-02T10:00:00Z')
    expect(nextStatusOnConsumerMessage({ status: 'bot', lastStaffAt: null, now })).toBe('bot')
    expect(nextStatusOnConsumerMessage({ status: 'waiting_human', lastStaffAt: null, now })).toBe('waiting_human')
  })

  it('消費者發話：已關閉的對話重新開啟成 bot', () => {
    expect(nextStatusOnConsumerMessage({ status: 'closed', lastStaffAt: null })).toBe('bot')
  })

  it('接管中：真人剛回過話 → 維持 human（助理不插嘴）', () => {
    const now = Date.parse('2026-08-02T10:00:00Z')
    const lastStaffAt = new Date(now - 5 * 60_000).toISOString()
    expect(nextStatusOnConsumerMessage({ status: 'human', lastStaffAt, now })).toBe('human')
  })

  it('接管中：真人閒置超過 30 分鐘 → 自動交還給助理', () => {
    const now = Date.parse('2026-08-02T10:00:00Z')
    const lastStaffAt = new Date(now - IDLE_HANDBACK_MS - 1000).toISOString()
    expect(nextStatusOnConsumerMessage({ status: 'human', lastStaffAt, now })).toBe('bot')
  })

  it('接管中但還沒有任何真人訊息 → 視為剛接管，不算閒置', () => {
    const now = Date.parse('2026-08-02T10:00:00Z')
    expect(nextStatusOnConsumerMessage({ status: 'human', lastStaffAt: null, now })).toBe('human')
  })

  it('閒置判斷剛好踩在 30 分鐘上不交還（要「超過」）', () => {
    const now = Date.parse('2026-08-02T10:00:00Z')
    const lastStaffAt = new Date(now - IDLE_HANDBACK_MS).toISOString()
    expect(nextStatusOnConsumerMessage({ status: 'human', lastStaffAt, now })).toBe('human')
  })
})

describe('AI 自動回覆關閉時', () => {
  it('助理一律不回，連 bot 狀態的對話也不回', () => {
    expect(shouldRunAssistant('bot', { aiEnabled: false })).toBe(false)
    expect(shouldRunAssistant('bot', { aiEnabled: true })).toBe(true)
    expect(shouldRunAssistant('bot')).toBe(true) // 沒帶 = 開，既有呼叫端不受影響
  })

  it('新對話直接排隊等真人，不會停在沒有助理的 bot', () => {
    expect(initialStatus({ aiEnabled: false })).toBe('waiting_human')
    expect(initialStatus({ aiEnabled: true })).toBe('bot')
    expect(initialStatus()).toBe('bot')
  })

  it('消費者發話：所有原本會落到 bot 的路徑改落 waiting_human', () => {
    const now = Date.parse('2026-08-02T10:00:00Z')
    const off = { aiEnabled: false, now }
    // 開關打開時建立、之後才關掉的舊對話
    expect(nextStatusOnConsumerMessage({ status: 'bot', lastStaffAt: null, ...off })).toBe('waiting_human')
    // 已關閉的對話被重新開啟
    expect(nextStatusOnConsumerMessage({ status: 'closed', lastStaffAt: null, ...off })).toBe('waiting_human')
    // 真人接管後閒置逾時，本來會自動交還給助理
    const stale = new Date(now - IDLE_HANDBACK_MS - 1000).toISOString()
    expect(nextStatusOnConsumerMessage({ status: 'human', lastStaffAt: stale, ...off })).toBe('waiting_human')
  })

  it('真人正在處理中的對話不受開關影響', () => {
    const now = Date.parse('2026-08-02T10:00:00Z')
    const fresh = new Date(now - 5 * 60_000).toISOString()
    expect(nextStatusOnConsumerMessage({ status: 'human', lastStaffAt: fresh, aiEnabled: false, now })).toBe('human')
    expect(nextStatusOnConsumerMessage({ status: 'waiting_human', lastStaffAt: null, aiEnabled: false, now }))
      .toBe('waiting_human')
  })

  it('交還也不會落回 bot（後台若漏擋按鈕，狀態仍然誠實）', () => {
    expect(nextStatusOnHandback({ aiEnabled: false })).toBe('waiting_human')
    expect(nextStatusOnHandback()).toBe('bot')
  })

  it('接管不受影響（真人隨時都能接手）', () => {
    expect(nextStatusOnTakeover()).toBe('human')
  })
})

describe('限流', () => {
  it('都沒滿就放行', () => {
    expect(rateLimitDecision({ perVisitorCount: 0, perStoreCount: 0 })).toEqual({ ok: true })
  })

  it('每訪客每分鐘滿了就擋，理由是 visitor', () => {
    const r = rateLimitDecision({ perVisitorCount: 6, perStoreCount: 0, perVisitorLimit: 6 })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('visitor')
    expect(r.message).toBeTruthy()
  })

  it('每店每日滿了就擋，理由是 store', () => {
    const r = rateLimitDecision({ perVisitorCount: 1, perStoreCount: 300, perStoreLimit: 300 })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('store')
  })

  it('訪客層先判定（兩層同時滿時回 visitor）', () => {
    const r = rateLimitDecision({
      perVisitorCount: 99, perStoreCount: 999, perVisitorLimit: 6, perStoreLimit: 300,
    })
    expect(r.reason).toBe('visitor')
  })

  it('剛好等於上限就算滿（第 N+1 則被擋）', () => {
    expect(rateLimitDecision({ perVisitorCount: 5, perStoreCount: 0, perVisitorLimit: 6 }).ok).toBe(true)
    expect(rateLimitDecision({ perVisitorCount: 6, perStoreCount: 0, perVisitorLimit: 6 }).ok).toBe(false)
  })
})

describe('記憶取用範圍', () => {
  it('有 consumer_id 就用它，否則退回訪客識別碼', () => {
    expect(memoryScope({ storeId: 1, consumerId: 'c1', visitorToken: 'v1' }))
      .toEqual({ storeId: 1, key: 'consumer_id', value: 'c1' })
    expect(memoryScope({ storeId: 1, consumerId: null, visitorToken: 'v1' }))
      .toEqual({ storeId: 1, key: 'visitor_token', value: 'v1' })
  })

  it('沒有 storeId 一律拋錯（跨店紅線）', () => {
    expect(() => memoryScope({ consumerId: 'c1' })).toThrow(/storeId/)
  })

  it('兩個身分都沒有就拋錯', () => {
    expect(() => memoryScope({ storeId: 1 })).toThrow()
  })

  it('只取最近 N 則', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      sender: i % 2 === 0 ? 'consumer' : 'assistant', content: `m${i}`,
    }))
    const win = memoryWindow(rows, 20)
    // 30 則取後 20 則（m10..m29），m10 是 consumer → 首則為 user
    expect(win[0]).toEqual({ role: 'user', content: 'm10' })
    expect(win).toHaveLength(20)
  })

  it('staff 訊息在助理眼中也是 assistant（真人講過的話助理讀得到）', () => {
    const win = memoryWindow([
      { sender: 'consumer', content: '在嗎' },
      { sender: 'staff', content: '我是小編' },
    ])
    expect(win).toEqual([
      { role: 'user', content: '在嗎' },
      { role: 'assistant', content: '我是小編' },
    ])
  })

  it('開頭若是 assistant 先剔除（Anthropic 要求首則為 user）', () => {
    const win = memoryWindow([
      { sender: 'assistant', content: '哈囉' },
      { sender: 'consumer', content: '有貨嗎' },
    ], 2)
    expect(win).toEqual([{ role: 'user', content: '有貨嗎' }])
  })

  it('合併連續同角色（訪客連發兩則）', () => {
    const win = memoryWindow([
      { sender: 'consumer', content: '你好' },
      { sender: 'consumer', content: '請問有貨嗎' },
      { sender: 'assistant', content: '有的' },
    ])
    expect(win).toEqual([
      { role: 'user', content: '你好\n請問有貨嗎' },
      { role: 'assistant', content: '有的' },
    ])
  })

  it('全部都是 assistant 時回空陣列，不會產生非法序列', () => {
    expect(memoryWindow([{ sender: 'assistant', content: 'a' }])).toEqual([])
  })
})

describe('訪客識別碼', () => {
  it('接受 UUID', () => {
    expect(isValidVisitorToken('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true)
  })
  it('擋掉非 UUID 與非字串（防止被拿來當任意鍵灌爆）', () => {
    expect(isValidVisitorToken('abc')).toBe(false)
    expect(isValidVisitorToken('')).toBe(false)
    expect(isValidVisitorToken(null)).toBe(false)
    expect(isValidVisitorToken(123)).toBe(false)
    expect(isValidVisitorToken('3f2504e0-4f89-41d3-9a0c-0305e82c3301 ')).toBe(false)
  })
})

describe('工作台排序', () => {
  it('waiting_human 置頂，其次未讀，再來照時間', () => {
    const list = [
      { id: 1, status: 'bot', unread_for_store: 0, last_message_at: '2026-08-02T10:00:00Z' },
      { id: 2, status: 'waiting_human', unread_for_store: 1, last_message_at: '2026-08-01T10:00:00Z' },
      { id: 3, status: 'bot', unread_for_store: 2, last_message_at: '2026-08-02T09:00:00Z' },
      { id: 4, status: 'closed', unread_for_store: 0, last_message_at: '2026-08-02T23:00:00Z' },
      { id: 5, status: 'human', unread_for_store: 0, last_message_at: '2026-07-01T10:00:00Z' },
    ]
    expect(sortConversations(list).map(c => c.id)).toEqual([2, 5, 3, 1, 4])
  })

  it('不改動原陣列', () => {
    const list = [
      { id: 1, status: 'bot', unread_for_store: 0, last_message_at: '2026-08-02T10:00:00Z' },
      { id: 2, status: 'waiting_human', unread_for_store: 0, last_message_at: '2026-08-01T10:00:00Z' },
    ]
    sortConversations(list)
    expect(list.map(c => c.id)).toEqual([1, 2])
  })
})
