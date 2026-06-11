import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'

const ROLE_LABEL = { super_admin: '店主', admin: '管理員', editor: '編輯者', viewer: '檢視者' }

export default function InvitePage() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')
  const { user, signIn, signUp, refreshStore } = useAuth()

  const [invite, setInvite]   = useState(null)   // invitation record
  const [status, setStatus]   = useState('loading') // loading | valid | invalid | expired | accepted | done
  const [authMode, setAuthMode] = useState('login')  // login | register
  const [email, setEmail]     = useState('')
  const [password, setPassword] = useState('')
  const [name, setName]       = useState('')
  const [error, setError]     = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (token) loadInvite()
    else setStatus('invalid')
  }, [token])

  // 登入後若有待處理邀請，自動接受
  useEffect(() => {
    if (user && invite && status === 'valid') acceptInvite()
  }, [user, invite, status])

  async function loadInvite() {
    const { data, error } = await supabase
      .from('invitations')
      .select('id, email, role, store_id, status, expires_at, stores(name)')
      .eq('token', token)
      .single()

    if (error || !data) return setStatus('invalid')
    if (data.status === 'accepted') return setStatus('accepted')
    if (new Date(data.expires_at) < new Date()) return setStatus('expired')

    setInvite(data)
    setEmail(data.email)
    setStatus('valid')
  }

  async function acceptInvite() {
    setSubmitting(true)
    // upsert role
    const { error } = await supabase
      .from('user_store_roles')
      .upsert({ user_id: user.id, store_id: invite.store_id, role: invite.role },
               { onConflict: 'user_id,store_id' })

    if (error) { setError('發生錯誤，請稍後再試。'); setSubmitting(false); return }

    // mark invitation as accepted
    await supabase
      .from('invitations')
      .update({ status: 'accepted' })
      .eq('id', invite.id)

    await refreshStore()   // 讓 context 立即帶上新店身分
    setStatus('done')
    setSubmitting(false)
  }

  async function handleLogin(e) {
    e.preventDefault()
    setError(''); setSubmitting(true)
    const { error } = await signIn(email, password)
    if (error) setError('帳號或密碼錯誤，請重試。')
    setSubmitting(false)
    // acceptInvite 會由 useEffect 觸發
  }

  async function handleRegister(e) {
    e.preventDefault()
    setError(''); setSubmitting(true)
    const { error } = await signUp(email, password, name)
    if (error) setError(error.message.includes('already') ? '此 Email 已被註冊，請直接登入。' : '註冊失敗，請稍後再試。')
    setSubmitting(false)
  }

  // ── Render states ──

  if (status === 'loading') return <Wrap><p style={{ color:'var(--text-3)' }}>驗證邀請連結中…</p></Wrap>

  if (status === 'invalid') return (
    <Wrap>
      <div style={{ fontSize:36, marginBottom:12 }}>❌</div>
      <div style={{ fontWeight:600, marginBottom:8 }}>無效的邀請連結</div>
      <p style={{ fontSize:13, color:'var(--text-3)' }}>此連結不存在或已失效。</p>
    </Wrap>
  )

  if (status === 'expired') return (
    <Wrap>
      <div style={{ fontSize:36, marginBottom:12 }}>⏰</div>
      <div style={{ fontWeight:600, marginBottom:8 }}>邀請連結已過期</div>
      <p style={{ fontSize:13, color:'var(--text-3)' }}>請聯繫管理員重新發送邀請。</p>
    </Wrap>
  )

  if (status === 'accepted') return (
    <Wrap>
      <div style={{ fontSize:36, marginBottom:12 }}>✅</div>
      <div style={{ fontWeight:600, marginBottom:8 }}>此邀請已被接受</div>
      <p style={{ fontSize:13, color:'var(--text-3)' }}>請直接登入系統。</p>
      <a href="/" style={{ marginTop:16, display:'block', textAlign:'center', fontSize:14, color:'var(--text)' }}>前往登入</a>
    </Wrap>
  )

  if (status === 'done') return (
    <Wrap>
      <div style={{ fontSize:36, marginBottom:12 }}>🎉</div>
      <div style={{ fontWeight:600, marginBottom:8 }}>已成功加入！</div>
      <p style={{ fontSize:13, color:'var(--text-3)' }}>
        你的角色已更新為 <strong>{ROLE_LABEL[invite?.role]}</strong>。
      </p>
      <a href="/" style={{ marginTop:16, display:'block', textAlign:'center', fontSize:14, color:'var(--text)' }}>進入後台</a>
    </Wrap>
  )

  // status === 'valid'
  return (
    <div className="login-wrap">
      <div className="login-logo">📦</div>
      <div className="login-title">庫存管理</div>

      <div className="login-card" style={{ marginBottom:24 }}>
        <div style={{ fontSize:13, color:'var(--text-2)', marginBottom:4 }}>你收到一份邀請</div>
        <div style={{ fontWeight:600, fontSize:17 }}>
          加入「{invite?.stores?.name}」成為 {ROLE_LABEL[invite?.role]}
        </div>
        <div style={{ fontSize:12, color:'var(--text-3)', marginTop:4 }}>
          到期時間：{new Date(invite?.expires_at).toLocaleDateString('zh-TW')}
        </div>
      </div>

      {user ? (
        // 已登入，直接確認
        <div className="login-card">
          <p style={{ fontSize:14, marginBottom:16 }}>
            以 <strong>{user.email}</strong> 的身份接受此邀請？
          </p>
          {error && <div className="error-msg">{error}</div>}
          <button className="btn" onClick={acceptInvite} disabled={submitting}>
            {submitting ? '處理中…' : '確認接受邀請'}
          </button>
        </div>
      ) : (
        // 未登入，顯示登入/註冊
        <>
          <div style={{ display:'flex', gap:8, marginBottom:20, width:'100%', maxWidth:360 }}>
            <button type="button"
              className={`btn ${authMode === 'login' ? '' : 'btn-outline'}`}
              style={{ flex:1, padding:'10px 0', fontSize:15 }}
              onClick={() => setAuthMode('login')}>登入</button>
            <button type="button"
              className={`btn ${authMode === 'register' ? '' : 'btn-outline'}`}
              style={{ flex:1, padding:'10px 0', fontSize:15 }}
              onClick={() => setAuthMode('register')}>註冊</button>
          </div>

          <div className="login-card">
            {error && <div className="error-msg">{error}</div>}

            {authMode === 'login' ? (
              <form onSubmit={handleLogin}>
                <div className="form-group">
                  <label className="form-label">電子郵件</label>
                  <input className="form-input" type="email" value={email}
                    onChange={e => setEmail(e.target.value)} required autoCapitalize="none" />
                </div>
                <div className="form-group">
                  <label className="form-label">密碼</label>
                  <input className="form-input" type="password" placeholder="••••••••"
                    value={password} onChange={e => setPassword(e.target.value)} required />
                </div>
                <button className="btn" type="submit" disabled={submitting}>
                  {submitting ? '登入中…' : '登入並接受邀請'}
                </button>
              </form>
            ) : (
              <form onSubmit={handleRegister}>
                <div className="form-group">
                  <label className="form-label">姓名</label>
                  <input className="form-input" type="text" placeholder="您的姓名"
                    value={name} onChange={e => setName(e.target.value)} required />
                </div>
                <div className="form-group">
                  <label className="form-label">電子郵件</label>
                  <input className="form-input" type="email" value={email}
                    onChange={e => setEmail(e.target.value)} required autoCapitalize="none" />
                </div>
                <div className="form-group">
                  <label className="form-label">密碼</label>
                  <input className="form-input" type="password" placeholder="至少 6 個字元"
                    value={password} onChange={e => setPassword(e.target.value)} required />
                </div>
                <button className="btn" type="submit" disabled={submitting}>
                  {submitting ? '註冊中…' : '註冊並接受邀請'}
                </button>
              </form>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Wrap({ children }) {
  return (
    <div className="login-wrap">
      <div style={{ textAlign:'center' }}>{children}</div>
    </div>
  )
}
