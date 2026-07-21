'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../lib/supabase'
import { getStore } from '../../lib/store'
import { useI18n } from '../layout'
import { STATE_KEY } from '../line-login/useLineLogin'

export default function AuthPage() {
  const { lang } = useI18n()
  const router = useRouter()
  const [mode, setMode] = useState('login') // 'login' | 'register' | 'forgot'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  // LINE 登入需平台開通＋店家啟用，兩者皆真才顯示按鈕（後端 line-login 也會擋）
  const [lineEnabled, setLineEnabled] = useState(false)
  const zh = lang === 'zh'

  useEffect(() => {
    getStore()
      .then(s => setLineEnabled(!!(s?.settings?.line_login_provisioned && s?.settings?.line_login_enabled)))
      .catch(() => {})
  }, [])

  function switchMode(m) { setMode(m); setError(''); setMessage('') }

  async function handleLogin() {
    if (!email || !password) { setError(zh ? '請填寫所有欄位' : 'Please fill all fields'); return }
    setLoading(true); setError('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setError(zh ? '帳號或密碼錯誤' : 'Invalid email or password')
    else router.push('/account')
    setLoading(false)
  }

  async function handleRegister() {
    if (!email || !password || !name) { setError(zh ? '請填寫所有欄位' : 'Please fill all fields'); return }
    if (password !== confirmPassword) { setError(zh ? '兩次密碼不一致' : 'Passwords do not match'); return }
    if (password.length < 6) { setError(zh ? '密碼至少 6 個字元' : 'Password must be at least 6 characters'); return }
    setLoading(true); setError('')
    // 帶入註冊當下店家的品牌資訊，供驗證/重設密碼信 template 動態顯示店名與 Logo。
    let store = null
    try { store = await getStore() } catch { /* 取不到店家就退回平台預設 */ }
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          name,
          store_name: store?.name || 'Daigogo',
          store_slug: store?.slug || 'daigogo',
          logo_url: store?.settings?.logo_url || '',
        },
        emailRedirectTo: `${window.location.origin}/`,
      },
    })
    if (error) {
      setError(error.message)
    } else if (data.user && !data.session) {
      setMessage(zh
        ? '驗證信已寄出！請至信箱點擊確認連結後再登入'
        : 'Confirmation email sent! Please check your inbox and click the link to continue.')
    } else {
      router.push('/account')
    }
    setLoading(false)
  }

  // LINE 登入分流：LINE App 內建瀏覽器走 LIFF（無感）；一般瀏覽器走 LINE Web OAuth
  async function handleLineLogin() {
    if (typeof navigator !== 'undefined' && / Line\//i.test(navigator.userAgent)) {
      router.push('/line-login')
      return
    }
    let store = null
    try { store = await getStore() } catch { /* 取不到就用 fallback */ }
    const channelId = store?.settings?.line_channel_id || process.env.NEXT_PUBLIC_LINE_CHANNEL_ID || '2010616155'
    const redirectUri = store?.settings?.line_callback_url || `${window.location.origin}/line-login/callback`
    const state = crypto.randomUUID()
    sessionStorage.setItem(STATE_KEY, state)
    const url = new URL('https://access.line.me/oauth2/v2.1/authorize')
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: channelId,
      redirect_uri: redirectUri,
      state,
      scope: 'openid profile email',
    }).toString()
    window.location.href = url.toString()
  }

  async function handleForgot() {
    if (!email) { setError(zh ? '請輸入 Email' : 'Please enter your email'); return }
    setLoading(true); setError('')
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/reset-password`,
    })
    if (error) setError(error.message)
    else setMessage(zh
      ? '重設連結已寄出！請至信箱點擊連結'
      : 'Reset link sent! Please check your inbox.')
    setLoading(false)
  }

  const submitFn = mode === 'login' ? handleLogin : mode === 'register' ? handleRegister : handleForgot
  const submitLabel = loading
    ? (zh ? '處理中…' : 'Processing…')
    : mode === 'login' ? (zh ? '登入' : 'Sign In')
    : mode === 'register' ? (zh ? '建立帳號' : 'Create Account')
    : (zh ? '寄送重設連結' : 'Send Reset Link')

  return (
    <div className="auth-wrap">
      {mode !== 'forgot' && (
        <div className="auth-tabs">
          <button className={`auth-tab ${mode === 'login' ? 'active' : ''}`} onClick={() => switchMode('login')}>
            {zh ? '登入' : 'Login'}
          </button>
          <button className={`auth-tab ${mode === 'register' ? 'active' : ''}`} onClick={() => switchMode('register')}>
            {zh ? '註冊' : 'Register'}
          </button>
        </div>
      )}

      <div className="auth-card">
        {mode === 'forgot' && (
          <button onClick={() => switchMode('login')} className="auth-back">
            ← {zh ? '返回登入' : 'Back to Login'}
          </button>
        )}

        <h2 className="auth-title">
          {mode === 'login' ? (zh ? '登入帳號' : 'Sign In')
           : mode === 'register' ? (zh ? '建立帳號' : 'Create Account')
           : (zh ? '重設密碼' : 'Reset Password')}
        </h2>

        {error && <div className="auth-error">{error}</div>}
        {message && <div className="auth-success">{message}</div>}

        {!message && (
          <>
            {mode === 'register' && (
              <div className="form-group">
                <label className="form-label">{zh ? '姓名' : 'Name'} *</label>
                <input
                  className="form-input"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder={zh ? '請輸入姓名' : 'Your name'}
                />
              </div>
            )}

            <div className="form-group">
              <label className="form-label">Email *</label>
              <input
                className="form-input"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="example@email.com"
                onKeyDown={e => e.key === 'Enter' && submitFn()}
              />
            </div>

            {mode !== 'forgot' && (
              <div className="form-group">
                <label className="form-label">{zh ? '密碼' : 'Password'} *</label>
                <input
                  className="form-input"
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder={zh ? '至少 6 個字元' : 'At least 6 characters'}
                  onKeyDown={e => e.key === 'Enter' && submitFn()}
                />
              </div>
            )}

            {mode === 'register' && (
              <div className="form-group">
                <label className="form-label">{zh ? '確認密碼' : 'Confirm Password'} *</label>
                <input
                  className="form-input"
                  type="password"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  placeholder={zh ? '再次輸入密碼' : 'Re-enter password'}
                  onKeyDown={e => e.key === 'Enter' && submitFn()}
                />
              </div>
            )}

            <button className="btn-primary" style={{ marginTop: 8 }} onClick={submitFn} disabled={loading}>
              {submitLabel}
            </button>

            {mode !== 'forgot' && lineEnabled && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '16px 0 0' }}>
                  <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                  <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{zh ? '或' : 'or'}</span>
                  <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                </div>
                <button
                  type="button"
                  onClick={handleLineLogin}
                  style={{ width: '100%', marginTop: 12, padding: '12px 16px', borderRadius: 8, border: 'none', background: '#06C755', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}
                >
                  {zh ? '用 LINE 繼續' : 'Continue with LINE'}
                </button>
              </>
            )}

            {mode === 'login' && (
              <button
                onClick={() => switchMode('forgot')}
                style={{ display: 'block', margin: '16px auto 0', fontSize: 13, color: 'var(--text-3)', background: 'none', border: 'none', cursor: 'pointer' }}
              >
                {zh ? '忘記密碼？' : 'Forgot password?'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
