import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'

// 平台管理頁：僅 platform_admins 可見（App.jsx 控制分頁顯示）
// 功能：商家列表、建立商店＋產生店主邀請連結、停權／啟用
export default function PlatformPage() {
  const { user, isPlatformAdmin } = useAuth()
  const [stores, setStores] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(null)
  const [domainDraft, setDomainDraft] = useState({})   // { [storeId]: 編輯中的自訂網域 }

  // create form
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [ownerEmail, setOwnerEmail] = useState('')
  const [creating, setCreating] = useState(false)
  const [inviteLink, setInviteLink] = useState('')
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { if (isPlatformAdmin) fetchStores() }, [isPlatformAdmin])

  async function fetchStores() {
    setLoading(true)
    const { data: storeRows } = await supabase
      .from('stores')
      .select('id, name, slug, custom_domain, is_active, created_at')
      .order('id', { ascending: true })

    const rows = storeRows ?? []
    // 每家店的訂單／商品數（head count，不抓資料）
    const counts = await Promise.all(rows.map(async s => {
      const [{ count: orderCount }, { count: productCount }] = await Promise.all([
        supabase.from('consumer_orders').select('id', { count: 'exact', head: true }).eq('store_id', s.id),
        supabase.from('products').select('id', { count: 'exact', head: true }).eq('store_id', s.id),
      ])
      return { ...s, orderCount: orderCount ?? 0, productCount: productCount ?? 0 }
    }))
    setStores(counts)
    setDomainDraft(Object.fromEntries(counts.map(s => [s.id, s.custom_domain || ''])))
    setLoading(false)
  }

  async function saveDomain(s) {
    const v = (domainDraft[s.id] ?? '').trim().toLowerCase()
    // 允許留空（清除）；否則需像 daigoking.com 的網域格式
    if (v && !/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(v)) {
      return alert('網域格式不正確，例如 daigoking.com')
    }
    setSaving(s.id)
    const { error } = await supabase.from('stores').update({ custom_domain: v || null }).eq('id', s.id)
    if (error) {
      alert(error.code === '23505' || error.message.includes('duplicate')
        ? '此網域已被其他商店使用' : '儲存失敗：' + error.message)
    } else {
      setStores(prev => prev.map(x => x.id === s.id ? { ...x, custom_domain: v || null } : x))
    }
    setSaving(null)
  }

  async function createStore(e) {
    e.preventDefault()
    setError(''); setInviteLink('')

    const slugTrim = slug.trim().toLowerCase()
    if (!/^[a-z0-9-]{2,30}$/.test(slugTrim)) {
      return setError('網址代號限 2-30 個小寫英數字與連字號（-）')
    }

    setCreating(true)
    const { data: newStore, error: storeErr } = await supabase
      .from('stores')
      .insert({ name: name.trim(), slug: slugTrim })
      .select('id')
      .single()

    if (storeErr) {
      setError(storeErr.message.includes('duplicate') ? '此網址代號已被使用' : '建立失敗：' + storeErr.message)
      setCreating(false)
      return
    }

    const { data: inv, error: invErr } = await supabase
      .from('invitations')
      .insert({ email: ownerEmail.trim(), role: 'super_admin', store_id: newStore.id, invited_by: user.id })
      .select('token')
      .single()

    if (invErr) {
      setError('商店已建立，但店主邀請產生失敗：' + invErr.message)
    } else {
      setInviteLink(`${window.location.origin}/invite?token=${inv.token}`)
      setName(''); setSlug(''); setOwnerEmail('')
    }
    setCreating(false)
    fetchStores()
  }

  async function toggleActive(s) {
    if (!s.is_active && !confirm(`確定重新啟用「${s.name}」？`)) return
    if (s.is_active && !confirm(`確定停權「${s.name}」？停權後該店商城將無法下單。`)) return
    setSaving(s.id)
    const { error } = await supabase.from('stores').update({ is_active: !s.is_active }).eq('id', s.id)
    if (!error) setStores(prev => prev.map(x => x.id === s.id ? { ...x, is_active: !s.is_active } : x))
    else alert('操作失敗：' + error.message)
    setSaving(null)
  }

  function copyLink() {
    navigator.clipboard.writeText(inviteLink)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (!isPlatformAdmin) return (
    <div className="page">
      <div className="empty" style={{ paddingTop: 80 }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>🔒</div>
        <div>僅平台管理員可存取此頁面</div>
      </div>
    </div>
  )

  return (
    <div className="page">
      <div className="ph">
        <div>
          <div className="ph-title">平台管理</div>
          <div className="ph-sub">{stores.length} 家商店</div>
        </div>
      </div>

      {/* 建立商店 */}
      <div className="sec">建立新商店</div>
      <div className="card" style={{ padding: '16px' }}>
        <form onSubmit={createStore}>
          <div className="form-group" style={{ marginBottom: 10 }}>
            <label className="form-label">商店名稱</label>
            <input className="form-input" type="text" placeholder="例：Daigogo"
              value={name} onChange={e => setName(e.target.value)} required />
          </div>
          <div className="form-group" style={{ marginBottom: 10 }}>
            <label className="form-label">網址代號（slug）</label>
            <input className="form-input" type="text" placeholder="例：daigogo（小寫英數字與 -）"
              value={slug} onChange={e => setSlug(e.target.value)} required autoCapitalize="none" />
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <label className="form-label">店主 Email</label>
              <input className="form-input" type="email" placeholder="owner@email.com"
                value={ownerEmail} onChange={e => setOwnerEmail(e.target.value)} required />
            </div>
            <button className="btn" type="submit" disabled={creating}
              style={{ width: 'auto', padding: '11px 20px', fontSize: 14, whiteSpace: 'nowrap' }}>
              {creating ? '建立中…' : '建立並邀請店主'}
            </button>
          </div>
        </form>

        {error && <div className="error-msg" style={{ marginTop: 12 }}>{error}</div>}

        {inviteLink && (
          <div style={{ marginTop: 14, background: 'var(--bg)', borderRadius: 10, padding: '10px 12px' }}>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 6 }}>店主邀請連結（有效 7 天，請傳給對方）</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div style={{ fontSize: 12, color: 'var(--text-2)', wordBreak: 'break-all', flex: 1 }}>
                {inviteLink}
              </div>
              <button onClick={copyLink} className="btn"
                style={{ width: 'auto', padding: '6px 14px', fontSize: 13, flexShrink: 0 }}>
                {copied ? '已複製' : '複製'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 商店列表 */}
      <div className="sec">商店列表</div>
      {loading ? (
        <div className="empty">載入中…</div>
      ) : (
        <div className="card">
          {stores.map(s => (
            <div key={s.id} className="card-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>
                    {s.name}
                    <span style={{ fontSize: 12, color: 'var(--text-3)', fontWeight: 400, marginLeft: 8 }}>/{s.slug || '—'}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
                    {s.productCount} 件商品・{s.orderCount} 筆訂單・建立於 {new Date(s.created_at).toLocaleDateString('zh-TW')}
                  </div>
                </div>
                <span className={`badge ${s.is_active ? 'badge-ok' : 'badge-low'}`}>
                  {s.is_active ? '營運中' : '已停權'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, width: '100%', alignItems: 'center' }}>
                <input
                  className="form-input"
                  placeholder="自訂網域（例：daigoking.com，留空＝未設定）"
                  value={domainDraft[s.id] ?? ''}
                  onChange={e => setDomainDraft(d => ({ ...d, [s.id]: e.target.value }))}
                  autoCapitalize="none"
                  style={{ flex: 1, padding: '8px 12px', fontSize: 13 }}
                />
                <button
                  className="btn"
                  disabled={saving === s.id || (domainDraft[s.id] ?? '') === (s.custom_domain ?? '')}
                  onClick={() => saveDomain(s)}
                  style={{ width: 'auto', padding: '8px 14px', fontSize: 13, whiteSpace: 'nowrap' }}
                >
                  儲存網域
                </button>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', width: '100%' }}>
                <button onClick={() => toggleActive(s)} disabled={saving === s.id}
                  style={{
                    background: 'none', border: '1px solid var(--border)', borderRadius: 8,
                    padding: '5px 14px', fontSize: 12, cursor: 'pointer',
                    color: s.is_active ? 'var(--red)' : 'var(--green)',
                  }}>
                  {s.is_active ? '停權' : '啟用'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
