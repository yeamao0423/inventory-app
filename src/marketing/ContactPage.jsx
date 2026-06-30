import { useState, useEffect, useRef } from 'react'
import { PLATFORM_NAME } from './MarketingLayout'
import { supabase } from '../lib/supabase'

// 聯絡資訊（要改改這裡）
const CONTACT_EMAIL = 'henry3556108@gmail.com'
const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY

export default function ContactPage() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')
  const [hp, setHp] = useState('')                 // honeypot：真人不會填，被填即視為 bot
  const [status, setStatus] = useState('idle')     // idle | sending | done
  const [errMsg, setErrMsg] = useState('')

  const tsRef = useRef(null)        // Turnstile 元件掛載點
  const tokenRef = useRef('')       // 最新的 Turnstile token
  const widgetIdRef = useRef(null)  // render 後的 widget id（供 reset 用）

  // 載入並渲染 Cloudflare Turnstile（不引入 npm 套件，直接掛官方 script）
  useEffect(() => {
    function render() {
      if (!window.turnstile || !tsRef.current || widgetIdRef.current !== null) return
      widgetIdRef.current = window.turnstile.render(tsRef.current, {
        sitekey: SITE_KEY,
        callback: (t) => { tokenRef.current = t },
        'expired-callback': () => { tokenRef.current = '' },
        'error-callback': () => { tokenRef.current = '' },
      })
    }
    if (window.turnstile) { render(); return }
    const scriptId = 'cf-turnstile-script'
    if (!document.getElementById(scriptId)) {
      const s = document.createElement('script')
      s.id = scriptId
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js'
      s.async = true
      s.defer = true
      document.head.appendChild(s)
    }
    const timer = setInterval(() => {
      if (window.turnstile) { clearInterval(timer); render() }
    }, 200)
    return () => clearInterval(timer)
  }, [])

  async function handleSubmit(e) {
    e.preventDefault()
    setErrMsg('')
    if (!tokenRef.current) { setErrMsg('請先完成下方的人機驗證。'); return }
    setStatus('sending')

    const { data, error } = await supabase.functions.invoke('contact-submit', {
      body: { name, email, message, hp, token: tokenRef.current },
    })

    // 非 2xx 時 supabase-js 把回應放在 error.context，撈出後端的錯誤訊息
    let payload = data
    if (error) {
      try { payload = await error.context.json() } catch { payload = null }
    }

    if (!payload?.ok) {
      setStatus('idle')
      setErrMsg(payload?.error || '送出失敗，請稍後再試。')
      tokenRef.current = ''
      if (window.turnstile && widgetIdRef.current !== null) {
        window.turnstile.reset(widgetIdRef.current)
      }
      return
    }
    setStatus('done')
  }

  // 送出成功畫面
  if (status === 'done') {
    return (
      <section className="mkt-section">
        <div className="mkt-container mkt-center-wrap">
          <div style={{ fontSize: 44, marginBottom: 12 }}>✅</div>
          <h1 className="mkt-section-title">已收到你的訊息</h1>
          <p className="mkt-section-sub">
            感謝你聯絡 {PLATFORM_NAME}，我們會在一個工作天內回覆到你填寫的信箱。
          </p>
        </div>
      </section>
    )
  }

  const sending = status === 'sending'

  return (
    <section className="mkt-section">
      <div className="mkt-container">
        <div className="mkt-section-head">
          <h1 className="mkt-section-title">聯絡我們</h1>
          <p className="mkt-section-sub">
            對 {PLATFORM_NAME} 有興趣，或想了解方案與導入流程？填表或直接來信，我們會盡快回覆。
          </p>
        </div>

        <div className="mkt-contact-grid">
          {/* 表單 */}
          <form className="mkt-contact-card" onSubmit={handleSubmit}>
            <div className="mkt-field">
              <label>姓名</label>
              <input className="mkt-input" value={name} onChange={e => setName(e.target.value)}
                placeholder="您的稱呼" maxLength={100} required />
            </div>
            <div className="mkt-field">
              <label>電子郵件</label>
              <input className="mkt-input" type="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="your@email.com" autoCapitalize="none" maxLength={200} required />
            </div>
            <div className="mkt-field">
              <label>想跟我們說的話</label>
              <textarea className="mkt-textarea" value={message} onChange={e => setMessage(e.target.value)}
                placeholder="例如：我想了解收費方案、想把現有商店搬過來…" maxLength={2000} required />
            </div>

            {/* honeypot：以 CSS 藏起來，正常使用者看不到也不會填到 */}
            <input
              type="text" value={hp} onChange={e => setHp(e.target.value)}
              name="company" tabIndex={-1} autoComplete="off" aria-hidden="true"
              style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }}
            />

            {/* Cloudflare Turnstile 人機驗證 */}
            <div ref={tsRef} style={{ marginBottom: 12 }} />

            {errMsg && (
              <div style={{ color: 'var(--red, #d33)', fontSize: 13, marginBottom: 12 }}>{errMsg}</div>
            )}

            <button type="submit" disabled={sending}
              className="mkt-btn-primary"
              style={{ width: '100%', border: 'none', cursor: sending ? 'default' : 'pointer', opacity: sending ? 0.6 : 1 }}>
              {sending ? '送出中…' : '送出'}
            </button>
          </form>

          {/* 聯絡資訊 */}
          <div className="mkt-contact-card">
            <div className="mkt-contact-item">
              <div className="lbl">Email</div>
              <div className="val"><a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></div>
            </div>
            <div className="mkt-contact-item">
              <div className="lbl">服務時間</div>
              <div className="val" style={{ fontWeight: 500, fontSize: 14, color: 'var(--text-2)', lineHeight: 1.6 }}>
                週一至週五 10:00–18:00<br />我們會在一個工作天內回覆。
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
