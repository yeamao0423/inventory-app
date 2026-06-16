import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'

const BLANK = { name: '', threshold_amount: 0, threshold_orders: 0, discount_percent: '', sort_order: 0, is_default: false }

export default function MemberLevelsPage() {
  const { profile, storeId } = useAuth()
  const [levels, setLevels] = useState([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState(BLANK)
  const [saving, setSaving] = useState(false)
  const [editId, setEditId] = useState(null)
  const [editForm, setEditForm] = useState(BLANK)

  const canAccess = profile?.role === 'super_admin' || profile?.role === 'admin'

  useEffect(() => { if (canAccess && storeId) fetchLevels() }, [canAccess, storeId])

  async function fetchLevels() {
    setLoading(true)
    const { data } = await supabase
      .from('member_levels')
      .select('*')
      .eq('store_id', storeId)
      .order('sort_order', { ascending: true })
    setLevels(data ?? [])
    setLoading(false)
  }

  function toPayload(f) {
    return {
      store_id: storeId,
      name: f.name.trim(),
      threshold_amount: Number(f.threshold_amount) || 0,
      threshold_orders: Number(f.threshold_orders) || 0,
      discount_percent: f.discount_percent === '' || f.discount_percent === null ? null : Number(f.discount_percent),
      sort_order: Number(f.sort_order) || 0,
      is_default: !!f.is_default,
    }
  }

  // 設為預設前，先清掉同店其他預設（每店僅一個 is_default）
  async function clearDefaultExcept(exceptId) {
    let q = supabase.from('member_levels').update({ is_default: false }).eq('store_id', storeId).eq('is_default', true)
    if (exceptId) q = q.neq('id', exceptId)
    await q
  }

  async function addLevel(e) {
    e.preventDefault()
    if (!form.name.trim()) return
    setSaving(true)
    if (form.is_default) await clearDefaultExcept(null)
    const { error } = await supabase.from('member_levels').insert(toPayload(form))
    if (error) alert('新增失敗：' + error.message)
    else { setForm(BLANK); await fetchLevels() }
    setSaving(false)
  }

  function startEdit(lvl) {
    setEditId(lvl.id)
    setEditForm({
      name: lvl.name,
      threshold_amount: lvl.threshold_amount,
      threshold_orders: lvl.threshold_orders,
      discount_percent: lvl.discount_percent ?? '',
      sort_order: lvl.sort_order,
      is_default: lvl.is_default,
    })
  }

  async function saveEdit() {
    setSaving(true)
    if (editForm.is_default) await clearDefaultExcept(editId)
    const { error } = await supabase.from('member_levels').update(toPayload(editForm)).eq('id', editId).eq('store_id', storeId)
    if (error) alert('儲存失敗：' + error.message)
    else { setEditId(null); await fetchLevels() }
    setSaving(false)
  }

  async function delLevel(lvl) {
    if (!confirm(`刪除等級「${lvl.name}」？若有會員使用此等級將無法刪除。`)) return
    const { error } = await supabase.from('member_levels').delete().eq('id', lvl.id).eq('store_id', storeId)
    if (error) alert('刪除失敗（可能仍有會員使用此等級）：' + error.message)
    else fetchLevels()
  }

  if (!canAccess) return (
    <div className="page"><div className="empty" style={{ paddingTop: 80 }}>
      <div style={{ fontSize: 36, marginBottom: 12 }}>🔒</div><div>僅管理員以上可存取此頁面</div>
    </div></div>
  )

  return (
    <div className="page">
      <div className="ph">
        <div>
          <div className="ph-title">會員等級設定</div>
          <div className="ph-sub">{levels.length} 個等級・數字越大等級越高</div>
        </div>
      </div>

      <div className="sec">新增等級</div>
      <div className="card" style={{ padding: 16 }}>
        <form onSubmit={addLevel}>
          <div className="form-group" style={{ marginBottom: 10 }}>
            <label className="form-label">等級名稱</label>
            <input className="form-input" placeholder="例：VIP、黑卡" value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
          </div>
          <LevelFields form={form} setForm={setForm} />
          <button className="btn" type="submit" disabled={saving} style={{ marginTop: 12 }}>
            {saving ? '處理中…' : '新增等級'}
          </button>
        </form>
      </div>

      <div className="sec">等級列表</div>
      {loading ? <div className="empty">載入中…</div>
        : levels.length === 0 ? <div className="empty">尚無等級</div>
        : (
          <div className="card">
            {levels.map(lvl => (
              <div key={lvl.id} className="card-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
                {editId === lvl.id ? (
                  <>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label className="form-label">等級名稱</label>
                      <input className="form-input" value={editForm.name}
                        onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} />
                    </div>
                    <LevelFields form={editForm} setForm={setEditForm} />
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn" onClick={saveEdit} disabled={saving} style={{ width: 'auto', padding: '8px 18px' }}>儲存</button>
                      <button onClick={() => setEditId(null)} style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer' }}>取消</button>
                    </div>
                  </>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 15, display: 'flex', alignItems: 'center', gap: 8 }}>
                        {lvl.name}
                        {lvl.is_default && <span className="badge badge-blue">預設</span>}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 3 }}>
                        門檻 NT${Number(lvl.threshold_amount).toLocaleString()}
                        {lvl.threshold_orders > 0 && ` ・${lvl.threshold_orders} 筆訂單`}
                        {lvl.discount_percent != null && ` ・折扣 ${lvl.discount_percent}%`}
                        {` ・排序 ${lvl.sort_order}`}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 12 }}>
                      <button onClick={() => startEdit(lvl)} style={{ background: 'none', border: 'none', color: 'var(--text-2)', fontSize: 13, cursor: 'pointer' }}>編輯</button>
                      <button onClick={() => delLevel(lvl)} style={{ background: 'none', border: 'none', color: 'var(--red)', fontSize: 13, cursor: 'pointer' }}>刪除</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
    </div>
  )
}

function LevelFields({ form, setForm }) {
  const upd = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))
  return (
    <>
      <div style={{ display: 'flex', gap: 10 }}>
        <div className="form-group" style={{ flex: 1, marginBottom: 10 }}>
          <label className="form-label">達標累積消費額</label>
          <input className="form-input" type="number" min="0" value={form.threshold_amount} onChange={upd('threshold_amount')} />
        </div>
        <div className="form-group" style={{ flex: 1, marginBottom: 10 }}>
          <label className="form-label">達標訂單數（選用）</label>
          <input className="form-input" type="number" min="0" value={form.threshold_orders} onChange={upd('threshold_orders')} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <div className="form-group" style={{ flex: 1, marginBottom: 10 }}>
          <label className="form-label">等級折扣 %（選用）</label>
          <input className="form-input" type="number" min="0" max="100" placeholder="留空=無" value={form.discount_percent} onChange={upd('discount_percent')} />
        </div>
        <div className="form-group" style={{ flex: 1, marginBottom: 10 }}>
          <label className="form-label">排序（越大越高）</label>
          <input className="form-input" type="number" value={form.sort_order} onChange={upd('sort_order')} />
        </div>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-2)', cursor: 'pointer' }}>
        <input type="checkbox" checked={!!form.is_default} onChange={e => setForm(f => ({ ...f, is_default: e.target.checked }))} />
        設為預設等級（新會員與未達標者）
      </label>
    </>
  )
}
