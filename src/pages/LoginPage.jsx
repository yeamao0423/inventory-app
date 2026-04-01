import { useState } from 'react'
import { useAuth } from '../hooks/useAuth'

export default function LoginPage() {
  const { signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const { error } = await signIn(email, password)
    if (error) setError('帳號或密碼錯誤，請重試。')
    setLoading(false)
  }

  return (
    <div className="login-wrap">
      <div className="login-logo">📦</div>
      <div className="login-title">庫存管理</div>
      <div className="login-sub">請登入以繼續</div>

      <div className="login-card">
        {error && <div className="error-msg">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">電子郵件</label>
            <input
              className="form-input"
              type="email"
              placeholder="your@email.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoCapitalize="none"
            />
          </div>
          <div className="form-group">
            <label className="form-label">密碼</label>
            <input
              className="form-input"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
            />
          </div>
          <button className="btn" type="submit" disabled={loading}>
            {loading ? '登入中…' : '登入'}
          </button>
        </form>
      </div>

      <p style={{fontSize:12,color:'var(--text-3)',marginTop:20,textAlign:'center'}}>
        帳號由管理員建立，如需協助請聯絡管理員
      </p>
    </div>
  )
}
