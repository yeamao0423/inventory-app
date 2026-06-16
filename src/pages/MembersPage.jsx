import { useEffect, useState, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import CustomSelect from '../components/CustomSelect'
import { mapShoplineRows } from '../lib/memberImport'

export default function MembersPage() {
  const { profile, storeId } = useAuth()
  const [members, setMembers] = useState([])
  const [levels, setLevels] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')
  const [filterLevel, setFilterLevel] = useState(null)
  const [preview, setPreview] = useState(null)   // { rows, total, imported, skipped }
  const [importing, setImporting] = useState(false)

  const isAdmin = profile?.role === 'super_admin' || profile?.role === 'admin'
  const canAccess = isAdmin || profile?.role === 'editor' || profile?.role === 'viewer'

  useEffect(() => { if (canAccess && storeId) { fetchLevels(); fetchMembers() } }, [canAccess, storeId])

  async function fetchLevels() {
    const { data } = await supabase.from('member_levels').select('id, name').eq('store_id', storeId).order('sort_order')
    setLevels(data ?? [])
  }

  async function fetchMembers() {
    setLoading(true)
    const { data, error } = await supabase.rpc('list_members', { p_store_id: storeId })
    if (error) console.error('list_members', error)
    setMembers(data ?? [])
    setLoading(false)
  }

  const levelOptions = useMemo(() => levels.map(l => ({ value: l.id, label: l.name })), [levels])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return members.filter(m => {
      if (filterLevel && m.level_id !== filterLevel) return false
      if (!q) return true
      return (m.email || '').toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q)
    })
  }, [members, search, filterLevel])

  async function upgrade(row, levelId) {
    if (!levelId) return
    setBusy(true)
    const params = { p_store_id: storeId, p_level_id: levelId }
    if (row.kind === 'registered') params.p_consumer_id = row.ref_id
    else params.p_imported_id = Number(row.ref_id)
    const { error } = await supabase.rpc('set_member_level', params)
    if (error) alert('升級失敗：' + error.message)
    else await fetchMembers()
    setBusy(false)
  }

  async function recomputeAll() {
    if (!confirm('重算全店已註冊會員等級？（已手動鎖定者不受影響）')) return
    setBusy(true)
    const { error } = await supabase.rpc('recalc_member_level', { p_store_id: storeId, p_email: null })
    if (error) alert('重算失敗：' + error.message)
    else await fetchMembers()
    setBusy(false)
  }

  async function handleFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const text = await file.text()
    try {
      setPreview(mapShoplineRows(text))
    } catch (err) {
      alert('解析失敗：' + err.message)
    }
  }

  async function doImport() {
    if (!preview?.rows?.length) return
    setImporting(true)
    const { data, error } = await supabase.rpc('import_members', { p_store_id: storeId, p_rows: preview.rows })
    if (error) alert('匯入失敗：' + error.message)
    else {
      alert(`匯入完成：處理 ${data?.processed ?? preview.rows.length} 筆`)
      setPreview(null)
      await fetchMembers()
    }
    setImporting(false)
  }

  if (!canAccess) return (
    <div className="page"><div className="empty" style={{ paddingTop: 80 }}>
      <div style={{ fontSize: 36, marginBottom: 12 }}>🔒</div><div>無權限存取此頁面</div>
    </div></div>
  )

  const registeredCount = members.filter(m => m.kind === 'registered').length
  const importedCount = members.filter(m => m.kind === 'imported').length

  return (
    <div className="page">
      <div className="ph">
        <div>
          <div className="ph-title">會員管理</div>
          <div className="ph-sub">已註冊 {registeredCount}・未註冊匯入 {importedCount}</div>
        </div>
        {isAdmin && (
          <button className="btn" onClick={recomputeAll} disabled={busy}
            style={{ width: 'auto', padding: '9px 16px', fontSize: 13 }}>整店重算</button>
        )}
      </div>

      {/* CSV 匯入（admin） */}
      {isAdmin && (
        <>
          <div className="sec">匯入會員（Shopline CSV）</div>
          <div className="card" style={{ padding: 16 }}>
            <label className="btn" style={{ width: 'auto', display: 'inline-block', padding: '9px 16px', fontSize: 13, cursor: 'pointer' }}>
              選擇 CSV 檔
              <input type="file" accept=".csv,text/csv" onChange={handleFile} style={{ display: 'none' }} />
            </label>
            {preview && (
              <div style={{ marginTop: 14, background: 'var(--bg)', borderRadius: 10, padding: '12px 14px' }}>
                <div style={{ fontSize: 13, marginBottom: 8 }}>
                  共 {preview.total} 列・將匯入 <b>{preview.imported}</b> 筆會員・略過 {preview.skipped} 筆（非會員/無 email）
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn" onClick={doImport} disabled={importing || preview.imported === 0}
                    style={{ width: 'auto', padding: '8px 18px', fontSize: 13 }}>
                    {importing ? '匯入中…' : `確認匯入 ${preview.imported} 筆`}
                  </button>
                  <button onClick={() => setPreview(null)} style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer' }}>取消</button>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* 篩選 */}
      <div className="sec">會員列表</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <input className="form-input" placeholder="搜尋 email / 姓名" value={search}
          onChange={e => setSearch(e.target.value)} style={{ flex: 1 }} />
        <CustomSelect compact label="所有等級" value={filterLevel} options={levelOptions}
          onChange={setFilterLevel} style={{ minWidth: 120 }} />
      </div>

      {loading ? <div className="empty">載入中…</div>
        : filtered.length === 0 ? <div className="empty">無符合的會員</div>
        : (
          // overflow:visible 讓「手動升級」下拉選單不被卡片邊界裁切（搜尋後只剩一列時尤明顯）
          <div className="card" style={{ overflow: 'visible' }}>
            {filtered.map(m => (
              <div key={`${m.kind}-${m.ref_id}`} className="card-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name || '（未命名）'}</span>
                      {m.kind === 'imported'
                        ? <span className="badge">{m.source}</span>
                        : <span className="badge badge-ok">已註冊</span>}
                      {m.level_locked && <span className="badge badge-warn">鎖定</span>}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.email}</div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 12 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{m.level_name || '—'}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-3)' }}>NT${Number(m.qualifying_amount || 0).toLocaleString()}</div>
                  </div>
                </div>
                {isAdmin && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                      {m.registered_at ? `註冊 ${new Date(m.registered_at).toLocaleDateString('zh-TW')}` : ''}
                    </span>
                    <CustomSelect compact label="手動升級…" value={null} options={levelOptions}
                      onChange={v => upgrade(m, v)} allowClear={false} style={{ minWidth: 120 }} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
    </div>
  )
}
