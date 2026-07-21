'use client'
// LINE 登入卡片 UI（LIFF 頁與 Web OAuth callback 頁共用）
// 各 phase 對應 useLineLogin 狀態機；email 關卡 = 乾淨版強制補填（送出才建帳號）
export default function LoginCard({ flow }) {
  const {
    phase, msg, lineName, emailInput, setEmailInput, password, setPassword,
    submitEmail, verifyWithPassword, sendMagicLink,
  } = flow

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h2 className="auth-title">用 LINE 繼續</h2>
        {msg && (phase === 'error'
          ? <div className="auth-error">{msg}</div>
          : <div className="auth-error" style={{ background: 'var(--bg)', color: 'var(--text-2)' }}>{msg}</div>)}

        {phase === 'verifying' && (
          <p style={{ fontSize: 14, color: 'var(--text-3)' }}>正在確認你的 LINE 身分…</p>
        )}

        {phase === 'creating' && (
          <p style={{ fontSize: 14, color: 'var(--text-3)' }}>正在為你建立帳號…</p>
        )}

        {phase === 'need_email' && (
          <>
            <p style={{ fontSize: 14, color: 'var(--text-3)', marginBottom: 12 }}>
              {lineName ? `嗨 ${lineName}！` : '嗨！'}最後一步：確認你的 Email，它將作為你的會員帳號
              （訂單通知、對帳都靠它）。
            </p>
            <div className="form-group">
              <label className="form-label">Email *</label>
              <input className="form-input" type="email" value={emailInput}
                onChange={e => setEmailInput(e.target.value)}
                placeholder="example@email.com"
                onKeyDown={e => e.key === 'Enter' && submitEmail()} />
            </div>
            <button className="btn-primary" style={{ marginTop: 8 }} onClick={submitEmail}>
              完成註冊
            </button>
          </>
        )}

        {phase === 'needs_verification' && (
          <>
            <p style={{ fontSize: 14, color: 'var(--text-3)', marginBottom: 12 }}>
              <b>{emailInput}</b> 已經是會員帳號。為了保護帳號安全，
              請證明你是本人，我們就會把這個 LINE 綁到你的帳號上。
            </p>
            <div className="form-group">
              <label className="form-label">輸入密碼</label>
              <input className="form-input" type="password" value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && verifyWithPassword()} />
            </div>
            <button className="btn-primary" style={{ marginTop: 8 }} onClick={verifyWithPassword}>
              驗證並綁定 LINE
            </button>
            <button
              onClick={sendMagicLink}
              style={{ display: 'block', width: '100%', margin: '14px auto 0', fontSize: 13, color: 'var(--text-3)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
              忘記密碼？改寄登入連結到信箱
            </button>
          </>
        )}

        {phase === 'link_sent' && (
          <p style={{ fontSize: 14, color: 'var(--text-3)' }}>
            登入連結已寄到 <b>{emailInput}</b>。請點信中連結完成登入，
            之後依畫面指示綁定 LINE 即可。
          </p>
        )}

        {phase === 'error' && (
          <button className="btn-primary" style={{ marginTop: 8 }} onClick={() => window.location.reload()}>
            重試
          </button>
        )}
      </div>
    </div>
  )
}
