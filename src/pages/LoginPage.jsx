import { useState } from 'react'
import { useAuth } from '../hooks/useAuth'

export default function LoginPage() {
  const { signIn, sendPasswordReset } = useAuth()
  const [mode, setMode] = useState('login') // 'login' | 'forgot'

  const [email, setEmail]               = useState('')
  const [password, setPassword]         = useState('')
  const [error, setError]               = useState('')
  const [success, setSuccess]           = useState('')
  const [loading, setLoading]           = useState(false)

  function switchMode(m) {
    setMode(m)
    setEmail(''); setPassword('')
    setError(''); setSuccess('')
  }

  async function handleLogin(e) {
    e.preventDefault()
    setError(''); setLoading(true)
    const { error } = await signIn(email, password)
    if (error) setError('帳號或密碼錯誤，請重試。')
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
