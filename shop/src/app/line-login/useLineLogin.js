'use client'
// LINE 登入共用邏輯（LIFF 頁與 Web OAuth callback 頁共用）
// 狀態機：verifying → (need_email | needs_verification | link_sent | error) → done
// 乾淨版（docs/line-login-plan.md §3.1）：email 關卡掉出不留任何帳號；
// id_token 暫存 sessionStorage，同頁重整不用重跑 LINE 驗證。
import { useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../lib/supabase'
import { getStore } from '../../lib/store'

export const LOGIN_ENDPOINT = `${process.env.NEXT_PUBLIC_SUPABASE_URL || ''}/functions/v1/line-login`
const BIND_ENDPOINT = `${process.env.NEXT_PUBLIC_SUPABASE_URL || ''}/functions/v1/line-bind`
// 登入前沒有 session，gateway 需要 anon key 才放行
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

export const IDT_KEY = 'line_login_idt'       // 補 email 關卡期間暫存 id_token
export const STATE_KEY = 'line_login_state'   // Web OAuth CSRF state

export function loadLiff() {
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

export function getRedirect() {
  if (typeof window === 'undefined') return '/account'
  const r = new URLSearchParams(window.location.search).get('redirect')
  // 只接受站內路徑，防 open redirect
  return r && r.startsWith('/') && !r.startsWith('//') ? r : '/account'
}

export function useLineLogin() {
  const router = useRouter()
  const [phase, setPhase] = useState('verifying') // verifying | need_email | needs_verification | link_sent | creating | error
  const [msg, setMsg] = useState('')
  const [lineName, setLineName] = useState('')
  const [emailInput, setEmailInput] = useState('')
  const [password, setPassword] = useState('')
  const idTokenRef = useRef('')

  // 拿到 session 後的共同落地：連回匯入名單 → 回跳
  const finishLogin = useCallback(async (tokenHash) => {
    const { error } = await supabase.auth.verifyOtp({ type: 'magiclink', token_hash: tokenHash })
    if (error) { setPhase('error'); setMsg('登入建立失敗，請重新操作'); return }
    try {
      const store = await getStore()
      await supabase.rpc('promote_member', { p_store_id: store.id })
    } catch { /* 合併失敗不擋登入；/account 載入時會再跑一次 */ }
    sessionStorage.removeItem(IDT_KEY)
    router.replace(getRedirect())
  }, [router])

  const handleResult = useCallback(async (res, out) => {
    if (!res.ok || !out.ok) { setPhase('error'); setMsg(out.error || '登入失敗，請稍後再試'); return }
    if (out.id_token) {
      idTokenRef.current = out.id_token
      try { sessionStorage.setItem(IDT_KEY, out.id_token) } catch { /* 私密模式可能失敗，無妨 */ }
    }
    setLineName(out.line_name || '')
    if (out.status === 'logged_in' || out.status === 'created') { await finishLogin(out.token_hash); return }
    if (out.status === 'need_email') {
      if (out.line_email) setEmailInput(prev => prev || out.line_email)
      setPhase('need_email')
      return
    }
    if (out.status === 'needs_verification') { setPhase('needs_verification'); return }
    setPhase('error'); setMsg('未知的回應，請稍後再試')
  }, [finishLogin])

  const callLogin = useCallback(async (mode, payload) => {
    setPhase(mode === 'create' ? 'creating' : 'verifying'); setMsg('')
    let storeId = null
    try { storeId = (await getStore()).id } catch { /* 取不到店家就交給後端 env fallback */ }
    const res = await fetch(LOGIN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
      body: JSON.stringify({ mode, p_store_id: storeId, ...payload }),
    }).catch(() => null)
    if (!res) { setPhase('error'); setMsg('連線失敗，請稍後再試'); return }
    const out = await res.json().catch(() => ({}))
    await handleResult(res, out)
  }, [handleResult])

  // 入口：LIFF 帶 { id_token }；Web OAuth 帶 { code, redirect_uri }
  const start = useCallback((payload) => {
    if (payload.id_token) {
      idTokenRef.current = payload.id_token
      try { sessionStorage.setItem(IDT_KEY, payload.id_token) } catch { /* ignore */ }
    }
    return callLogin('login', payload)
  }, [callLogin])

  // email 關卡送出（乾淨版：此刻才真正建帳號）
  const submitEmail = useCallback(() => {
    const email = emailInput.trim()
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setMsg('請輸入正確的 Email'); return }
    const idToken = idTokenRef.current || sessionStorage.getItem(IDT_KEY) || ''
    if (!idToken) { setPhase('error'); setMsg('LINE 驗證已失效，請重新登入'); return }
    return callLogin('create', { id_token: idToken, email })
  }, [emailInput, callLogin])

  // 本人驗證（手段 B）：密碼登入成功 = 證明本人 → 用既有 line-bind 綁定
  const verifyWithPassword = useCallback(async () => {
    const email = emailInput.trim()
    if (!password) { setMsg('請輸入密碼'); return }
    setMsg('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) { setMsg('密碼錯誤，請再試一次'); return }
    const idToken = idTokenRef.current || sessionStorage.getItem(IDT_KEY) || ''
    const { data: { session } } = await supabase.auth.getSession()
    let storeId = null
    try { storeId = (await getStore()).id } catch { /* 取不到就交給後端 env fallback */ }
    const res = await fetch(BIND_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
      body: JSON.stringify({ id_token: idToken, p_store_id: storeId }),
    }).catch(() => null)
    const out = res ? await res.json().catch(() => ({})) : {}
    if (!res?.ok || !out.ok) {
      // 已登入但綁定沒成 → 導去既有綁定頁重跑 LINE 認證，不擋人
      router.replace('/line-bind')
      return
    }
    sessionStorage.removeItem(IDT_KEY)
    router.replace(getRedirect())
  }, [emailInput, password, router])

  // 本人驗證（手段 A）：寄登入連結，點信後落在既有 /line-bind 完成綁定
  // （跨瀏覽器開信也成立：/line-bind 會自己重跑 LINE 認證）
  const sendMagicLink = useCallback(async () => {
    const email = emailInput.trim()
    setMsg('')
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: `${window.location.origin}/line-bind` },
    })
    if (error) { setMsg('寄送失敗，請稍後再試或改用密碼登入'); return }
    setPhase('link_sent')
  }, [emailInput])

  return {
    phase, msg, lineName, emailInput, setEmailInput, password, setPassword,
    setPhase, setMsg, start, submitEmail, verifyWithPassword, sendMagicLink,
  }
}
