import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)   // { role, name }
  const [store, setStore] = useState(null)       // { id, name, slug, settings } 使用者所屬店
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      if (session?.user) fetchProfile(session.user.id)
      else setLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      setUser(session?.user ?? null)
      if (session?.user) fetchProfile(session.user.id)
      else { setProfile(null); setLoading(false) }
    })
    return () => subscription.unsubscribe()
  }, [])

  async function fetchProfile(userId) {
    const [{ data: profileData }, { data: roleRows }, { data: platformRow }] = await Promise.all([
      supabase.from('profiles').select('name, email').eq('id', userId).single(),
      // 使用者所屬店的後台角色（排除歷史遺留的 consumer rows），目前取第一間店
      supabase.from('user_store_roles')
        .select('role, store_id, stores ( id, name, slug, is_active, settings )')
        .eq('user_id', userId)
        .neq('role', 'consumer')
        .order('created_at', { ascending: true })
        .limit(1),
      supabase.from('platform_admins').select('user_id').eq('user_id', userId).maybeSingle(),
    ])
    const membership = roleRows?.[0] ?? null
    setProfile({ ...profileData, role: membership?.role ?? null })
    setStore(membership?.stores ?? null)
    setIsPlatformAdmin(!!platformRow)
    setLoading(false)
  }

  async function signIn(email, password) {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error }
  }

  async function signUp(email, password, name, redirectTo) {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { name },
        emailRedirectTo: redirectTo || window.location.origin,
      },
    })
    return { data, error }
  }

  async function sendPasswordReset(email) {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    })
    return { error }
  }

  async function signOut() {
    await supabase.auth.signOut()
  }

  // 權限檢查
  // actions: 'view' | 'add' | 'edit' | 'delete' | 'pay' | 'manage_users'
  function can(action) {
    const role = profile?.role
    if (role === 'super_admin') return true
    if (role === 'admin') return action !== 'manage_users'
    if (role === 'editor') return ['view', 'add', 'edit', 'pay'].includes(action)
    if (role === 'viewer') return action === 'view'
    // consumer 無任何後台權限
    return false
  }

  const isBackendUser = !!(profile?.role && profile.role !== 'consumer')
  const storeId = store?.id ?? null

  // 店家設定變更後（如開店精靈、店家設定 Sheet）刷新 context
  async function refreshStore() {
    if (user) await fetchProfile(user.id)
  }

  return (
    <AuthContext.Provider value={{
      user, profile, loading, signIn, signUp, sendPasswordReset, signOut, can,
      isBackendUser, store, storeId, isPlatformAdmin, refreshStore,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
