import { useState } from 'react'
import { useAuth } from '../hooks/useAuth'

export default function LoginPage() {
  const { signIn, signUp, sendPasswordReset } = useAuth()
  const [mode, setMode] = useState('login') // 'login' | 'register' | 'forgot'

  const [email, setEmail]               = useState('')
  const [password, setPassword]         = useState('')
  const [name, setName]                 = useState('')
  const [confirm, setConfirm]           = useState('')
  const [error, setError]               = useState('')
  const [success, setSuccess]           = useState('')
  const [loading, setLoading]           = useState(false)

  function switchMode(m) {
    setMode(m)
    setEmail(''); setPassword(''); setName(''); setConfirm('')
    setError(''); setSuccess('')
  }

  async function handleLogin(e) {
    e.preventDefault()
    setError(''); setLoading(true)
    const { error } = await signIn(email, password)
    if (error) setError('帳號或密碼錯誤，請重試。')
    setLoading(false)
  }

  async function handleRegister(e) {
    e.preventDefault()
    setError('')
    if (password !== confirm) return setError('兩次密碼輸入不一致。')
    if (password.length < 6) return setError('密碼至少需要 6 個字元。')
    setLoading(true)
    try {
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/register-backend`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          },
          body: JSON.stringify({ email, password, name }),
        },
      )
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || '註冊失敗，請稍後再試。')
      } else {
        setSuccess('帳號已建立！請至信箱完成驗證後登入。')
      }
    } catch {
      setError('註冊失敗，請稍後再試。')
    }
    setLoading(false)
  }

  async function handleForgot(e) {
    e.preventDefault()
    setError(''); setLoading(true)
    const { error } = await sendPasswordReset(email)
    if (error) setError('發送失敗，請確認電子郵件是否正確。')
    else setSuccess('密碼重設信已發送，請查收信箱。')
    setLoading(false)
  }

  return (
    <div className="login-wrap">
      <div className="login-logo">📦</div>
      <div className="login-title">庫存管理</div>

      {mode !== 'forgot' && (
        <div style={{ display:'flex', gap:8, marginBottom:28, width:'100%', maxWidth:360 }}>
          <button
            type="button"
            className={`btn ${mode === 'login' ? '' : 'btn-outline'}`}
            style={{ flex:1, padding:'10px 0', fontSize:15 }}
            onClick={() => switchMode('login')}
          >
            登入
          </button>
          <button
            type="button"
            className={`btn ${mode === 'register' ? '' : 'btn-outline'}`}
            style={{ flex:1, padding:'10px 0', fontSize:15 }}
            onClick={() => switchMode('register')}
          >
            註冊
          </button>
        </div>
      )}

      <div className="login-card">
        {error   && <div className="error-msg">{error}</div>}
        {success && (
          <div style={{ background:'var(--green-bg)', color:'var(--green)', padding:'10px 14px', borderRadius:10, marginBottom:14, fontSize:13 }}>
            {success}
          </div>
        )}

        {mode === 'login' && (
          <form onSubmit={handleLogin}>
            <div className="form-group">
              <label className="form-label">電子郵件</label>
              <input className="form-input" type="email" placeholder="your@email.com"
                value={email} onChange={e => setEmail(e.target.value)} required autoCapitalize="none" />
            </div>
            <div className="form-group">
              <label className="form-label">密碼</label>
              <input className="form-input" type="password" placeholder="••••••••"
                value={password} onChange={e => setPassword(e.target.value)} required />
            </div>
            <button className="btn" type="submit" disabled={loading}>
              {loading ? '登入中…' : '登入'}
            </button>
            <button type="button" onClick={() => switchMode('forgot')}
              style={{ display:'block', width:'100%', marginTop:14, background:'none', border:'none',
                color:'var(--text-3)', fontSize:13, cursor:'pointer', textAlign:'center' }}>
              忘記密碼？
            </button>
          </form>
        )}

        {mode === 'register' && (
          <form onSubmit={handleRegister}>
            <div className="form-group">
              <label className="form-label">姓名</label>
              <input className="form-input" type="text" placeholder="您的姓名"
                value={name} onChange={e => setName(e.target.value)} required />
            </div>
            <div className="form-group">
              <label className="form-label">電子郵件</label>
              <input className="form-input" type="email" placeholder="your@email.com"
                value={email} onChange={e => setEmail(e.target.value)} required autoCapitalize="none" />
            </div>
            <div className="form-group">
              <label className="form-label">密碼</label>
              <input className="form-input" type="password" placeholder="至少 6 個字元"
                value={password} onChange={e => setPassword(e.target.value)} required />
            </div>
            <div className="form-group">
              <label className="form-label">確認密碼</label>
              <input className="form-input" type="password" placeholder="再次輸入密碼"
                value={confirm} onChange={e => setConfirm(e.target.value)} required />
            </div>
            <button className="btn" type="submit" disabled={loading || !!success}>
              {loading ? '建立中…' : '建立帳號'}
            </button>
          </form>
        )}

        {mode === 'forgot' && (
          <form onSubmit={handleForgot}>
            <p style={{ fontSize:13, color:'var(--text-2)', marginBottom:16 }}>
              輸入您的電子郵件，我們將寄送密碼重設連結。
            </p>
            <div className="form-group">
              <label className="form-label">電子郵件</label>
              <input className="form-input" type="email" placeholder="your@email.com"
                value={email} onChange={e => setEmail(e.target.value)} required autoCapitalize="none" />
            </div>
            <button className="btn" type="submit" disabled={loading || !!success}>
              {loading ? '發送中…' : '發送重設信'}
            </button>
            <button type="button" onClick={() => switchMode('login')}
              style={{ display:'block', width:'100%', marginTop:14, background:'none', border:'none',
                color:'var(--text-3)', fontSize:13, cursor:'pointer', textAlign:'center' }}>
              ← 返回登入
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
