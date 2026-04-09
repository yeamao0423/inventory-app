'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../../lib/supabase'
import { useI18n } from '../../layout'

export default function ResetPasswordPage() {
  const { lang } = useI18n()
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const zh = lang === 'zh'

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') setReady(true)
    })
    return () => subscription.unsubscribe()
  }, [])

  async function handleReset() {
    if (!password) { setError(zh ? '請輸入新密碼' : 'Please enter a new password'); return }
    if (password !== confirmPassword) { setError(zh ? '兩次密碼不一致' : 'Passwords do not match'); return }
    if (password.length < 6) { setError(zh ? '密碼至少 6 個字元' : 'Password must be at least 6 characters'); return }
    setLoading(true); setError('')
    const { error } = await supabase.auth.updateUser({ password })
    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      setMessage(zh ? '密碼已更新！即將跳轉…' : 'Password updated! Redirecting…')
      setTimeout(() => router.push('/account'), 2000)
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h2 className="auth-title">{zh ? '設定新密碼' : 'Set New Password'}</h2>

        {error && <div className="auth-error">{error}</div>}
        {message && <div className="auth-success">{message}</div>}

        {!ready && !message && (
          <div style={{ color: 'var(--text-3)', fontSize: 14, textAlign: 'center', padding: '20px 0' }}>
            {zh ? '正在驗證連結…' : 'Verifying link…'}
          </div>
        )}

        {ready && !message && (
          <>
            <div className="form-group">
              <label className="form-label">{zh ? '新密碼' : 'New Password'} *</label>
              <input
                className="form-input"
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={zh ? '至少 6 個字元' : 'At least 6 characters'}
              />
            </div>
            <div className="form-group">
              <label className="form-label">{zh ? '確認新密碼' : 'Confirm Password'} *</label>
              <input
                className="form-input"
                type="password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleReset()}
              />
            </div>
            <button className="btn-primary" style={{ marginTop: 8 }} onClick={handleReset} disabled={loading}>
              {loading ? (zh ? '更新中…' : 'Updating…') : (zh ? '更新密碼' : 'Update Password')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
