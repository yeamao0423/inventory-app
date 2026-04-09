'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../lib/supabase'
import { useI18n } from '../layout'

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
  const zh = lang === 'zh'

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
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { name } },
    })
    if (error) {
      setError(error.message)
    } else if (data.user && !data.session) {
      setMessage(zh
        ? '驗證信已寄出！請至信箱（或 Inbucket http://127.0.0.1:54324）點擊確認連結後再登入'
        : 'Confirmation email sent. Check your inbox (or Inbucket at http://127.0.0.1:54324) and click the link.')
    } else {
      router.push('/account')
    }
    setLoading(false)
  }

  async function handleForgot() {
    if (!email) { setError(zh ? '請輸入 Email' : 'Please enter your email'); return }
    setLoading(true); setError('')
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/reset-password`,
    })
    if (error) setError(error.message)
    else setMessage(zh
      ? '重設連結已寄出！請至信箱（或 Inbucket http://127.0.0.1:54324）點擊連結'
      : 'Reset link sent. Check your inbox (or Inbucket at http://127.0.0.1:54324).')
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
