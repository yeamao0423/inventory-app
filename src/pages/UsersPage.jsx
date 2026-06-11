import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import CustomSelect from '../components/CustomSelect'

const ROLE_LABEL = { super_admin:'超級管理員', admin:'管理員', editor:'編輯者', viewer:'檢視者', consumer:'消費者' }
const ROLE_BADGE = { super_admin:'badge-warn', admin:'badge-blue', editor:'badge-ok', viewer:'badge', consumer:'badge' }

export default function UsersPage() {
  const { profile, user, can, storeId } = useAuth()
  const [users, setUsers]           = useState([])
  const [invitations, setInvitations] = useState([])
  const [loading, setLoading]       = useState(true)
  const [saving, setSaving]         = useState(null)

  // invite form
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole]   = useState('editor')
  const [inviting, setInviting]       = useState(false)
  const [inviteLink, setInviteLink]   = useState('')
  const [copied, setCopied]           = useState(false)
  const [consumersOpen, setConsumersOpen] = useState(false)

  const canAccess     = profile?.role === 'super_admin' || profile?.role === 'admin'
  const canChangeRole = can('manage_users')

  useEffect(() => { if (canAccess && storeId) { fetchUsers(); fetchInvitations() } }, [canAccess, storeId])

  async function fetchUsers() {
    setLoading(true)
    const { data: roles } = await supabase
      .from('user_store_roles')
      .select('user_id, role, created_at')
      .eq('store_id', storeId)
      .order('created_at', { ascending: true })

    if (!roles || roles.length === 0) { setUsers([]); setLoading(false); return }

    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, name, email')
      .in('id', roles.map(r => r.user_id))

    const profileMap = Object.fromEntries((profiles ?? []).map(p => [p.id, p]))

    setUsers(roles.map(r => ({
      id: r.user_id,
      name: profileMap[r.user_id]?.name,
      email: profileMap[r.user_id]?.email,
      role: r.role,
      created_at: r.created_at,
    })))
    setLoading(false)
  }

  async function fetchInvitations() {
    const { data } = await supabase
      .from('invitations')
      .select('id, email, role, status, expires_at, created_at')
      .eq('store_id', storeId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
    setInvitations(data ?? [])
  }

  async function changeRole(userId, newRole) {
    setSaving(userId)
    const { error } = await supabase
      .from('user_store_roles')
      .update({ role: newRole })
      .eq('user_id', userId)
      .eq('store_id', storeId)
    if (!error) setUsers(prev => prev.map(u => u.id === userId ? { ...u, role: newRole } : u))
    setSaving(null)
  }

  async function removeMember(u) {
    if (!confirm(`確定移除成員「${u.name || u.email}」？移除後對方將失去本店後台存取權。`)) return
    setSaving(u.id)
    const { error } = await supabase
      .from('user_store_roles')
      .delete()
      .eq('user_id', u.id)
      .eq('store_id', storeId)
    if (!error) setUsers(prev => prev.filter(x => x.id !== u.id))
    else alert('移除失敗：' + error.message)
    setSaving(null)
  }

  async function sendInvite(e) {
    e.preventDefault()
    setInviting(true); setInviteLink('')
    const { data, error } = await supabase
      .from('invitations')
      .insert({ email: inviteEmail, role: inviteRole, store_id: storeId, invited_by: user.id })
      .select('token')
      .single()
    if (!error) {
      const link = `${window.location.origin}/invite?token=${data.token}`
      setInviteLink(link)
      setInviteEmail('')
      fetchInvitations()
    }
    setInviting(false)
  }

  async function cancelInvite(id) {
    await supabase.from('invitations').update({ status: 'expired' }).eq('id', id)
    setInvitations(prev => prev.filter(i => i.id !== id))
  }

  function copyLink() {
    navigator.clipboard.writeText(inviteLink)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (!canAccess) return (
    <div className="page">
      <div className="empty" style={{ paddingTop:80 }}>
        <div style={{ fontSize:36, marginBottom:12 }}>🔒</div>
        <div>僅管理員以上可存取此頁面</div>
      </div>
    </div>
  )

  return (
    <div className="page">
      <div className="ph">
        <div>
          <div className="ph-title">成員管理</div>
          <div className="ph-sub">{users.filter(u => u.role !== 'consumer').length} 位後台成員</div>
        </div>
      </div>

      {/* 邀請表單（僅 super_admin） */}
      {canChangeRole && (
        <>
          <div className="sec">邀請新成員</div>
          <div className="card" style={{ padding:'16px' }}>
            <form onSubmit={sendInvite}>
              <div className="form-group" style={{ marginBottom:10 }}>
                <label className="form-label">電子郵件</label>
                <input className="form-input" type="email" placeholder="colleague@email.com"
                  value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} required />
              </div>
              <div style={{ display:'flex', gap:8, alignItems:'flex-end' }}>
                <div style={{ flex:1 }}>
                  <label className="form-label">指定角色</label>
                  <CustomSelect
                    label="選擇角色"
                    value={inviteRole}
                    options={[
                      { value: 'viewer', label: '檢視者' },
                      { value: 'editor', label: '編輯者' },
                      { value: 'admin', label: '管理員' },
                    ]}
                    onChange={v => v && setInviteRole(v)}
                    allowClear={false}
                  />
                </div>
                <button className="btn" type="submit" disabled={inviting}
                  style={{ width:'auto', padding:'11px 20px', fontSize:14, whiteSpace:'nowrap' }}>
                  {inviting ? '產生中…' : '產生邀請連結'}
                </button>
              </div>
            </form>

            {inviteLink && (
              <div style={{ marginTop:14, background:'var(--bg)', borderRadius:10, padding:'10px 12px' }}>
                <div style={{ fontSize:11, color:'var(--text-3)', marginBottom:6 }}>邀請連結（有效 7 天）</div>
                <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                  <div style={{ fontSize:12, color:'var(--text-2)', wordBreak:'break-all', flex:1 }}>
                    {inviteLink}
                  </div>
                  <button onClick={copyLink} className="btn"
                    style={{ width:'auto', padding:'6px 14px', fontSize:13, flexShrink:0 }}>
                    {copied ? '已複製' : '複製'}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 待處理邀請 */}
          {invitations.length > 0 && (
            <>
              <div className="sec">待接受的邀請</div>
              <div className="card">
                {invitations.map(inv => (
                  <div key={inv.id} className="card-row">
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:14, fontWeight:500 }}>{inv.email}</div>
                      <div style={{ fontSize:11, color:'var(--text-3)', marginTop:2 }}>
                        {ROLE_LABEL[inv.role]}・到期 {new Date(inv.expires_at).toLocaleDateString('zh-TW')}
                      </div>
                    </div>
                    <button onClick={() => cancelInvite(inv.id)}
                      style={{ background:'none', border:'none', color:'var(--text-3)', fontSize:13, cursor:'pointer' }}>
                      取消
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {/* 成員列表 */}
      {(() => {
        const backendUsers = users.filter(u => u.role !== 'consumer')
        const consumers = users.filter(u => u.role === 'consumer')
        return (
          <>
            <div className="sec">後台成員</div>
            {loading ? (
              <div className="empty">載入中…</div>
            ) : backendUsers.length === 0 ? (
              <div className="empty">尚無後台成員</div>
            ) : (
              <div className="card">
                {backendUsers.map(u => (
                  <div key={u.id} className="card-row" style={{ flexDirection:'column', alignItems:'flex-start', gap:8 }}>
                    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', width:'100%' }}>
                      <div>
                        <div style={{ fontWeight:600, fontSize:15 }}>{u.name || '（未命名）'}</div>
                        <div style={{ fontSize:12, color:'var(--text-3)', marginTop:2 }}>{u.email}</div>
                      </div>
                      <span className={`badge ${ROLE_BADGE[u.role] ?? ''}`}>{ROLE_LABEL[u.role] ?? u.role}</span>
                    </div>
                    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', width:'100%' }}>
                      <div style={{ fontSize:11, color:'var(--text-3)' }}>
                        加入於 {new Date(u.created_at).toLocaleDateString('zh-TW')}
                      </div>
                      {u.id === user?.id ? (
                        <span style={{ fontSize:12, color:'var(--text-3)' }}>（目前登入）</span>
                      ) : canChangeRole ? (
                        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                          <CustomSelect compact
                            label={ROLE_LABEL[u.role]}
                            value={u.role}
                            options={[
                              { value: 'viewer', label: '檢視者' },
                              { value: 'editor', label: '編輯者' },
                              { value: 'admin', label: '管理員' },
                              { value: 'super_admin', label: '超級管理員' },
                            ]}
                            onChange={v => v && changeRole(u.id, v)}
                            allowClear={false}
                            style={{ width: 'auto', minWidth: 110 }}
                          />
                          <button onClick={() => removeMember(u)} disabled={saving === u.id}
                            style={{ background:'none', border:'none', color:'var(--red)', fontSize:12, cursor:'pointer', padding:'4px 0' }}>
                            移除
                          </button>
                        </div>
                      ) : (
                        <span style={{ fontSize:12, color:'var(--text-3)' }}>{ROLE_LABEL[u.role]}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 商城消費者（可收合） */}
            {!loading && consumers.length > 0 && (
              <div style={{ marginTop: 20 }}>
                <button
                  onClick={() => setConsumersOpen(v => !v)}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '10px 14px', borderRadius: 10,
                    background: 'var(--bg)', border: '0.5px solid var(--border)',
                    cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--text-3)',
                  }}
                >
                  <span>商城消費者（{consumers.length} 位）</span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                    style={{ transition: 'transform .2s', transform: consumersOpen ? 'rotate(180deg)' : '' }}>
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
                {consumersOpen && (
                  <div className="card" style={{ marginTop: 8 }}>
                    {consumers.map(u => (
                      <div key={u.id} className="card-row" style={{ opacity: 0.7 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 500, fontSize: 14 }}>{u.name || '（未命名）'}</div>
                          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>{u.email}</div>
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                          {new Date(u.created_at).toLocaleDateString('zh-TW')}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )
      })()}
    </div>
  )
}
