'use client'
// 商城站內聊天視窗。
//
// 這支「一定」要 client-side 延遲載入（見 ChatLauncher）：shop/ 是 SSR + ISR 且做過 SEO 改造，
// 聊天視窗不可拖累首屏、也不可影響靜態化。
//
// 即時更新：訂閱 Realtime Broadcast（頻道名＝訪客識別碼），另有輪詢兜底 ——
// Broadcast 掉包不該讓顧客漏接店主的回覆。
import { useCallback, useEffect, useRef, useState } from 'react'
import { isComposing } from '../lib/imeSafeEnter'
import { supabase } from '../lib/supabase'
import { getStore } from '../lib/store'
import { useI18n } from './layout'
import {
  claimConversations, getVisitorToken, loadHistory,
  requestHuman, sendMessage, visitorTopic,
} from '../lib/chat'

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || ''
const POLL_MS = 6000

export default function ChatWidget() {
  const { lang } = useI18n()
  const zh = lang !== 'en'

  const [open, setOpen] = useState(false)
  const [store, setStore] = useState(null)
  const [visitorToken, setVisitorToken] = useState(null)
  const [conversationId, setConversationId] = useState(null)
  const [status, setStatus] = useState('bot')
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [needsVerify, setNeedsVerify] = useState(false)

  const bodyRef = useRef(null)
  const tsMountRef = useRef(null)
  const tsTokenRef = useRef('')
  const tsWidgetRef = useRef(null)
  const claimedRef = useRef(false)
  // 給輪詢／Broadcast 用的最新值（避免 effect 反覆重掛）
  const lastIdRef = useRef(0)
  const convIdRef = useRef(null)

  useEffect(() => { convIdRef.current = conversationId }, [conversationId])

  useEffect(() => {
    setVisitorToken(getVisitorToken())
    getStore().then(setStore).catch(() => {})
  }, [])

  function mergeMessages(incoming) {
    if (!incoming?.length) return
    setMessages(prev => {
      const seen = new Set(prev.map(m => m.id))
      const merged = [...prev, ...incoming.filter(m => !seen.has(m.id))]
      merged.sort((a, b) => a.id - b.id)
      lastIdRef.current = merged.length ? merged[merged.length - 1].id : 0
      return merged
    })
  }

  // ── 開啟時載入歷史（重新整理後歷史還在）──
  useEffect(() => {
    if (!open || !store || !visitorToken) return
    let cancelled = false
    loadHistory({ storeId: store.id, visitorToken, conversationId: convIdRef.current })
      .then(res => {
        if (cancelled || !res) return
        if (res.conversationId) {
          setConversationId(res.conversationId)
          setStatus(res.status || 'bot')
        }
        mergeMessages(res.messages)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [open, store, visitorToken])

  // ── 認領：已登入就把這個訪客識別碼底下的對話掛到本人名下 ──
  const claim = useCallback(async () => {
    if (!store || !visitorToken || !supabase) return
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) return
    try {
      await claimConversations({ storeId: store.id, visitorToken, accessToken: session.access_token })
      claimedRef.current = true
    } catch { /* 認領失敗不影響聊天 */ }
  }, [store, visitorToken])

  useEffect(() => {
    if (!store || !visitorToken || !supabase) return
    claim()
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') claim()
      if (event === 'SIGNED_OUT') claimedRef.current = false
    })
    return () => subscription.unsubscribe()
  }, [store, visitorToken, claim])

  // ── 即時：Realtime Broadcast（頻道名＝訪客識別碼）──
  useEffect(() => {
    if (!visitorToken || !supabase) return
    const ch = supabase.channel(visitorTopic(visitorToken))
    ch.on('broadcast', { event: 'message' }, ({ payload }) => {
      if (convIdRef.current && payload?.conversationId !== convIdRef.current) return
      if (payload?.status) setStatus(payload.status)
      if (payload?.message) mergeMessages([payload.message])
    })
    ch.on('broadcast', { event: 'status' }, ({ payload }) => {
      if (payload?.status) setStatus(payload.status)
    })
    ch.subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [visitorToken])

  // ── 輪詢兜底：視窗開著時每 6 秒補撈一次 ──
  useEffect(() => {
    if (!open || !store || !visitorToken) return
    const timer = setInterval(async () => {
      if (document.hidden || !convIdRef.current) return
      try {
        const res = await loadHistory({
          storeId: store.id, visitorToken,
          conversationId: convIdRef.current, sinceId: lastIdRef.current,
        })
        if (res?.status) setStatus(res.status)
        mergeMessages(res?.messages)
      } catch { /* 網路瞬斷就等下一輪 */ }
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [open, store, visitorToken])

  // 有新訊息就捲到底
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, open, sending])

  // ── Turnstile：只有「開新對話」那一刻需要 ──
  const needTurnstile = open && !conversationId && !!TURNSTILE_SITE_KEY
  useEffect(() => {
    if (!needTurnstile) return
    let timer = null
    function render() {
      if (!window.turnstile || !tsMountRef.current || tsWidgetRef.current !== null) return
      tsWidgetRef.current = window.turnstile.render(tsMountRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        size: 'flexible',
        callback: t => { tsTokenRef.current = t; setNeedsVerify(false) },
        'expired-callback': () => { tsTokenRef.current = '' },
        'error-callback': () => { tsTokenRef.current = '' },
      })
    }
    if (window.turnstile) { render() } else {
      const id = 'cf-turnstile-script'
      if (!document.getElementById(id)) {
        const s = document.createElement('script')
        s.id = id
        s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js'
        s.async = true
        s.defer = true
        document.head.appendChild(s)
      }
      timer = setInterval(() => { if (window.turnstile) { clearInterval(timer); render() } }, 200)
    }
    return () => { if (timer) clearInterval(timer) }
  }, [needTurnstile])

  function resetTurnstile() {
    tsTokenRef.current = ''
    if (window.turnstile && tsWidgetRef.current !== null) window.turnstile.reset(tsWidgetRef.current)
  }

  async function handleSend() {
    const text = draft.trim()
    if (!text || sending || !store || !visitorToken) return
    if (!conversationId && TURNSTILE_SITE_KEY && !tsTokenRef.current) {
      setNeedsVerify(true)
      setError(zh ? '請先完成人機驗證' : 'Please complete the verification first')
      return
    }
    setSending(true)
    setError('')
    // 樂觀顯示：先把自己的話貼上去（負數 id 不會和伺服器的撞號）
    const optimisticId = -Date.now()
    setMessages(prev => [...prev, { id: optimisticId, sender: 'consumer', content: text, created_at: new Date().toISOString() }])
    setDraft('')
    try {
      const res = await sendMessage({
        storeId: store.id, visitorToken, conversationId, text,
        turnstileToken: tsTokenRef.current || undefined,
      })
      setMessages(prev => prev.filter(m => m.id !== optimisticId))
      if (res.conversationId) setConversationId(res.conversationId)
      if (res.status) setStatus(res.status)
      mergeMessages(res.messages)
      if (!claimedRef.current) claim()
    } catch (e) {
      setMessages(prev => prev.filter(m => m.id !== optimisticId))
      setDraft(text)
      setError(e.message)
      if (!conversationId) resetTurnstile()
    }
    setSending(false)
  }

  async function handleRequestHuman() {
    if (!conversationId || !store || !visitorToken) return
    try {
      const res = await requestHuman({ storeId: store.id, visitorToken, conversationId })
      setStatus(res.status)
    } catch (e) {
      setError(e.message)
    }
  }

  const statusLabel = {
    bot: zh ? '客服助理' : 'Assistant',
    waiting_human: zh ? '已通知真人客服，請稍候' : 'Waiting for a human',
    human: zh ? '真人客服對話中' : 'Talking to a human',
    closed: zh ? '對話已結束' : 'Closed',
  }[status] || ''

  return (
    <>
      {!open && (
        <button className="chat-fab" onClick={() => setOpen(true)}
          aria-label={zh ? '開啟客服聊天' : 'Open chat'}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" />
          </svg>
        </button>
      )}

      {open && (
        <div className="chat-panel" role="dialog" aria-label={zh ? '客服聊天' : 'Customer support chat'}>
          <div className="chat-head">
            <div>
              <div className="chat-title">{store?.name || (zh ? '客服' : 'Support')}</div>
              <div className="chat-sub">{statusLabel}</div>
            </div>
            <button className="chat-x" onClick={() => setOpen(false)} aria-label={zh ? '關閉' : 'Close'}>×</button>
          </div>

          <div className="chat-body" ref={bodyRef}>
            {messages.length === 0 && (
              <div className="chat-hint">
                {zh
                  ? '嗨！有什麼想問的嗎？商品庫存、售價都可以直接問我。'
                  : 'Hi! Ask me anything about products, stock or prices.'}
              </div>
            )}
            {messages.map(m => (
              <div key={m.id} className={`chat-msg ${m.sender === 'consumer' ? 'me' : 'them'}`}>
                {m.sender === 'staff' && (
                  <div className="chat-who">{zh ? '真人客服' : 'Staff'}</div>
                )}
                <div className="chat-bubble">{m.content}</div>
              </div>
            ))}
            {sending && <div className="chat-msg them"><div className="chat-bubble chat-typing">…</div></div>}
          </div>

          {needTurnstile && (
            <div className={`chat-verify ${needsVerify ? 'warn' : ''}`}>
              <div ref={tsMountRef} />
            </div>
          )}

          {error && <div className="chat-error">{error}</div>}

          <div className="chat-foot">
            <textarea
              className="chat-input"
              rows={1}
              value={draft}
              placeholder={zh ? '輸入訊息…' : 'Type a message…'}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (!isComposing(e) && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
              }}
            />
            <button className="chat-send" onClick={handleSend} disabled={sending || !draft.trim()}>
              {zh ? '送出' : 'Send'}
            </button>
          </div>

          {conversationId && status === 'bot' && (
            <button className="chat-human" onClick={handleRequestHuman}>
              {zh ? '我想找真人客服' : 'Talk to a human'}
            </button>
          )}
        </div>
      )}

      <style jsx>{`
        .chat-fab {
          position: fixed; right: 18px; bottom: 18px; z-index: 300;
          width: 48px; height: 48px; border-radius: 24px; border: none;
          background: var(--text); color: #fff;
          display: flex; align-items: center; justify-content: center;
          box-shadow: 0 4px 16px rgba(0,0,0,.18);
        }
        .chat-panel {
          position: fixed; right: 18px; bottom: 18px; z-index: 300;
          width: min(360px, calc(100vw - 24px));
          height: min(520px, calc(100vh - 90px));
          background: var(--surface); border: 0.5px solid var(--border);
          border-radius: 14px; box-shadow: 0 8px 32px rgba(0,0,0,.16);
          display: flex; flex-direction: column; overflow: hidden;
        }
        @media (max-width: 600px) {
          .chat-panel { right: 8px; left: 8px; bottom: 8px; width: auto; height: min(78vh, calc(100vh - 70px)); }
        }
        .chat-head {
          display: flex; align-items: center; justify-content: space-between;
          padding: 12px 14px; border-bottom: 0.5px solid var(--border);
        }
        .chat-title { font-size: 14px; font-weight: 700; }
        .chat-sub { font-size: 11.5px; color: var(--text-3); }
        .chat-x { background: none; border: none; font-size: 22px; line-height: 1; color: var(--text-3); }
        .chat-body { flex: 1; overflow-y: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
        .chat-hint { font-size: 12.5px; color: var(--text-3); line-height: 1.6; }
        .chat-msg { display: flex; flex-direction: column; max-width: 82%; }
        .chat-msg.me { align-self: flex-end; align-items: flex-end; }
        .chat-msg.them { align-self: flex-start; align-items: flex-start; }
        .chat-who { font-size: 11px; color: var(--text-3); margin-bottom: 2px; }
        .chat-bubble {
          font-size: 13.5px; line-height: 1.6; padding: 8px 11px; border-radius: 12px;
          white-space: pre-wrap; word-break: break-word;
        }
        .chat-msg.me .chat-bubble { background: var(--text); color: #fff; border-bottom-right-radius: 4px; }
        .chat-msg.them .chat-bubble { background: var(--bg); border: 0.5px solid var(--border); border-bottom-left-radius: 4px; }
        .chat-typing { color: var(--text-3); letter-spacing: 2px; }
        .chat-verify { padding: 8px 14px 0; }
        .chat-verify.warn { background: var(--amber-bg); }
        .chat-error { font-size: 12px; color: var(--red); padding: 6px 14px 0; }
        .chat-foot { display: flex; gap: 8px; padding: 10px 12px; border-top: 0.5px solid var(--border); align-items: flex-end; }
        .chat-input {
          flex: 1; resize: none; font-size: 13.5px; line-height: 1.5; padding: 8px 10px;
          border: 0.5px solid var(--border); border-radius: 9px; background: var(--surface);
          color: var(--text); max-height: 96px;
        }
        .chat-input:focus { outline: none; border-color: var(--text-3); }
        .chat-send {
          border: none; border-radius: 9px; background: var(--text); color: #fff;
          font-size: 13px; padding: 9px 14px; flex-shrink: 0;
        }
        .chat-send:disabled { opacity: .4; }
        .chat-human {
          border: none; background: none; color: var(--text-3);
          font-size: 12px; padding: 0 12px 10px; text-align: left; text-decoration: underline;
        }
      `}</style>
    </>
  )
}
