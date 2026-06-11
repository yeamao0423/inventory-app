import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'

export default function CouponsPage() {
  const { can, storeId } = useAuth()
  const [coupons, setCoupons] = useState([])
  const [loading, setLoading] = useState(true)
  const [sheet, setSheet] = useState(null) // null | 'add' | coupon obj
  const [detailCoupon, setDetailCoupon] = useState(null) // coupon obj for detail view

  useEffect(() => { fetchCoupons() }, [storeId])

  async function fetchCoupons() {
    if (!storeId) return
    setLoading(true)
    const { data } = await supabase
      .from('coupons')
      .select('*')
      .eq('store_id', storeId)
      .order('created_at', { ascending: false })
    setCoupons(data || [])
    setLoading(false)
  }

  async function deleteCoupon(id) {
    if (!window.confirm('確定刪除此優惠券？相關代碼與使用紀錄也會一併刪除。')) return
    await supabase.from('coupon_usage').delete().eq('coupon_id', id)
    await supabase.from('coupon_codes').delete().eq('coupon_id', id)
    await supabase.from('coupons').delete().eq('id', id)
    setDetailCoupon(null)
    fetchCoupons()
  }

  function formatDate(d) {
    if (!d) return '—'
    const date = new Date(d)
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
  }

  function discountLabel(c) {
    const prefix = c.min_amount > 0 ? `滿$${Number(c.min_amount).toLocaleString()} ` : ''
    if (c.discount_type === 'fixed') return `${prefix}折 $${Number(c.discount_value).toLocaleString()}`
    return `${prefix}打 ${(100 - Number(c.discount_value)) / 10} 折`
  }

  function statusBadge(c) {
    if (!c.is_active) return { text: '已停用', color: 'var(--text-3)', bg: 'var(--border-light)' }
    const now = new Date()
    if (c.expires_at && new Date(c.expires_at) < now) return { text: '已過期', color: 'var(--red)', bg: 'var(--red-bg)' }
    if (new Date(c.starts_at) > now) return { text: '未開始', color: 'var(--amber)', bg: 'var(--amber-bg)' }
    return { text: '進行中', color: 'var(--green)', bg: 'var(--green-bg)' }
  }

  // Detail view
  if (detailCoupon) {
    return (
      <>
        <CouponDetail
          coupon={detailCoupon}
          onBack={() => setDetailCoupon(null)}
          onEdit={() => setSheet(detailCoupon)}
          onDelete={deleteCoupon}
          onRefresh={async () => {
            const { data } = await supabase.from('coupons').select('*').eq('id', detailCoupon.id).single()
            if (data) setDetailCoupon(data)
            fetchCoupons()
          }}
          formatDate={formatDate}
          discountLabel={discountLabel}
          statusBadge={statusBadge}
        />
        {sheet && (
          <CouponSheet
            coupon={sheet === 'add' ? null : sheet}
            onClose={() => setSheet(null)}
            onSaved={async () => {
              setSheet(null)
              const { data } = await supabase.from('coupons').select('*').eq('id', detailCoupon.id).single()
              if (data) setDetailCoupon(data)
              fetchCoupons()
            }}
          />
        )}
      </>
    )
  }

  return (
    <div className="page">
      <div className="ph">
        <div>
          <div className="ph-title">優惠券管理</div>
          <div className="ph-sub">{coupons.length} 個優惠活動</div>
        </div>
        {can('edit') && (
          <button className="icon-btn" onClick={() => setSheet('add')}>+</button>
        )}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-3)' }}>載入中…</div>
      ) : coupons.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-3)' }}>尚無優惠券，點右上角 + 新增</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {coupons.map(c => {
            const badge = statusBadge(c)
            return (
              <div
                key={c.id}
                onClick={() => setDetailCoupon(c)}
                style={{
                  background: 'var(--surface)',
                  borderRadius: 12,
                  padding: 14,
                  cursor: 'pointer',
                  border: '1px solid var(--border)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <div style={{ fontWeight: 600, fontSize: 15 }}>{c.name}</div>
                      <span style={{
                        fontSize: 11, padding: '2px 8px', borderRadius: 6,
                        background: badge.bg, color: badge.color, fontWeight: 500,
                      }}>{badge.text}</span>
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 2 }}>
                      {discountLabel(c)}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                      {c.type === 'shared' ? `代碼：${c.code}` : '特殊代碼（一次性）'}
                      {' · '}
                      {formatDate(c.starts_at)} — {formatDate(c.expires_at)}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 12 }}>
                    <div style={{ fontWeight: 600, fontSize: 15 }}>
                      {c.usage_count}{c.type === 'shared' && c.max_usage ? `/${c.max_usage}` : ''}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-3)' }}>已使用</div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {sheet && (
        <CouponSheet
          coupon={sheet === 'add' ? null : sheet}
          onClose={() => setSheet(null)}
          onSaved={() => { setSheet(null); fetchCoupons() }}
        />
      )}
    </div>
  )
}

// ─── Coupon Detail View ─────────────────────────────────────────
function CouponDetail({ coupon, onBack, onEdit, onDelete, onRefresh, formatDate, discountLabel, statusBadge }) {
  const { can } = useAuth()
  const [codes, setCodes] = useState([])
  const [usage, setUsage] = useState([])
  const [loadingData, setLoadingData] = useState(true)
  const [copiedId, setCopiedId] = useState(null)
  const [showCodes, setShowCodes] = useState(false)

  useEffect(() => { fetchDetail() }, [coupon.id])

  async function fetchDetail() {
    setLoadingData(true)
    const promises = [
      supabase.from('coupon_usage').select('*').eq('coupon_id', coupon.id).order('created_at', { ascending: false }),
    ]
    if (coupon.type === 'unique') {
      promises.push(
        supabase.from('coupon_codes').select('*').eq('coupon_id', coupon.id).order('created_at', { ascending: true })
      )
    }
    const results = await Promise.all(promises)
    setUsage(results[0].data || [])
    if (coupon.type === 'unique') setCodes(results[1].data || [])
    setLoadingData(false)
  }

  async function toggleActive() {
    await supabase.from('coupons').update({ is_active: !coupon.is_active }).eq('id', coupon.id)
    onRefresh()
  }

  function copyCode(code, id) {
    navigator.clipboard.writeText(code)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 1500)
  }

  const badge = statusBadge(coupon)
  const totalDiscount = usage.reduce((s, u) => s + Number(u.discount_amount || 0), 0)
  const usedCodes = codes.filter(c => c.is_used).length

  return (
    <div className="page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <button
          onClick={onBack}
          style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', padding: 4 }}
        >←</button>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 18 }}>{coupon.name}</div>
        </div>
        {can('edit') && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={onEdit}
              style={{
                background: 'none', border: '1px solid var(--border)', borderRadius: 8,
                padding: '6px 14px', fontSize: 13, cursor: 'pointer',
              }}
            >編輯</button>
          </div>
        )}
      </div>

      {/* Status & Info */}
      <div style={{
        background: 'var(--surface)', borderRadius: 12, padding: 16,
        border: '1px solid var(--border)', marginBottom: 12,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <span style={{
            fontSize: 12, padding: '3px 10px', borderRadius: 6,
            background: badge.bg, color: badge.color, fontWeight: 500,
          }}>{badge.text}</span>
          {can('edit') && (
            <button
              onClick={toggleActive}
              style={{
                background: 'none', border: 'none', fontSize: 13, cursor: 'pointer',
                color: coupon.is_active ? 'var(--red)' : 'var(--green)',
              }}
            >{coupon.is_active ? '停用' : '啟用'}</button>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <InfoRow label="類型" value={coupon.type === 'shared' ? '分眾型（通用代碼）' : '特殊代碼（一次性）'} />
          {coupon.type === 'shared' && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: 'var(--text-3)' }}>優惠碼</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 600, fontFamily: 'monospace' }}>{coupon.code}</span>
                <button
                  onClick={() => copyCode(coupon.code, 'shared')}
                  style={{
                    background: 'none', border: '1px solid var(--border)', borderRadius: 6,
                    padding: '2px 8px', fontSize: 12, cursor: 'pointer',
                    color: copiedId === 'shared' ? 'var(--green)' : 'var(--text-2)',
                  }}
                >{copiedId === 'shared' ? '已複製' : '複製'}</button>
              </div>
            </div>
          )}
          <InfoRow label="折扣" value={discountLabel(coupon)} />
          {coupon.discount_type === 'percentage' && coupon.max_discount && (
            <InfoRow label="折扣上限" value={`$${Number(coupon.max_discount).toLocaleString()}`} />
          )}
          <InfoRow label="有效期間" value={`${formatDate(coupon.starts_at)} — ${formatDate(coupon.expires_at)}`} />
          <InfoRow label="每人限用" value={coupon.per_consumer_limit ? `${coupon.per_consumer_limit} 次` : '無限'} />
        </div>
      </div>

      {/* Stats */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12,
      }}>
        <StatCard label="已使用次數" value={
          coupon.type === 'shared'
            ? `${coupon.usage_count}${coupon.max_usage ? ` / ${coupon.max_usage}` : ''}`
            : `${usedCodes} / ${codes.length}`
        } />
        <StatCard label="折抵總金額" value={`$${totalDiscount.toLocaleString()}`} />
      </div>

      {/* Unique codes list */}
      {coupon.type === 'unique' && (
        <div style={{
          background: 'var(--surface)', borderRadius: 12, padding: 16,
          border: '1px solid var(--border)', marginBottom: 12,
        }}>
          <div
            onClick={() => setShowCodes(!showCodes)}
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
          >
            <div style={{ fontWeight: 600, fontSize: 14 }}>代碼列表（{codes.length} 組）</div>
            <span style={{ fontSize: 13, color: 'var(--text-3)' }}>{showCodes ? '收合' : '展開'}</span>
          </div>
          {showCodes && (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {codes.map(cc => (
                <div key={cc.id} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '8px 0', borderBottom: '1px solid var(--border-light)',
                }}>
                  <div>
                    <span style={{
                      fontFamily: 'monospace', fontSize: 14, fontWeight: 500,
                      color: cc.is_used ? 'var(--text-3)' : 'var(--text)',
                      textDecoration: cc.is_used ? 'line-through' : 'none',
                    }}>{cc.code}</span>
                    {cc.is_used && (
                      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                        {cc.used_by} · 訂單 #{cc.order_id}
                      </div>
                    )}
                  </div>
                  {!cc.is_used && (
                    <button
                      onClick={() => copyCode(cc.code, cc.id)}
                      style={{
                        background: 'none', border: '1px solid var(--border)', borderRadius: 6,
                        padding: '2px 8px', fontSize: 12, cursor: 'pointer',
                        color: copiedId === cc.id ? 'var(--green)' : 'var(--text-2)',
                      }}
                    >{copiedId === cc.id ? '已複製' : '複製'}</button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Usage history */}
      <div style={{
        background: 'var(--surface)', borderRadius: 12, padding: 16,
        border: '1px solid var(--border)', marginBottom: 12,
      }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>使用紀錄</div>
        {loadingData ? (
          <div style={{ fontSize: 13, color: 'var(--text-3)' }}>載入中…</div>
        ) : usage.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-3)' }}>尚無使用紀錄</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {usage.map(u => (
              <div key={u.id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '6px 0', borderBottom: '1px solid var(--border-light)',
              }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>訂單 #{u.order_id}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{u.consumer_email || '—'}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--green)' }}>
                    -${Number(u.discount_amount).toLocaleString()}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{formatDate(u.created_at)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Delete */}
      {can('delete') && (
        <button
          onClick={() => onDelete(coupon.id)}
          style={{
            width: '100%', padding: 12, background: 'none',
            border: '1px solid var(--red)', borderRadius: 12,
            color: 'var(--red)', fontSize: 14, fontWeight: 600, cursor: 'pointer',
          }}
        >刪除此優惠券</button>
      )}
    </div>
  )
}

function InfoRow({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: 13, color: 'var(--text-3)' }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 500 }}>{value}</span>
    </div>
  )
}

function StatCard({ label, value }) {
  return (
    <div style={{
      background: 'var(--surface)', borderRadius: 12, padding: 14,
      border: '1px solid var(--border)', textAlign: 'center',
    }}>
      <div style={{ fontSize: 18, fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>{label}</div>
    </div>
  )
}

// ─── Coupon Sheet (Add / Edit) ──────────────────────────────────
function CouponSheet({ coupon, onClose, onSaved }) {
  const { storeId } = useAuth()
  const isEdit = !!coupon

  const [type, setType] = useState(coupon?.type || 'shared')
  const [name, setName] = useState(coupon?.name || '')
  const [code, setCode] = useState(coupon?.code || '')
  const [discountType, setDiscountType] = useState(coupon?.discount_type || 'fixed')
  const [discountValue, setDiscountValue] = useState(coupon?.discount_value ? String(coupon.discount_value) : '')
  const [minAmount, setMinAmount] = useState(coupon?.min_amount ? String(coupon.min_amount) : '0')
  const [maxDiscount, setMaxDiscount] = useState(coupon?.max_discount ? String(coupon.max_discount) : '')
  const [maxUsage, setMaxUsage] = useState(coupon?.max_usage ? String(coupon.max_usage) : '')
  const [perConsumerLimit, setPerConsumerLimit] = useState(coupon?.per_consumer_limit ? String(coupon.per_consumer_limit) : '1')
  const [startsAt, setStartsAt] = useState(coupon?.starts_at ? coupon.starts_at.slice(0, 10) : new Date().toISOString().slice(0, 10))
  const [expiresAt, setExpiresAt] = useState(coupon?.expires_at ? coupon.expires_at.slice(0, 10) : '')

  // unique 型專用
  const [codePrefix, setCodePrefix] = useState('')
  const [codeCount, setCodeCount] = useState('10')

  const [saving, setSaving] = useState(false)

  function generateUniqueCodes(count, prefix = '') {
    const codes = new Set()
    while (codes.size < count) {
      const random = Math.random().toString(36).substring(2, 8).toUpperCase()
      codes.add(prefix ? `${prefix}-${random}` : random)
    }
    return [...codes]
  }

  async function handleSave() {
    if (!name.trim()) return alert('請輸入活動名稱')
    if (type === 'shared' && !code.trim()) return alert('請輸入優惠碼')
    if (!discountValue || Number(discountValue) <= 0) return alert('請輸入折扣值')

    setSaving(true)

    const payload = {
      name: name.trim(),
      type,
      code: type === 'shared' ? code.trim().toUpperCase() : null,
      discount_type: discountType,
      discount_value: Number(discountValue),
      min_amount: Number(minAmount) || 0,
      max_discount: discountType === 'percentage' && maxDiscount ? Number(maxDiscount) : null,
      max_usage: type === 'shared' && maxUsage ? Number(maxUsage) : null,
      per_consumer_limit: type === 'unique' ? 1 : (perConsumerLimit ? Number(perConsumerLimit) : null),
      starts_at: new Date(startsAt).toISOString(),
      expires_at: expiresAt ? new Date(expiresAt + 'T23:59:59').toISOString() : null,
    }

    if (isEdit) {
      const { error } = await supabase.from('coupons').update(payload).eq('id', coupon.id)
      if (error) { alert('更新失敗：' + error.message); setSaving(false); return }
    } else {
      const { data: newCoupon, error } = await supabase.from('coupons').insert({ ...payload, store_id: storeId }).select().single()
      if (error) { alert('建立失敗：' + error.message); setSaving(false); return }

      // unique 型：批量產生代碼
      if (type === 'unique' && newCoupon) {
        const count = Math.max(1, Math.min(500, Number(codeCount) || 10))
        const generatedCodes = generateUniqueCodes(count, codePrefix.trim().toUpperCase())
        const { error: codeError } = await supabase.from('coupon_codes').insert(
          generatedCodes.map(c => ({ coupon_id: newCoupon.id, code: c }))
        )
        if (codeError) alert('代碼產生失敗：' + codeError.message)
      }
    }

    setSaving(false)
    onSaved()
  }

  const inputStyle = {
    width: '100%', padding: '10px 12px', borderRadius: 8,
    border: '1px solid var(--border)', fontSize: 15,
    background: 'var(--bg)', boxSizing: 'border-box',
  }
  const labelStyle = { fontSize: 13, fontWeight: 500, color: 'var(--text-2)', marginBottom: 4 }

  return (
    <div className="sheet-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <div className="sheet-handle" />
        <div className="row-sb" style={{ marginBottom: 20 }}>
          <div className="sheet-title" style={{ margin: 0 }}>{isEdit ? '編輯優惠券' : '新增優惠券'}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-3)' }}>×</button>
        </div>

        {/* Type selector - only for new */}
        {!isEdit && (
          <div style={{ marginBottom: 16 }}>
            <div style={labelStyle}>優惠券類型</div>
            <div style={{ display: 'flex', gap: 8 }}>
              {[
                { key: 'shared', label: '分眾型（通用代碼）' },
                { key: 'unique', label: '特殊代碼（一次性）' },
              ].map(t => (
                <button
                  key={t.key}
                  onClick={() => setType(t.key)}
                  style={{
                    flex: 1, padding: '10px 8px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
                    border: type === t.key ? '2px solid var(--text)' : '1px solid var(--border)',
                    background: type === t.key ? 'var(--surface)' : 'transparent',
                    fontWeight: type === t.key ? 600 : 400,
                  }}
                >{t.label}</button>
              ))}
            </div>
          </div>
        )}

        {/* Name */}
        <div style={{ marginBottom: 16 }}>
          <div style={labelStyle}>活動名稱</div>
          <input style={inputStyle} placeholder="例：夏季促銷" value={name} onChange={e => setName(e.target.value)} />
        </div>

        {/* Shared: code */}
        {type === 'shared' && (
          <div style={{ marginBottom: 16 }}>
            <div style={labelStyle}>優惠碼</div>
            <input
              style={{ ...inputStyle, fontFamily: 'monospace', textTransform: 'uppercase' }}
              placeholder="例：SUMMER2026"
              value={code}
              onChange={e => setCode(e.target.value)}
            />
          </div>
        )}

        {/* Unique: prefix + count (new only) */}
        {type === 'unique' && !isEdit && (
          <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
            <div style={{ flex: 1 }}>
              <div style={labelStyle}>代碼前綴（選填）</div>
              <input
                style={{ ...inputStyle, fontFamily: 'monospace', textTransform: 'uppercase' }}
                placeholder="例：VIP"
                value={codePrefix}
                onChange={e => setCodePrefix(e.target.value)}
              />
            </div>
            <div style={{ width: 100 }}>
              <div style={labelStyle}>產生數量</div>
              <input
                style={inputStyle}
                type="number"
                inputMode="numeric"
                value={codeCount}
                onChange={e => setCodeCount(e.target.value)}
              />
            </div>
          </div>
        )}

        <div style={{ borderTop: '1px solid var(--border)', marginBottom: 16 }} />

        {/* Discount type */}
        <div style={{ marginBottom: 16 }}>
          <div style={labelStyle}>折扣方式</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {[
              { key: 'fixed', label: '固定金額' },
              { key: 'percentage', label: '百分比折扣' },
            ].map(t => (
              <button
                key={t.key}
                onClick={() => setDiscountType(t.key)}
                style={{
                  flex: 1, padding: '10px 8px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
                  border: discountType === t.key ? '2px solid var(--text)' : '1px solid var(--border)',
                  background: discountType === t.key ? 'var(--surface)' : 'transparent',
                  fontWeight: discountType === t.key ? 600 : 400,
                }}
              >{t.label}</button>
            ))}
          </div>
        </div>

        {/* Discount value */}
        <div style={{ marginBottom: 16 }}>
          <div style={labelStyle}>{discountType === 'fixed' ? '折扣金額（NT$）' : '折扣百分比（%）'}</div>
          <input
            style={inputStyle}
            type="number"
            inputMode="numeric"
            placeholder={discountType === 'fixed' ? '例：100' : '例：15（代表打 85 折）'}
            value={discountValue}
            onChange={e => setDiscountValue(e.target.value)}
          />
          {discountType === 'percentage' && discountValue && (
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
              即打 {(100 - Number(discountValue)) / 10} 折
            </div>
          )}
        </div>

        {/* Min amount */}
        <div style={{ marginBottom: 16 }}>
          <div style={labelStyle}>滿額門檻（0 = 無門檻）</div>
          <input
            style={inputStyle}
            type="number"
            inputMode="numeric"
            placeholder="0"
            value={minAmount}
            onChange={e => setMinAmount(e.target.value)}
          />
        </div>

        {/* Max discount (percentage only) */}
        {discountType === 'percentage' && (
          <div style={{ marginBottom: 16 }}>
            <div style={labelStyle}>折扣上限金額（選填）</div>
            <input
              style={inputStyle}
              type="number"
              inputMode="numeric"
              placeholder="不填 = 無上限"
              value={maxDiscount}
              onChange={e => setMaxDiscount(e.target.value)}
            />
          </div>
        )}

        <div style={{ borderTop: '1px solid var(--border)', marginBottom: 16 }} />

        {/* Usage limits */}
        {type === 'shared' && (
          <>
            <div style={{ marginBottom: 16 }}>
              <div style={labelStyle}>總使用次數上限（選填）</div>
              <input
                style={inputStyle}
                type="number"
                inputMode="numeric"
                placeholder="不填 = 無限"
                value={maxUsage}
                onChange={e => setMaxUsage(e.target.value)}
              />
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={labelStyle}>每人使用次數上限</div>
              <input
                style={inputStyle}
                type="number"
                inputMode="numeric"
                placeholder="不填 = 無限"
                value={perConsumerLimit}
                onChange={e => setPerConsumerLimit(e.target.value)}
              />
            </div>
          </>
        )}

        {type === 'unique' && (
          <div style={{ marginBottom: 16, fontSize: 13, color: 'var(--text-3)', padding: '8px 12px', background: 'var(--border-light)', borderRadius: 8 }}>
            特殊代碼型：每組代碼只能使用一次
          </div>
        )}

        {/* Date range */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
          <div style={{ flex: 1 }}>
            <div style={labelStyle}>開始日期</div>
            <input style={inputStyle} type="date" value={startsAt} onChange={e => setStartsAt(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={labelStyle}>結束日期（選填）</div>
            <input style={inputStyle} type="date" value={expiresAt} onChange={e => setExpiresAt(e.target.value)} />
          </div>
        </div>

        <button className="btn" onClick={handleSave} disabled={saving}>
          {saving ? '儲存中…' : (isEdit ? '更新' : '建立優惠券')}
        </button>
      </div>
    </div>
  )
}
