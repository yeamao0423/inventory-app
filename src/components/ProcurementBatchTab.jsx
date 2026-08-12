import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { getCurrencySymbol } from '../constants/currency'
import { useAuth } from '../hooks/useAuth'
import CustomSelect from './CustomSelect'

// 取得 store 管理員（profiles + user_store_roles，排除一般消費者）
export async function fetchStoreMembers(storeId) {
  const { data: roles } = await supabase
    .from('user_store_roles')
    .select('user_id, role')
    .eq('store_id', storeId)
    .in('role', ['super_admin', 'admin', 'editor'])
  if (!roles || roles.length === 0) return []
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, name, email')
    .in('id', roles.map(r => r.user_id))
  const roleMap = Object.fromEntries(roles.map(r => [r.user_id, r.role]))
  return (profiles || []).map(p => ({
    id: p.id,
    name: p.name,
    email: p.email,
    role: roleMap[p.id],
  }))
}

export default function ProcurementBatchTab() {
  const { storeId } = useAuth()
  const [batches, setBatches] = useState([])
  const [members, setMembers] = useState([])
  const [tripMap, setTripMap] = useState({})
  const [rates, setRates] = useState({})
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('unsettled') // 'unsettled' | 'settled' | 'all'
  const [sheet, setSheet] = useState(null) // null | batch object
  const [showExport, setShowExport] = useState(false)
  const [page, setPage] = useState(1)
  const PAGE_SIZE = 10

  useEffect(() => {
    if (!storeId) return
    fetchAll()
  }, [storeId])

  async function fetchAll(silent = false) {
    if (!silent) setLoading(true)
    const [b, m, { data: r }, { data: t }] = await Promise.all([
      supabase.from('procurement_batches').select('*, procurement_items(*, products:product_id(name, sku), variants:variant_id(options))').eq('store_id', storeId).order('created_at', { ascending: false }),
      fetchStoreMembers(storeId),
      supabase.from('exchange_rates').select('*'),
      supabase.from('trips').select('id, destination').eq('store_id', storeId),
    ])
    setBatches(b.data || [])
    setMembers(m)
    const tm = {}
    ;(t || []).forEach(x => { tm[x.id] = x.destination })
    setTripMap(tm)
    const rm = {}
    ;(r || []).forEach(x => { rm[x.currency] = Number(x.rate) })
    setRates(rm)
    setLoading(false)
  }

  const memberMap = {}
  members.forEach(m => { memberMap[m.id] = m })

  // 跨批次未結清墊付計算
  const unsettledSummary = {}
  batches.filter(b => b.status !== 'settled').forEach(batch => {
    ;(batch.procurement_items || []).forEach(item => {
      if (item.status === 'pending' || item.status === 'missed') return
      const payerId = item.paid_by || batch.buyer_id
      if (!payerId) return
      const qty = item.actual_qty ?? item.quantity
      const cost = (Number(item.unit_cost) || 0) * qty
      const cur = item.currency || 'TWD'
      const costTWD = cur === 'TWD' ? cost : cost * (rates[cur] || 0)
      if (!unsettledSummary[payerId]) unsettledSummary[payerId] = { totalTWD: 0, batchCount: new Set() }
      unsettledSummary[payerId].totalTWD += costTWD
      unsettledSummary[payerId].batchCount.add(batch.id)
    })
  })

  const filtered = batches.filter(b => {
    if (filter === 'unsettled') return b.status !== 'settled'
    if (filter === 'settled') return b.status === 'settled'
    return true
  })

  function statusLabel(s) {
    if (s === 'settled') return { text: '已結清', color: 'var(--green)' }
    return { text: '未結清', color: 'var(--amber)' }
  }

  if (loading) return <div className="empty">載入中…</div>

  // 分頁
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pagedBatches = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  return (
    <>
      {/* 篩選 + 匯出 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, justifyContent: 'flex-end' }}>
        <button
          onClick={() => setShowExport(true)}
          style={{
            padding: '6px 12px', borderRadius: 20, border: '1px solid var(--border)',
            background: 'var(--card)', color: 'var(--text)',
            fontSize: 12, fontWeight: 600, cursor: 'pointer', marginRight: 'auto',
          }}
        >匯出 CSV</button>
        {[
          { key: 'unsettled', label: '未結清' },
          { key: 'settled', label: '已結清' },
          { key: 'all', label: '全部' },
        ].map(f => (
          <button
            key={f.key}
            onClick={() => { setFilter(f.key); setPage(1) }}
            style={{
              padding: '6px 12px', borderRadius: 20, border: '1px solid var(--border)',
              background: filter === f.key ? 'var(--text)' : 'var(--card)',
              color: filter === f.key ? '#fff' : 'var(--text-2)',
              fontSize: 12, fontWeight: filter === f.key ? 700 : 400, cursor: 'pointer',
            }}
          >{f.label}</button>
        ))}
      </div>

      {/* 未結清墊付總覽 */}
      {Object.keys(unsettledSummary).length > 0 && filter !== 'settled' && (
        <div className="card" style={{ marginBottom: 16, padding: '14px 16px' }}>
          <div className="fw600 fs13" style={{ marginBottom: 10 }}>未結清墊付總覽</div>
          {Object.entries(unsettledSummary).map(([payerId, data]) => (
            <div key={payerId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0' }}>
              <span className="fs13">{memberMap[payerId]?.name || '未知'}</span>
              <span className="fw600 fs13">
                NT${Math.round(data.totalTWD).toLocaleString()}
                <span className="muted fs12" style={{ marginLeft: 6 }}>({data.batchCount.size} 批次)</span>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 批次列表 */}
      {filtered.length === 0 && <div className="empty">沒有採購批次</div>}
      {filtered.length > 0 && (
        <div className="muted fs12" style={{ marginBottom: 8 }}>
          共 {filtered.length} 筆，第 {safePage}/{totalPages} 頁
        </div>
      )}
      {pagedBatches.map(batch => {
        const items = batch.procurement_items || []
        const st = statusLabel(batch.status)
        const itemCount = items.length
        let totalCost = 0
        items.forEach(item => {
          if (item.status === 'missed') return
          const qty = item.actual_qty ?? item.quantity
          totalCost += (Number(item.unit_cost) || 0) * qty
        })
        const cur = items[0]?.currency || 'TWD'
        const symbol = getCurrencySymbol(cur)

        return (
          <div key={batch.id} className="card" style={{ marginBottom: 8, cursor: 'pointer' }} onClick={() => setSheet(batch)}>
            <div className="card-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row-sb">
                  <span className="fw600 fs14">#{batch.id} · {batch.source || '手動建立'}</span>
                  <span style={{ fontSize: 12, padding: '2px 10px', borderRadius: 12, background: st.color + '18', color: st.color, fontWeight: 600 }}>
                    {st.text}
                  </span>
                </div>
                <div className="muted fs12 mt8">
                  {batch.batch_date} · {itemCount} 品項
                  {totalCost > 0 && ` · ${symbol}${Math.round(totalCost).toLocaleString()}`}
                </div>
                <div className="muted fs12">
                  負責人: {memberMap[batch.manager_id]?.name || '未指定'}
                  {' · '}付款人: {memberMap[batch.buyer_id]?.name || '未指定'}
                </div>
                <div className="muted fs12">
                  行程: {tripMap[batch.trip_id] || '未掛行程'}
                </div>
                {batch.inventory_synced && (
                  <span style={{ fontSize: 11, color: 'var(--green)', marginTop: 2, display: 'inline-block' }}>已入庫</span>
                )}
              </div>
            </div>
          </div>
        )
      })}

      {/* 分頁 */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 16 }}>
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={safePage === 1}
            style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', cursor: safePage === 1 ? 'default' : 'pointer', opacity: safePage === 1 ? 0.4 : 1 }}
          >‹</button>
          {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
            <button
              key={p}
              onClick={() => setPage(p)}
              style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)', background: p === safePage ? 'var(--text)' : 'var(--bg)', color: p === safePage ? '#fff' : 'var(--text)', cursor: 'pointer', fontWeight: p === safePage ? 700 : 400, minWidth: 36 }}
            >{p}</button>
          ))}
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={safePage === totalPages}
            style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', cursor: safePage === totalPages ? 'default' : 'pointer', opacity: safePage === totalPages ? 0.4 : 1 }}
          >›</button>
        </div>
      )}

      {/* 匯出 Sheet */}
      {showExport && (
        <ExportBatchSheet
          batches={batches}
          memberMap={memberMap}
          onClose={() => setShowExport(false)}
        />
      )}

      {/* Sheets */}
      {sheet && typeof sheet === 'object' && (
        <BatchDetailSheet
          batch={sheet}
          members={members}
          memberMap={memberMap}
          rates={rates}
          onClose={() => setSheet(null)}
          onSaved={fetchAll}
        />
      )}
    </>
  )
}

/* ─── 批次詳情 Sheet ──────────────────────── */
function BatchDetailSheet({ batch, members, memberMap, rates, onClose, onSaved }) {
  const { storeId } = useAuth()
  const [items, setItems] = useState(
    (batch.procurement_items || []).map(item => ({ ...item }))
  )
  const [saving, setSaving] = useState(false)
  const [showSyncSheet, setShowSyncSheet] = useState(false)
  const [trips, setTrips] = useState([])
  const [tripId, setTripId] = useState(batch.trip_id || null)
  const [savingTrip, setSavingTrip] = useState(false)

  useEffect(() => {
    if (!storeId) return
    supabase.from('trips').select('id, destination, depart_date, return_date')
      .eq('store_id', storeId).order('depart_date', { ascending: false })
      .then(({ data }) => setTrips(data || []))
  }, [storeId])

  // 掛行程改了就即時存，不跟品項的儲存綁在一起
  async function changeTrip(v) {
    const next = v || null
    setTripId(next)
    setSavingTrip(true)
    const { error } = await supabase.from('procurement_batches').update({ trip_id: next }).eq('id', batch.id)
    setSavingTrip(false)
    if (error) {
      setTripId(batch.trip_id || null)
      alert('掛行程失敗：' + error.message)
      return
    }
    onSaved(true)
  }

  // 計算結算摘要（按付款人）
  const settlement = {}
  items.forEach(item => {
    if (item.status === 'pending' || item.status === 'missed') return
    const payerId = item.paid_by || batch.buyer_id
    if (!payerId) return
    const qty = item.actual_qty ?? item.quantity
    const cost = (Number(item.unit_cost) || 0) * qty
    const cur = item.currency || 'TWD'
    const costTWD = cur === 'TWD' ? cost : cost * (rates[cur] || 0)
    if (!settlement[payerId]) settlement[payerId] = { items: [], total: 0, totalTWD: 0 }
    settlement[payerId].items.push(item)
    settlement[payerId].total += cost
    settlement[payerId].totalTWD += costTWD
  })

  const currencySymbol = getCurrencySymbol

  function updateItem(idx, updates) {
    setItems(prev => prev.map((item, i) => {
      if (i !== idx) return item
      const updated = { ...item, ...updates }
      if ('actual_qty' in updates) {
        const aq = updates.actual_qty
        if (aq === null || aq === '') {
          updated.status = 'pending'
          updated.actual_qty = null
        } else if (Number(aq) === 0) {
          updated.status = 'missed'
          updated.actual_qty = 0
        } else if (Number(aq) >= item.quantity) {
          updated.status = 'bought'
          updated.actual_qty = Number(aq)
        } else {
          updated.status = 'partial'
          updated.actual_qty = Number(aq)
        }
      }
      return updated
    }))
  }

  async function save() {
    setSaving(true)
    for (const item of items) {
      await supabase.from('procurement_items').update({
        actual_qty: item.actual_qty,
        unit_cost: item.unit_cost,
        paid_by: item.paid_by,
        status: item.status,
        note: item.note,
      }).eq('id', item.id)
    }
    setSaving(false)
    onSaved()
    onClose()
  }

  async function settle() {
    if (!window.confirm('確定標記此批次為「已結清」？')) return
    await supabase.from('procurement_batches').update({ status: 'settled' }).eq('id', batch.id)
    onSaved()
    onClose()
  }

  async function deleteBatch() {
    const synced = batch.inventory_synced
    const msg = synced
      ? '這個批次已經入庫過。取消批次會把已入庫的數量從庫存扣回去，確定嗎？'
      : '確定取消此批次？品項將回到採購彙整。'
    if (!window.confirm(msg)) return
    const { data, error } = await supabase.rpc('delete_batch', { p_batch_id: batch.id })
    if (error) return alert('取消失敗：' + error.message)
    if (data?.ok === false) return alert('取消失敗：' + data.error)
    onSaved()
    onClose()
  }

  const isSettled = batch.status === 'settled'

  return (
    <Sheet title={`批次 #${batch.id} — ${batch.source || '手動建立'}`} onClose={onClose}>
      {/* 批次資訊 */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-row row-sb">
          <span className="muted fs13">日期</span>
          <span className="fs13">{batch.batch_date}</span>
        </div>
        <div className="card-row row-sb">
          <span className="muted fs13">負責人</span>
          <span className="fs13">{memberMap[batch.manager_id]?.name || '未指定'}</span>
        </div>
        <div className="card-row row-sb">
          <span className="muted fs13">付款人</span>
          <span className="fs13">{memberMap[batch.buyer_id]?.name || '未指定'}</span>
        </div>
        <div className="card-row row-sb">
          <span className="muted fs13">狀態</span>
          <span className="fs13" style={{ color: isSettled ? 'var(--green)' : 'var(--amber)', fontWeight: 600 }}>
            {isSettled ? '已結清' : '未結清'}
          </span>
        </div>
        <div className="card-row row-sb">
          <span className="muted fs13">掛行程{savingTrip && ' …'}</span>
          <div style={{ minWidth: 190 }}>
            <CustomSelect
              label="不掛行程"
              value={tripId}
              options={trips.map(t => ({ value: t.id, label: `${t.destination}（${t.depart_date} ~ ${t.return_date}）` }))}
              onChange={changeTrip}
            />
          </div>
        </div>
        {isSettled && (
          <div className="card-row">
            <span className="muted fs12">
              此批次已結清，掛上行程只會計入該趟的進貨成本，不會再列入拆賬的代墊返還。
            </span>
          </div>
        )}
        {batch.note && (
          <div className="card-row"><span className="muted fs13">備註：{batch.note}</span></div>
        )}
      </div>

      {/* 品項列表 */}
      <div className="sec" style={{ marginTop: 0 }}>
        採購品項（{items.length}）
      </div>
      {items.map((item, idx) => {
        const productName = item.products?.name || `商品 #${item.product_id}`
        const variantLabel = item.variants?.options
          ? Object.values(item.variants.options).join(' / ')
          : ''
        const cur = item.currency || 'TWD'
        const sym = currencySymbol(cur)
        const itemStatusIcon = item.status === 'bought' ? '✅'
          : item.status === 'partial' ? '⚠️'
          : item.status === 'missed' ? '❌'
          : '⬜'

        return (
          <div key={item.id} className="card" style={{
            marginBottom: 6,
            opacity: item.status === 'missed' ? 0.5 : 1,
          }}>
            <div className="card-row" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* 品名 + 狀態 */}
              <div className="row-sb" style={{ width: '100%' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="fw600 fs14">{itemStatusIcon} {productName}</div>
                  {variantLabel && <div className="muted fs12">{variantLabel}</div>}
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div className="fs13">預計: {item.quantity} 件</div>
                  <div className="muted fs12">{sym}{Number(item.unit_cost || 0).toLocaleString()}/件</div>
                </div>
              </div>

              {/* 編輯區 */}
              {!isSettled && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, alignItems: 'end' }}>
                  <div>
                    <span className="muted fs12">實際數量</span>
                    <input
                      type="number"
                      min={0}
                      max={999}
                      value={item.actual_qty ?? ''}
                      placeholder="-"
                      onChange={e => updateItem(idx, { actual_qty: e.target.value === '' ? null : e.target.value })}
                      style={{
                        width: '100%', padding: '6px 8px', borderRadius: 8, marginTop: 4,
                        border: '1px solid var(--border)', fontSize: 13, textAlign: 'center',
                        background: 'var(--card)', color: 'var(--text)', boxSizing: 'border-box',
                      }}
                    />
                  </div>
                  <div>
                    <span className="muted fs12">單價 ({sym})</span>
                    <input
                      type="number"
                      value={item.unit_cost ?? ''}
                      onChange={e => updateItem(idx, { unit_cost: e.target.value })}
                      style={{
                        width: '100%', padding: '6px 8px', borderRadius: 8, marginTop: 4,
                        border: '1px solid var(--border)', fontSize: 13, textAlign: 'center',
                        background: 'var(--card)', color: 'var(--text)', boxSizing: 'border-box',
                      }}
                    />
                  </div>
                  <div>
                    <span className="muted fs12">付款人</span>
                    <div style={{ marginTop: 4 }}>
                      <CustomSelect
                        label={memberMap[item.paid_by || batch.buyer_id]?.name || '選擇'}
                        value={item.paid_by || batch.buyer_id}
                        options={members.map(m => ({ value: m.id, label: m.name }))}
                        onChange={v => updateItem(idx, { paid_by: v })}
                        allowClear={false}
                        compact
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* 唯讀模式 */}
              {isSettled && (
                <div className="muted fs12">
                  實際: {item.actual_qty ?? '-'} 件 · 付款人: {memberMap[item.paid_by || batch.buyer_id]?.name || '未指定'}
                </div>
              )}
            </div>
          </div>
        )
      })}

      {/* 結算摘要 */}
      {Object.keys(settlement).length > 0 && (
        <>
          <div className="sec">結算摘要</div>
          <div className="card" style={{ marginBottom: 16 }}>
            {Object.entries(settlement).map(([payerId, data]) => {
              const cur = data.items[0]?.currency || 'TWD'
              const sym = currencySymbol(cur)
              const showConvert = cur !== 'TWD'
              return (
                <div key={payerId} className="card-row row-sb">
                  <span className="fw600 fs13">{memberMap[payerId]?.name || '未知'}</span>
                  <div style={{ textAlign: 'right' }}>
                    <div className="fw600 fs13">{sym}{Math.round(data.total).toLocaleString()}</div>
                    {showConvert && <div className="muted fs12">≈ NT${Math.round(data.totalTWD).toLocaleString()}</div>}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* 操作按鈕 */}
      {!isSettled && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button className="btn" onClick={save} disabled={saving}>
            {saving ? '儲存中…' : '儲存'}
          </button>
          {!batch.inventory_synced && (
            <button
              onClick={() => setShowSyncSheet(true)}
              style={{
                width: '100%', padding: '12px 0', borderRadius: 12,
                border: '1px solid var(--blue, #3b82f6)', background: 'none',
                color: 'var(--blue, #3b82f6)', fontSize: 14, fontWeight: 600, cursor: 'pointer',
              }}
            >
              同步庫存入庫
            </button>
          )}
          {batch.inventory_synced && (
            <div style={{ textAlign: 'center', fontSize: 13, color: 'var(--green)', padding: 8 }}>
              已同步庫存入庫
            </div>
          )}
          <button
            onClick={settle}
            style={{
              width: '100%', padding: '12px 0', borderRadius: 12,
              border: 'none', background: 'var(--green)', color: '#fff',
              fontSize: 14, fontWeight: 600, cursor: 'pointer',
            }}
          >
            標記已結清
          </button>
          <button
            onClick={deleteBatch}
            style={{
              width: '100%', padding: '10px 0', borderRadius: 12, marginTop: 4,
              border: 'none', background: 'none',
              color: 'var(--red, #ef4444)', fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}
          >
            取消此批次
          </button>
        </div>
      )}

      {/* 庫存同步確認 Sheet */}
      {showSyncSheet && (
        <InventorySyncSheet
          batch={batch}
          items={items}
          onClose={() => setShowSyncSheet(false)}
          onSaved={() => { setShowSyncSheet(false); onSaved(); onClose() }}
        />
      )}
    </Sheet>
  )
}

/* ─── 庫存同步確認 Sheet ──────────────────────── */
function InventorySyncSheet({ batch, items, onClose, onSaved }) {
  const syncableItems = items.filter(i => i.status === 'bought' || i.status === 'partial')
  const [syncing, setSyncing] = useState(false)

  const totalQty = syncableItems.reduce((s, i) => s + (i.actual_qty || 0), 0)

  // 入庫改由 DB 端的 receive_batch_inventory 一次做完：庫存加減、history、
  // inventory_synced 標記都在同一個交易內，連點也只會加一次。
  async function syncInventory() {
    if (syncableItems.length === 0) return
    setSyncing(true)
    const { data, error } = await supabase.rpc('receive_batch_inventory', { p_batch_id: batch.id })
    setSyncing(false)
    if (error) return alert('入庫失敗：' + error.message)
    if (data?.already_synced) return alert('這個批次已經入庫過了')
    onSaved()
  }

  return (
    <div className="sheet-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <div className="sheet-handle" />
        <div className="row-sb" style={{ marginBottom: 20 }}>
          <div className="sheet-title" style={{ margin: 0 }}>確認入庫品項</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-3)' }}>×</button>
        </div>

        <div className="muted fs12" style={{ marginBottom: 12 }}>整批一起入庫，數量以「實際數量」為準</div>

        {syncableItems.length === 0 ? (
          <div className="empty">沒有可入庫的品項</div>
        ) : (
          <>
            {syncableItems.map(item => {
              const productName = item.products?.name || `商品 #${item.product_id}`
              return (
                <div key={item.id} className="card" style={{ marginBottom: 6 }}>
                  <div className="card-row row-sb">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 18 }}>☑</span>
                      <div>
                        <div className="fs13 fw600">{productName}</div>
                        {item.status === 'partial' && <div className="muted fs12">部分到貨</div>}
                      </div>
                    </div>
                    <span className="fw600 fs14" style={{ color: 'var(--green)' }}>+{item.actual_qty} 件</span>
                  </div>
                </div>
              )
            })}

            <div className="card" style={{ marginBottom: 16, marginTop: 12 }}>
              <div className="card-row row-sb">
                <span className="muted fs13">入庫品項</span>
                <span className="fs13">{syncableItems.length} 品項</span>
              </div>
              <div className="card-row row-sb">
                <span className="muted fs13">合計入庫</span>
                <span className="fw600 fs14" style={{ color: 'var(--green)' }}>+{totalQty} 件</span>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={onClose}
                style={{
                  flex: 1, padding: '12px 0', borderRadius: 12,
                  border: '1px solid var(--border)', background: 'var(--card)',
                  color: 'var(--text)', fontSize: 14, fontWeight: 600, cursor: 'pointer',
                }}
              >取消</button>
              <button
                onClick={syncInventory}
                disabled={syncing || syncableItems.length === 0}
                style={{
                  flex: 1, padding: '12px 0', borderRadius: 12,
                  border: 'none', background: syncableItems.length > 0 ? 'var(--green)' : 'var(--border)',
                  color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer',
                }}
              >
                {syncing ? '入庫中…' : '確認入庫'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/* ─── 建立批次 Sheet（從採購彙整呼叫） ──────── */
// 將品項展開為規格層級的行
function expandItemsToRows(items) {
  const rows = []
  items.forEach(item => {
    const hasVariants = Object.keys(item.variants).length > 0 && !item.variants['無規格']
    if (hasVariants) {
      Object.entries(item.variants).forEach(([label, qty]) => {
        const vDetail = item.variantDetails?.[label]
        rows.push({
          _key: `${item.productId}-${label}`,
          _checked: true,
          productId: item.productId,
          name: item.name,
          sku: item.sku,
          variantLabel: label,
          variantId: vDetail?.id || null,
          maxQty: qty,
          qty: qty,
          cost: item.cost,
          currency: item.currency || 'TWD',
        })
      })
    } else {
      rows.push({
        _key: `${item.productId}-no-variant`,
        _checked: true,
        productId: item.productId,
        name: item.name,
        sku: item.sku,
        variantLabel: null,
        variantId: null,
        maxQty: item.totalQty,
        qty: item.totalQty,
        cost: item.cost,
        currency: item.currency || 'TWD',
      })
    }
  })
  return rows
}

// tripMode：從行程頁進來的「建立入庫批次」。行程鎖定、建立即入庫，走 create_trip_batch RPC。
// 未帶 tripMode 時完全維持既有的訂單／採購彙整流程。
export function CreateBatchSheet({ source, items, tripMode = false, lockedTripId = null, onClose, onSaved }) {
  const { storeId } = useAuth()
  const [members, setMembers] = useState([])
  const [trips, setTrips] = useState([])
  const [tripId, setTripId] = useState(lockedTripId)
  const [batchDate, setBatchDate] = useState(new Date().toISOString().slice(0, 10))
  const [buyerId, setBuyerId] = useState(null)
  const [managerId, setManagerId] = useState(null)
  const [note, setNote] = useState('')
  const [rows, setRows] = useState(() => expandItemsToRows(items))
  const [saving, setSaving] = useState(false)
  const [showPicker, setShowPicker] = useState(false)

  useEffect(() => {
    if (!storeId) return
    fetchStoreMembers(storeId).then(m => setMembers(m))
    supabase.from('trips').select('id, destination, depart_date, return_date')
      .eq('store_id', storeId).order('depart_date', { ascending: false })
      .then(({ data }) => setTrips(data || []))
  }, [storeId])

  const toggleRow = (idx) => {
    setRows(prev => prev.map((r, i) =>
      i === idx ? { ...r, _checked: !r._checked } : r
    ))
  }

  const updateRowQty = (idx, newQty) => {
    setRows(prev => prev.map((r, i) =>
      i === idx ? { ...r, qty: Math.max(0, Math.min(r.maxQty, Number(newQty) || 0)) } : r
    ))
  }

  const updateRowCost = (idx, newCost) => {
    setRows(prev => prev.map((r, i) => i === idx ? { ...r, cost: newCost } : r))
  }

  const removeRow = (idx) => {
    setRows(prev => prev.filter((_, i) => i !== idx))
  }

  function addManualRow(prod, variant, valueMap) {
    const vLabel = variant
      ? Object.values(variant.options || {}).map(id => valueMap[id]).filter(Boolean).join(' / ')
      : null
    // 成本軸：variant.variant_cost ?? products.cost（跟商品頁一致），幣別在商品層
    const cost = variant?.variant_cost ?? prod.cost ?? 0
    setRows(prev => [...prev, {
      _key: `manual-${prod.id}-${variant?.id ?? 'novariant'}-${prev.length}`,
      _checked: true,
      productId: prod.id,
      name: prod.name,
      sku: prod.sku,
      variantLabel: vLabel,
      variantId: variant?.id || null,
      maxQty: 999999,
      qty: 1,
      cost: Number(cost) || 0,
      currency: prod.currency || 'TWD',
    }])
    setShowPicker(false)
  }

  const checkedRows = rows.filter(r => r._checked && r.qty > 0)

  async function createBatch() {
    if (!buyerId) return alert('請選擇付款人')
    setSaving(true)

    // 行程模式：批次、品項、入庫一次做完，避免建完批次還要記得按「同步庫存入庫」
    if (tripMode) {
      const { data, error } = await supabase.rpc('create_trip_batch', {
        p_store_id: storeId,
        p_trip_id: lockedTripId,
        p_batch_date: batchDate,
        p_buyer_id: buyerId,
        p_manager_id: managerId || null,
        p_note: note.trim() || null,
        p_source: '行程採購',
        p_items: checkedRows.map(r => ({
          productId: r.productId,
          variantId: r.variantId,
          qty: r.qty,
          cost: Number(r.cost) || 0,
          currency: r.currency || 'TWD',
        })),
      })
      setSaving(false)
      if (error) return alert('建立失敗：' + error.message)
      if (data?.ok === false) return alert('建立失敗：' + data.error)
      onSaved()
      onClose()
      return
    }

    const { data: batch, error } = await supabase.from('procurement_batches').insert({
      batch_date: batchDate,
      source: source || null,
      buyer_id: buyerId,
      manager_id: managerId || null,
      note: note.trim() || null,
      store_id: storeId,
      status: 'done',
      trip_id: tripId || null,
    }).select().single()

    if (error || !batch) {
      alert('建立失敗：' + (error?.message || ''))
      setSaving(false)
      return
    }

    const insertItems = checkedRows.map(row => ({
      batch_id: batch.id,
      product_id: row.productId,
      variant_id: row.variantId || null,
      quantity: row.qty,
      actual_qty: row.qty,
      unit_cost: row.cost,
      currency: row.currency,
      paid_by: buyerId,
      status: 'bought',
    }))

    if (insertItems.length > 0) {
      await supabase.from('procurement_items').insert(insertItems)
    }

    setSaving(false)
    onSaved()
    onClose()
  }

  return (
    <Sheet title={tripMode ? '建立入庫批次' : `建立採購批次${source ? ` — ${source}` : ''}`} onClose={onClose}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
        <div className="form-group">
          <label className="form-label">採購日期</label>
          <input className="form-input" type="date" value={batchDate} onChange={e => setBatchDate(e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">備註</label>
          <input className="form-input" placeholder="選填" value={note} onChange={e => setNote(e.target.value)} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
        <div className="form-group">
          <label className="form-label">付款人（墊錢）*</label>
          <CustomSelect
            label={members.find(m => m.id === buyerId)?.name || '選擇付款人'}
            value={buyerId}
            options={members.map(m => ({ value: m.id, label: m.name }))}
            onChange={v => setBuyerId(v)}
          />
        </div>
        <div className="form-group">
          <label className="form-label">負責人</label>
          <CustomSelect
            label={members.find(m => m.id === managerId)?.name || '選擇負責人'}
            value={managerId}
            options={members.map(m => ({ value: m.id, label: m.name }))}
            onChange={v => setManagerId(v)}
          />
        </div>
      </div>

      {tripMode ? (
        <div className="form-group" style={{ marginBottom: 16 }}>
          <label className="form-label">掛行程</label>
          <div className="muted fs13" style={{ padding: '8px 0' }}>
            {trips.find(t => t.id === lockedTripId)
              ? `${trips.find(t => t.id === lockedTripId).destination}（本趟，不可更改）`
              : '本趟'}
          </div>
        </div>
      ) : (
        <div className="form-group" style={{ marginBottom: 16 }}>
          <label className="form-label">掛行程（選填）</label>
          <CustomSelect
            label="不掛行程"
            value={tripId}
            options={trips.map(t => ({ value: t.id, label: `${t.destination}（${t.depart_date} ~ ${t.return_date}）` }))}
            onChange={v => setTripId(v)}
          />
        </div>
      )}

      <div className="row-sb" style={{ marginTop: 0 }}>
        <div className="sec" style={{ margin: 0 }}>採購品項</div>
        <button
          onClick={() => setShowPicker(true)}
          style={{
            padding: '4px 10px', borderRadius: 8, border: '1px solid var(--border)',
            background: 'var(--card)', color: 'var(--text)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
          }}
        >+ 手動加商品</button>
      </div>
      {rows.length === 0 && <div className="empty" style={{ padding: '20px 0' }}>尚無品項，可手動加入商品</div>}
      {rows.map((row, idx) => (
        <div key={row._key} className="card" style={{ marginBottom: 6, opacity: row._checked ? 1 : 0.35 }}>
          <div className="card-row" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* 勾選 */}
            <span
              style={{ fontSize: 18, cursor: 'pointer', flexShrink: 0 }}
              onClick={() => toggleRow(idx)}
            >
              {row._checked ? '☑' : '☐'}
            </span>
            {/* 品名 + 規格 */}
            <div style={{ flex: 1, minWidth: 0 }} onClick={() => toggleRow(idx)}>
              <div className="fs13 fw600" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</div>
              {row.variantLabel && <div className="muted fs12">{row.variantLabel}</div>}
              {row.sku && !row.variantLabel && <div className="muted fs12">{row.sku}</div>}
            </div>
            {/* 數量調整 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
              <button
                style={{
                  width: 22, height: 22, borderRadius: 6, border: '1px solid var(--border)',
                  background: 'var(--bg)', cursor: 'pointer', fontSize: 13, padding: 0,
                }}
                onClick={() => updateRowQty(idx, row.qty - 1)}
              >-</button>
              <span className="fw600 fs13" style={{ minWidth: 18, textAlign: 'center' }}>{row.qty}</span>
              <button
                style={{
                  width: 22, height: 22, borderRadius: 6, border: '1px solid var(--border)',
                  background: 'var(--bg)', cursor: 'pointer', fontSize: 13, padding: 0,
                }}
                onClick={() => updateRowQty(idx, row.qty + 1)}
              >+</button>
            </div>
            {/* 單價 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
              <span className="muted fs11">{row.currency || 'TWD'}</span>
              <input
                type="number"
                value={row.cost ?? 0}
                onChange={e => updateRowCost(idx, e.target.value === '' ? 0 : Number(e.target.value))}
                style={{
                  width: 84, padding: '4px 6px', borderRadius: 8,
                  border: '1px solid var(--border)', fontSize: 13,
                  background: 'var(--card)', color: 'var(--text)', boxSizing: 'border-box',
                }}
              />
            </div>
            {/* 移除 */}
            <button
              onClick={() => removeRow(idx)}
              style={{
                flexShrink: 0, background: 'none', border: 'none',
                color: 'var(--red, #ef4444)', fontSize: 16, cursor: 'pointer', padding: 0, lineHeight: 1,
              }}
            >×</button>
          </div>
        </div>
      ))}

      <button
        className="btn"
        onClick={createBatch}
        disabled={saving || (tripMode && checkedRows.length === 0)}
        style={{ marginTop: 12 }}
      >
        {saving
          ? '建立中…'
          : checkedRows.length === 0
            ? (tripMode ? '請先加入商品' : '建立空批次')
            : tripMode
              ? `建立並入庫（${checkedRows.length} 項, ${checkedRows.reduce((s, r) => s + r.qty, 0)} 件）`
              : `建立批次（${checkedRows.length} 項, ${checkedRows.reduce((s, r) => s + r.qty, 0)} 件）`}
      </button>

      {showPicker && (
        <ManualProductPicker onPick={addManualRow} onClose={() => setShowPicker(false)} />
      )}
    </Sheet>
  )
}

/* ─── 手動加商品選擇器 ──────────────────────── */
function ManualProductPicker({ onPick, onClose }) {
  const { storeId } = useAuth()
  const [products, setProducts] = useState([])
  const [variantsByProduct, setVariantsByProduct] = useState({})
  const [valueMap, setValueMap] = useState({})
  const [search, setSearch] = useState('')
  const [brandFilter, setBrandFilter] = useState(null)
  const [selectedProd, setSelectedProd] = useState(null)

  useEffect(() => {
    if (!storeId) return
    Promise.all([
      supabase.from('products').select('id, name, sku, source, cost, currency').eq('store_id', storeId),
      supabase.from('product_variants').select('*').eq('store_id', storeId),
      supabase.from('variant_option_values').select('id, value'),
    ]).then(([{ data: prods }, { data: vars }, { data: vals }]) => {
      setProducts(prods || [])
      const vMap = {}
      ;(vars || []).forEach(v => { if (!vMap[v.product_id]) vMap[v.product_id] = []; vMap[v.product_id].push(v) })
      setVariantsByProduct(vMap)
      const vm = {}
      ;(vals || []).forEach(v => { vm[v.id] = v.value })
      setValueMap(vm)
    })
  }, [storeId])

  const brands = [...new Set(products.map(p => p.source).filter(Boolean))].sort()

  const filtered = products.filter(p => {
    if (brandFilter && p.source !== brandFilter) return false
    const term = search.trim().toLowerCase()
    if (!term) return true
    return p.name.toLowerCase().includes(term) || (p.sku || '').toLowerCase().includes(term)
  })

  function selectProduct(prod) {
    const variants = variantsByProduct[prod.id]
    if (!variants || variants.length === 0) {
      onPick(prod, null, valueMap)
    } else {
      setSelectedProd(prod)
    }
  }

  return (
    <div className="sheet-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <div className="sheet-handle" />
        <div className="row-sb" style={{ marginBottom: 20 }}>
          <div className="sheet-title" style={{ margin: 0 }}>
            {selectedProd ? `選擇規格 — ${selectedProd.name}` : '選擇商品'}
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-3)' }}>×</button>
        </div>

        {!selectedProd && (
          <>
            <input
              className="form-input"
              placeholder="搜尋商品名稱或 SKU"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ marginBottom: 10 }}
            />
            {brands.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <CustomSelect
                  label={brandFilter || '全部品牌'}
                  value={brandFilter}
                  options={brands.map(b => ({ value: b, label: b }))}
                  onChange={v => setBrandFilter(v)}
                />
              </div>
            )}
            <div className="muted fs12" style={{ marginBottom: 8 }}>符合 {filtered.length} 項商品</div>
            {filtered.length === 0 && <div className="empty">找不到商品</div>}
            {filtered.map(p => (
              <div
                key={p.id}
                className="card"
                style={{ marginBottom: 6, cursor: 'pointer' }}
                onClick={() => selectProduct(p)}
              >
                <div className="card-row">
                  <div className="fs13 fw600">{p.name}</div>
                  <div className="muted fs12">{[p.source, p.sku].filter(Boolean).join(' · ')}</div>
                </div>
              </div>
            ))}
          </>
        )}

        {selectedProd && (
          <>
            <button
              onClick={() => setSelectedProd(null)}
              style={{ background: 'none', border: 'none', color: 'var(--text-2)', fontSize: 13, cursor: 'pointer', marginBottom: 10 }}
            >‹ 返回商品清單</button>
            {(variantsByProduct[selectedProd.id] || []).map(v => {
              const label = Object.values(v.options || {}).map(id => valueMap[id]).filter(Boolean).join(' / ')
              return (
                <div
                  key={v.id}
                  className="card"
                  style={{ marginBottom: 6, cursor: 'pointer' }}
                  onClick={() => onPick(selectedProd, v, valueMap)}
                >
                  <div className="card-row">
                    <div className="fs13 fw600">{label || `規格 #${v.id}`}</div>
                  </div>
                </div>
              )
            })}
          </>
        )}
      </div>
    </div>
  )
}

/* ─── 匯出批次 Sheet ──────────────────────── */
function ExportBatchSheet({ batches, memberMap, onClose }) {
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [statusFilter, setStatusFilter] = useState('all') // 'all' | specific status
  const [unchecked, setUnchecked] = useState({}) // id → true means unchecked
  const [resultPage, setResultPage] = useState(1)
  const RESULT_PAGE_SIZE = 10

  const statusOptions = [
    { key: 'all', label: '全部' },
    { key: 'done', label: '未結清' },
    { key: 'settled', label: '已結清' },
  ]

  // Step 1+2: 篩選範圍 + 狀態
  const filtered = batches.filter(b => {
    if (dateFrom && b.batch_date < dateFrom) return false
    if (dateTo && b.batch_date > dateTo) return false
    if (statusFilter !== 'all' && b.status !== statusFilter) return false
    return true
  })

  // Step 3: 預設全勾選，使用者可取消
  const finalBatches = filtered.filter(b => !unchecked[b.id])

  const toggleCheck = (id) => setUnchecked(prev => {
    const next = { ...prev }
    if (next[id]) delete next[id]
    else next[id] = true
    return next
  })

  // 分頁
  const totalPages = Math.max(1, Math.ceil(filtered.length / RESULT_PAGE_SIZE))
  const safePage = Math.min(resultPage, totalPages)
  const pagedResults = filtered.slice((safePage - 1) * RESULT_PAGE_SIZE, safePage * RESULT_PAGE_SIZE)

  // 重設勾選 & 分頁 when filters change
  function onFilterChange(setter) {
    return (val) => { setter(val); setUnchecked({}); setResultPage(1) }
  }

  function doExport() {
    if (finalBatches.length === 0) return alert('沒有可匯出的批次')
    const esc = v => {
      const s = String(v ?? '')
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s
    }
    const rows = [
      ['批次', '日期', '來源', '負責人', '付款人', '批次狀態', '商品', '規格', '預計數量', '實際數量', '單價', '幣別', '實際付款人', '品項狀態', '小計'].join(','),
    ]
    finalBatches.forEach(batch => {
      ;(batch.procurement_items || []).forEach(item => {
        const productName = item.products?.name || ''
        const variantLabel = item.variants?.options ? Object.values(item.variants.options).join(' / ') : ''
        const qty = item.actual_qty ?? item.quantity
        const subtotal = (Number(item.unit_cost) || 0) * qty
        rows.push([
          `#${batch.id}`,
          batch.batch_date,
          esc(batch.source || ''),
          esc(memberMap[batch.manager_id]?.name || ''),
          esc(memberMap[batch.buyer_id]?.name || ''),
          batch.status,
          esc(productName),
          esc(variantLabel),
          item.quantity,
          item.actual_qty ?? '',
          item.unit_cost ?? '',
          item.currency || 'TWD',
          esc(memberMap[item.paid_by || batch.buyer_id]?.name || ''),
          item.status,
          subtotal,
        ].join(','))
      })
    })
    const blob = new Blob(['\uFEFF' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `採購批次_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const inputStyle = {
    flex: 1, padding: '8px 12px', borderRadius: 10, border: '1px solid var(--border)',
    background: 'var(--card)', color: 'var(--text)', fontSize: 14,
  }

  return (
    <Sheet title="匯出採購批次" onClose={onClose}>
      {/* 日期區間 */}
      <div style={{ marginBottom: 14 }}>
        <div className="form-label" style={{ marginBottom: 6 }}>日期區間</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="date" value={dateFrom} onChange={e => onFilterChange(setDateFrom)(e.target.value)} style={inputStyle} />
          <span className="muted">~</span>
          <input type="date" value={dateTo} onChange={e => onFilterChange(setDateTo)(e.target.value)} style={inputStyle} />
        </div>
      </div>

      {/* 狀態篩選 */}
      <div style={{ marginBottom: 16 }}>
        <div className="form-label" style={{ marginBottom: 6 }}>批次狀態</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {statusOptions.map(opt => (
            <button
              key={opt.key}
              onClick={() => onFilterChange(setStatusFilter)(opt.key)}
              style={{
                padding: '6px 14px', borderRadius: 20, border: '1px solid var(--border)',
                background: statusFilter === opt.key ? 'var(--text)' : 'var(--card)',
                color: statusFilter === opt.key ? '#fff' : 'var(--text-2)',
                fontSize: 13, fontWeight: statusFilter === opt.key ? 700 : 400, cursor: 'pointer',
              }}
            >{opt.label}</button>
          ))}
        </div>
      </div>

      {/* 結果列表（可取消勾選） */}
      <div className="sec" style={{ marginTop: 0 }}>
        符合條件 {filtered.length} 筆，已選 {finalBatches.length} 筆
      </div>

      {filtered.length === 0 && <div className="empty">沒有符合條件的批次</div>}

      {pagedResults.map(b => {
        const isChecked = !unchecked[b.id]
        const stLabel = b.status === 'settled' ? '已結清' : '未結清'
        return (
          <div key={b.id} className="card" style={{ marginBottom: 4, opacity: isChecked ? 1 : 0.35 }}>
            <div className="card-row" onClick={() => toggleCheck(b.id)} style={{ cursor: 'pointer', padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 16, flexShrink: 0 }}>{isChecked ? '☑' : '☐'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="fs13 fw600">#{b.id} · {b.source || '手動建立'}</div>
                <div className="muted fs12">{b.batch_date} · {stLabel} · {(b.procurement_items || []).length} 品項</div>
              </div>
            </div>
          </div>
        )
      })}

      {/* 分頁 */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 10 }}>
          <button
            onClick={() => setResultPage(p => Math.max(1, p - 1))}
            disabled={safePage === 1}
            style={{ padding: '4px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', cursor: safePage === 1 ? 'default' : 'pointer', opacity: safePage === 1 ? 0.4 : 1, fontSize: 13 }}
          >‹</button>
          <span className="fs13" style={{ padding: '4px 8px' }}>{safePage} / {totalPages}</span>
          <button
            onClick={() => setResultPage(p => Math.min(totalPages, p + 1))}
            disabled={safePage === totalPages}
            style={{ padding: '4px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', cursor: safePage === totalPages ? 'default' : 'pointer', opacity: safePage === totalPages ? 0.4 : 1, fontSize: 13 }}
          >›</button>
        </div>
      )}

      {/* 匯出按鈕 */}
      <button
        onClick={doExport}
        style={{
          width: '100%', padding: '14px 0', borderRadius: 12, border: 'none', marginTop: 16,
          background: finalBatches.length > 0 ? 'var(--text)' : 'var(--border)',
          color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer',
        }}
      >
        匯出 CSV（{finalBatches.length} 筆批次）
      </button>
    </Sheet>
  )
}

/* ─── 共用 Sheet 元件 ──────────────────────── */
function Sheet({ title, onClose, children }) {
  return (
    <div className="sheet-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <div className="sheet-handle" />
        <div className="row-sb" style={{ marginBottom: 20 }}>
          <div className="sheet-title" style={{ margin: 0 }}>{title}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-3)' }}>×</button>
        </div>
        {children}
      </div>
    </div>
  )
}
