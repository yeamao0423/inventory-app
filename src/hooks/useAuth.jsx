mport { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
 
const AuthContext = createContext(null)
 
export function AuthProvider({ children }) {
  const [user, setUser]       = useState(null)
  const [profile, setProfile] = useState(null)
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
    // 最多重試 3 次，避免 RLS 暫時性問題
    for (let i = 0; i < 3; i++) {
      const { data, error } = await supabase
        .from('profiles')
        .select('name, role')
        .eq('id', userId)
        .single()
 
      if (data) {
        setProfile(data)
        setLoading(false)
        return
      }
 
      // profile 不存在時自動建立
      if (error?.code === 'PGRST116') {
        await supabase.from('profiles').upsert({
          id: userId,
          name: 'User',
          role: 'viewer'
        })
        continue
      }
 
      // 短暫等待後重試
      await new Promise(r => setTimeout(r, 500))
    }
 
    // 最終還是讀不到時，預設 viewer
    setProfile({ name: 'User', role: 'viewer' })
    setLoading(false)
  }
 
  async function signIn(email, password) {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error }
  }
 
  async function signOut() {
    await supabase.auth.signOut()
  }
 
  function can(action) {
    const role = profile?.role
    if (role === 'admin')  return true
    if (role === 'editor') return ['view', 'add', 'edit', 'pay'].includes(action)
    if (role === 'viewer') return action === 'view'
    return false
  }
 
  return (
    <AuthContext.Provider value={{ user, profile, loading, signIn, signOut, can }}>
      {children}
    </AuthContext.Provider>
  )
}
 
export const useAuth = () => useContext(AuthContext)
