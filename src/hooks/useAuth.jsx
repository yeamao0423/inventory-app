import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)   // { role, name }
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
    const [{ data: profileData }, { data: roleData }] = await Promise.all([
      supabase.from('profiles').select('name, email').eq('id', userId).single(),
      supabase.from('user_store_roles').select('role, store_id').eq('user_id', userId).eq('store_id', 1).single(),
    ])
    setProfile({ ...profileData, role: roleData?.role ?? null })
    setLoading(false)
  }

  async function signIn(email, password) {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error }
  }

  async function signUp(email, password, name) {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { name },
        emailRedirectTo: window.location.origin,
      },
    })
    return { error }
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
    return false
  }

  return (
    <AuthContext.Provider value={{ user, profile, loading, signIn, signUp, sendPasswordReset, signOut, can }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
