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

  // 登入後若有待處理邀請，自動接受。
  // 也涵蓋「驗證完→跨分頁 session 同步進來」：此時即使停在 verify_sent，也直接往下接受，
  // 不再丟出登入表單讓使用者誤點。
  useEffect(() => {
    if (user && invite && (status === 'valid' || status === 'verify_sent')) acceptInvite()
  }, [user, invite, status])

  async function loadInvite() {
    // invitations 已不開放匿名直讀（防 token 列舉），改走 RPC 點查
    const { data, error } = await supabase.rpc('get_invitation', { p_token: token })

    if (error || !data) return setStatus('invalid')
    if (data.status === 'accepted') return setStatus('accepted')
    if (new Date(data.expires_at) < new Date()) return setStatus('expired')

    setInvite({ ...data, stores: { name: data.store_name } })
    setEmail(data.email)
    // 被邀請的 email 已註冊 → 預設「登入」；尚未註冊 → 預設「註冊」
    setAuthMode(data.email_registered ? 'login' : 'register')
    setStatus('valid')
  }

  async function acceptInvite() {
    setSubmitting(true)
    // 角色 upsert ＋ 標記 accepted 由 SECURITY DEFINER RPC 原子完成
    const { data, error } = await supabase.rpc('accept_invitation', { p_token: token })

    if (error || !data?.ok) {
      setError(data?.error || '發生錯誤，請稍後再試。')
      setSubmitting(false)
      return
    }

    await refreshStore()   // 讓 context 立即帶上新店身分
    setStatus('done')
    setSubmitting(false)
  }

  async function handleLogin(e) {
    e.preventDefault()
    setError(''); setSubmitting(true)
    const { error } = await signIn(email, password)
    if (error) {
      // email 確認開啟時，未驗證者也會被擋下；要與「密碼錯誤」分開，否則使用者會誤以為打錯密碼
      const unconfirmed = error.code === 'email_not_confirmed'
        || /not confirmed/i.test(error.message || '')
      setError(unconfirmed
        ? '此 Email 尚未驗證，請先到信箱點擊驗證連結再登入。'
        : '帳號或密碼錯誤，請重試。')
    }
    setSubmitting(false)
    // acceptInvite 會由 useEffect 觸發
  }

  async function handleRegister(e) {
    e.preventDefault()
    setError(''); setSubmitting(true)
    // 驗證信導回「邀請連結本身」：驗證完回到邀請頁、已登入 → 自動接受邀請
    const { data, error } = await signUp(email, password, name, window.location.href)
    if (error) {
      setError(error.message.includes('already') ? '此 Email 已被註冊，請直接登入。' : '註冊失敗，請稍後再試。')
      setSubmitting(false)
      return
    }
    setSubmitting(false)
    // email 確認開啟時，註冊後沒有 session → 提示去信箱驗證、再回來登入接受邀請
    // （若未開 email 確認、已有 session，下方 useEffect 會自動接受）
    if (!data?.session) setStatus('verify_sent')
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

  if (status === 'verify_sent') return (
    <Wrap>
      <div style={{ fontSize:36, marginBottom:12 }}>📧</div>
      <div style={{ fontWeight:600, marginBottom:8 }}>註冊成功，請先驗證 Email</div>
      <p style={{ fontSize:13, color:'var(--text-3)', lineHeight:1.6 }}>
        驗證信已寄到 <strong>{email}</strong>。<br/>
        點擊信中的連結後，會自動帶你回來完成加入，<strong>不需要再手動登入</strong>。
      </p>
      {/* 次要 fallback：僅供「已完成驗證但沒被自動帶回」時使用，避免誘導使用者在驗證前就去登入 */}
      <button className="btn btn-outline" style={{ marginTop:16, maxWidth:240, margin:'16px auto 0', fontSize:13 }}
        onClick={() => { setStatus('valid'); setAuthMode('login'); setPassword('') }}>
        已完成驗證？前往登入
      </button>
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
