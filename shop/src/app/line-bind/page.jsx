'use client'
// LINE 會員綁定頁（從 LINE 圖文選單/bot 連結開啟 → 登入商城一次 → LINE 認證 → 綁定）
// LIFF SDK 以 CDN 載入，不新增 npm 依賴。
import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../lib/supabase'

const LIFF_ID = process.env.NEXT_PUBLIC_LIFF_ID || '2010616155-bJSaanw4'
const BIND_ENDPOINT = `${process.env.NEXT_PUBLIC_SUPABASE_URL || ''}/functions/v1/line-bind`

function loadLiff() {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') return reject(new Error('no window'))
    if (window.liff) return resolve(window.liff)
    const s = document.createElement('script')
    s.src = 'https://static.line-scdn.net/liff/edge/2/sdk.js'
    s.onload = () => resolve(window.liff)
    s.onerror = () => reject(new Error('LIFF SDK 載入失敗'))
    document.head.appendChild(s)
  })
}

export default function LineBindPage() {
  const [phase, setPhase] = useState('loading') // loading | need-login | ready | binding | done | error
  const [msg, setMsg] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  // 綁定核心：確保 LINE 已認證 → 取 id_token ＋ 商城 session → 呼叫 line-bind
  const doBind = useCallback(async () => {
    try {
      const liff = window.liff
      if (!liff.isLoggedIn()) { liff.login(); return } // 跳 LINE 認證，回來後 useEffect 會自動續綁
      const idToken = liff.getIDToken()
      if (!idToken) { setPhase('error'); setMsg('取不到 LINE 驗證資訊（請確認 LIFF 已開啟 openid 權限）'); return }
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { setPhase('need-login'); return }
      setPhase('binding')
      const res = await fetch(BIND_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ id_token: idToken }),
      })
      const out = await res.json().catch(() => ({}))
      if (res.ok && out.ok) {
        setPhase('done')
        setMsg(out.line_name ? `已綁定 LINE（${out.line_name}）✅` : '綁定成功 ✅')
      } else {
        setPhase('error'); setMsg(out.error || '綁定失敗，請稍後再試')
      }
    } catch (e) {
      setPhase('error'); setMsg(e?.message || '發生錯誤')
    }
  }, [])

  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const liff = await loadLiff()
        await liff.init({ liffId: LIFF_ID })
        if (!mounted) return
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) { setPhase('need-login'); return }
        // 已登入商城；若也已從 LINE 認證回來就直接續綁，否則顯示綁定按鈕
        if (liff.isLoggedIn()) doBind()
        else setPhase('ready')
      } catch (e) {
        if (mounted) { setPhase('error'); setMsg(e?.message || 'LIFF 初始化失敗') }
      }
    })()
    return () => { mounted = false }
  }, [doBind])

  async function handleLogin() {
    if (!email || !password) { setMsg('請填寫 Email 和密碼'); return }
    setMsg('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) { setMsg('帳號或密碼錯誤'); return }
    // 登入成功 → 直接進綁定流程
    if (window.liff?.isLoggedIn()) doBind()
    else setPhase('ready')
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h2 className="auth-title">綁定 LINE 會員</h2>
        {msg && (phase === 'error'
          ? <div className="auth-error">{msg}</div>
          : <div className="auth-success">{msg}</div>)}

        {phase === 'loading' && <p style={{ fontSize: 14, color: 'var(--text-3)' }}>載入中…</p>}

        {phase === 'need-login' && (
          <>
            <p style={{ fontSize: 14, color: 'var(--text-3)', marginBottom: 12 }}>
              請先登入你的商城會員，登入後即可綁定 LINE，之後在 LINE 就能查自己的訂單。
            </p>
            <div className="form-group">
              <label className="form-label">Email</label>
              <input className="form-input" type="email" value={email}
                onChange={e => setEmail(e.target.value)} placeholder="example@email.com" />
            </div>
            <div className="form-group">
              <label className="form-label">密碼</label>
              <input className="form-input" type="password" value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLogin()} />
            </div>
            <button className="btn-primary" style={{ marginTop: 8 }} onClick={handleLogin}>登入並綁定</button>
          </>
        )}

        {phase === 'ready' && (
          <>
            <p style={{ fontSize: 14, color: 'var(--text-3)', marginBottom: 12 }}>
              點下方按鈕完成 LINE 認證即可綁定。
            </p>
            <button className="btn-primary" onClick={doBind}>綁定 LINE 帳號</button>
          </>
        )}

        {phase === 'binding' && <p style={{ fontSize: 14, color: 'var(--text-3)' }}>綁定中…</p>}

        {phase === 'done' && (
          <p style={{ fontSize: 14, color: 'var(--text-3)' }}>你現在可以回到 LINE 直接查詢自己的訂單囉～</p>
        )}
      </div>
    </div>
  )
}
