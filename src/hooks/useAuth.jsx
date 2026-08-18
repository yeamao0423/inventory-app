import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const AuthContext = createContext(null)

// 多店使用者上次選過哪家店，記在瀏覽器本機（帳號共用，不分店家）
const ACTIVE_STORE_KEY = 'daigogo_active_store_id'

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [profileBase, setProfileBase] = useState(null)   // { name, email }（不含 role，role 是每店各自的）
  const [memberships, setMemberships] = useState([])     // 這位使用者所屬的每一家店 [{ role, store_id, stores }]
  const [activeStoreId, setActiveStoreId] = useState(null)
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
      else { setProfileBase(null); setMemberships([]); setActiveStoreId(null); setLoading(false) }
    })
    return () => subscription.unsubscribe()
  }, [])

  async function fetchProfile(userId, tryClaimInvite = true) {
    const [{ data: profileData }, { data: roleRows }, { data: platformRow }] = await Promise.all([
      supabase.from('profiles').select('name, email').eq('id', userId).single(),
      // 使用者所屬「每一家店」的後台角色（排除歷史遺留的 consumer rows）。
      // 過去這裡帶 .limit(1) 只取最早那家店，身兼多店角色的使用者永遠進不去後面加入的店——
      // 這就是「後台看不到某店客服功能」的根因：storeId 被鎖死在第一家店，不是那家店真的沒有這個功能。
      supabase.from('user_store_roles')
        .select('role, store_id, stores ( id, name, slug, custom_domain, is_active, settings )')
        .eq('user_id', userId)
        .neq('role', 'consumer')
        .order('created_at', { ascending: true }),
      supabase.from('platform_admins').select('user_id').eq('user_id', userId).maybeSingle(),
    ])
    const rows = roleRows ?? []

    // 沒有任何後台角色 → 以 email 認領 pending 邀請（涵蓋驗證信導回掉 token、在無 token 分頁登入的情況）
    if (rows.length === 0 && tryClaimInvite) {
      const { data: claim } = await supabase.rpc('accept_invitation_by_email')
      if (claim?.accepted > 0) return fetchProfile(userId, false)  // 認領到角色 → 重抓一次（不再遞迴認領）
    }

    // 預設仍是「第一家店」（單店使用者、或第一次登入的多店使用者，行為與過去一致）；
    // 上次手動切換過店的話，只要那家店還在名單裡就沿用，重新整理／重新登入不會被打回第一家店。
    const saved = localStorage.getItem(ACTIVE_STORE_KEY)
    const savedValid = saved && rows.some(r => String(r.store_id) === saved)

    setProfileBase(profileData ?? null)
    setMemberships(rows)
    setActiveStoreId(savedValid ? Number(saved) : (rows[0]?.store_id ?? null))
    setIsPlatformAdmin(!!platformRow)
    setLoading(false)
  }

  /** 切換目前操作的店（只能切到自己有角色的店）。 */
  function switchStore(storeId) {
    if (!memberships.some(m => m.store_id === storeId)) return
    localStorage.setItem(ACTIVE_STORE_KEY, String(storeId))
    setActiveStoreId(storeId)
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

  // 目前操作的店＋在那家店的角色（角色是每店各自的，換店角色可能不一樣）
  const activeMembership = memberships.find(m => m.store_id === activeStoreId) ?? null
  const profile = profileBase ? { ...profileBase, role: activeMembership?.role ?? null } : null
  const store = activeMembership?.stores ?? null
  const storeId = store?.id ?? null
  // 給切店 UI 用的清單：只有身兼多店角色的使用者會用到（單店使用者長度恆為 0 或 1，UI 不出現）
  const stores = memberships.map(m => ({ id: m.store_id, name: m.stores?.name ?? '', role: m.role }))

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

  // 店家設定變更後（如開店精靈、店家設定 Sheet）刷新 context
  async function refreshStore() {
    if (user) await fetchProfile(user.id)
  }

  return (
    <AuthContext.Provider value={{
      user, profile, loading, signIn, signUp, sendPasswordReset, signOut, can,
      isBackendUser, store, storeId, stores, switchStore, isPlatformAdmin, refreshStore,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
