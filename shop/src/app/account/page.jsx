'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '../../lib/supabase'
import { useI18n, useUser } from '../layout'

export default function AccountPage() {
  const { lang } = useI18n()
  const { user, loading: userLoading } = useUser()
  const router = useRouter()
  const zh = lang === 'zh'

  const [profile, setProfile] = useState({ name: '', phone: '', line_id: '' })
  const [editProfile, setEditProfile] = useState(false)
  const [profileSaving, setProfileSaving] = useState(false)

  const [orders, setOrders] = useState([])
  const [ordersLoading, setOrdersLoading] = useState(true)
  const [selectedOrder, setSelectedOrder] = useState(null)
  const [cancelling, setCancelling] = useState(false)

  useEffect(() => {
    if (!userLoading && !user) router.push('/auth')
  }, [user, userLoading])

  useEffect(() => {
    if (!user) return
    loadProfile()
    loadOrders()
  }, [user])

  async function loadProfile() {
    const { data } = await supabase.from('consumers').select('*').eq('id', user.id).single()
    if (data) {
      setProfile({ name: data.name || '', phone: data.phone || '', line_id: data.line_id || '' })
    } else {
      const name = user.user_metadata?.name || ''
      await supabase.from('consumers').insert({ id: user.id, email: user.email, name })
      setProfile({ name, phone: '', line_id: '' })
    }
  }

  async function loadOrders() {
    setOrdersLoading(true)
    const { data } = await supabase
      .from('consumer_orders')
      .select('*')
      .eq('email', user.email)
      .order('created_at', { ascending: false })
    setOrders(data || [])
    setOrdersLoading(false)
  }

  async function saveProfile() {
    setProfileSaving(true)
    await supabase.from('consumers').update({ name: profile.name, phone: profile.phone, line_id: profile.line_id }).eq('id', user.id)
    setProfileSaving(false)
    setEditProfile(false)
  }

  async function cancelOrder(orderId) {
    setCancelling(true)
    await supabase
      .from('consumer_orders')
      .update({ status: '已取消' })
      .eq('id', orderId)
      .eq('email', user.email)
    // Update local state immediately
    setSelectedOrder(o => ({ ...o, status: '已取消' }))
    setOrders(prev => prev.map(o => o.id === orderId ? { ...o, status: '已取消' } : o))
    setCancelling(false)
  }

  async function signOut() {
    await supabase.auth.signOut()
    router.push('/')
  }

  if (userLoading) {
    return <div style={{ textAlign: 'center', padding: 80, color: 'var(--text-3)' }}>{zh ? '載入中…' : 'Loading…'}</div>
  }
  if (!user) return null

  return (
    <div className="account-wrap">

      {/* ── Profile ── */}
      <section className="account-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 className="account-section-title" style={{ marginBottom: 0 }}>{zh ? '個人資料' : 'Profile'}</h2>
          <button onClick={signOut} className="btn-signout">{zh ? '登出' : 'Sign Out'}</button>
        </div>

        <div className="account-card">
          <div className="account-field">
            <span className="account-field-label">Email</span>
            <span className="account-field-value" style={{ color: 'var(--text-3)' }}>{user.email}</span>
          </div>

          {editProfile ? (
            <>
              <div className="form-group" style={{ marginTop: 14 }}>
                <label className="form-label">{zh ? '姓名' : 'Name'}</label>
                <input
                  className="form-input"
                  value={profile.name}
                  onChange={e => setProfile(p => ({ ...p, name: e.target.value }))}
                />
              </div>
              <div className="form-group">
                <label className="form-label">{zh ? '電話' : 'Phone'}</label>
                <input
                  className="form-input"
                  value={profile.phone}
                  onChange={e => setProfile(p => ({ ...p, phone: e.target.value }))}
                />
              </div>
              <div className="form-group">
                <label className="form-label">LINE ID</label>
                <input
                  className="form-input"
                  placeholder={zh ? '例：@yourlineid' : 'e.g. @yourlineid'}
                  value={profile.line_id}
                  onChange={e => setProfile(p => ({ ...p, line_id: e.target.value }))}
                />
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                <button className="btn-primary" style={{ flex: 1, padding: '10px 0' }} onClick={saveProfile} disabled={profileSaving}>
                  {profileSaving ? (zh ? '儲存中…' : 'Saving…') : (zh ? '儲存' : 'Save')}
                </button>
                <button className="btn-outline" style={{ flex: 1, padding: '10px 0' }} onClick={() => setEditProfile(false)}>
                  {zh ? '取消' : 'Cancel'}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="account-field">
                <span className="account-field-label">{zh ? '姓名' : 'Name'}</span>
                <span className="account-field-value">{profile.name || <span style={{ color: 'var(--text-3)' }}>{zh ? '未設定' : 'Not set'}</span>}</span>
              </div>
              <div className="account-field">
                <span className="account-field-label">{zh ? '電話' : 'Phone'}</span>
                <span className="account-field-value">{profile.phone || <span style={{ color: 'var(--text-3)' }}>{zh ? '未設定' : 'Not set'}</span>}</span>
              </div>
              <div className="account-field" style={{ borderBottom: 'none' }}>
                <span className="account-field-label">LINE ID</span>
                <span className="account-field-value">{profile.line_id || <span style={{ color: 'var(--text-3)' }}>{zh ? '未設定' : 'Not set'}</span>}</span>
              </div>
              <button
                className="btn-outline"
                style={{ marginTop: 14, padding: '10px 0', width: '100%' }}
                onClick={() => setEditProfile(true)}
              >
                {zh ? '編輯資料' : 'Edit Profile'}
              </button>
            </>
          )}
        </div>
      </section>

      {/* ── Orders ── */}
      <section className="account-section">
        <h2 className="account-section-title">{zh ? '訂單紀錄' : 'Order History'}</h2>

        {ordersLoading && (
          <div style={{ color: 'var(--text-3)', padding: '20px 0' }}>{zh ? '載入中…' : 'Loading…'}</div>
        )}

        {!ordersLoading && orders.length === 0 && (
          <div className="empty-state">
            <div className="empty-icon">📦</div>
            <div className="empty-title">{zh ? '還沒有訂單' : 'No orders yet'}</div>
            <div className="empty-sub">{zh ? '去逛逛商品吧！' : 'Start shopping!'}</div>
            <Link href="/products" className="btn-primary" style={{ display: 'inline-block', padding: '12px 28px', borderRadius: 12 }}>
              {zh ? '瀏覽商品' : 'Browse Products'}
            </Link>
          </div>
        )}

        {orders.map(o => (
          <OrderCard key={o.id} order={o} zh={zh} onClick={() => setSelectedOrder(o)} />
        ))}
      </section>

      {selectedOrder && (
        <OrderDetailModal
          order={selectedOrder}
          zh={zh}
          onClose={() => setSelectedOrder(null)}
          onCancel={() => cancelOrder(selectedOrder.id)}
          cancelling={cancelling}
        />
      )}
    </div>
  )
}

function statusColor(s) {
  if (s === '完成' || s === '已出貨') return 'var(--green)'
  if (s === '已取消') return 'var(--red)'
  if (s === '處理中') return 'var(--amber)'
  return 'var(--text-3)'
}

function OrderCard({ order: o, zh, onClick }) {
  return (
    <div className="account-order-card" onClick={onClick}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 4 }}>
            #{o.id?.toString().slice(-6)} · {new Date(o.created_at).toLocaleDateString('zh-TW')}
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.4 }}>{o.items}</div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 14 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>NT${Number(o.total_amount || 0).toLocaleString()}</div>
          <div style={{ fontSize: 12, color: statusColor(o.status), marginTop: 3, fontWeight: 500 }}>{o.status}</div>
        </div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-3)', display: 'flex', justifyContent: 'space-between' }}>
        <span style={{ color: o.payment_status === '已付清' ? 'var(--green)' : undefined }}>
          {o.payment_status === '已付清' ? (zh ? '已付清' : 'Paid') : (zh ? '待付款' : 'Pending payment')}
        </span>
        <span>{zh ? '點擊查看明細 →' : 'View details →'}</span>
      </div>
    </div>
  )
}

function OrderDetailModal({ order: o, zh, onClose, onCancel, cancelling }) {
  const items = Array.isArray(o.items_json) ? o.items_json : null
  const canCancel = o.status === '待確認'

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h3 style={{ fontSize: 17, fontWeight: 700 }}>{zh ? '訂單明細' : 'Order Detail'}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 24, color: 'var(--text-3)', cursor: 'pointer', lineHeight: 1, padding: 0 }}>×</button>
        </div>

        {/* Status */}
        <div className="modal-row">
          <span className="modal-label">{zh ? '訂單編號' : 'Order #'}</span>
          <span className="modal-value fw600">#{o.id?.toString().slice(-6)}</span>
        </div>
        <div className="modal-row">
          <span className="modal-label">{zh ? '下單時間' : 'Date'}</span>
          <span className="modal-value">{new Date(o.created_at).toLocaleString('zh-TW')}</span>
        </div>
        <div className="modal-row">
          <span className="modal-label">{zh ? '訂單狀態' : 'Status'}</span>
          <span className="modal-value" style={{ color: statusColor(o.status), fontWeight: 600 }}>{o.status}</span>
        </div>
        <div className="modal-row">
          <span className="modal-label">{zh ? '付款狀態' : 'Payment'}</span>
          <span className="modal-value" style={{ color: o.payment_status === '已付清' ? 'var(--green)' : undefined }}>
            {o.payment_status}
          </span>
        </div>
        <div className="modal-row">
          <span className="modal-label">{zh ? '總金額' : 'Total'}</span>
          <span className="modal-value" style={{ fontWeight: 700, fontSize: 16 }}>NT${Number(o.total_amount || 0).toLocaleString()}</span>
        </div>

        <hr style={{ border: 'none', borderTop: '0.5px solid var(--border)', margin: '14px 0' }} />

        {/* Contact */}
        <div className="modal-section-label">{zh ? '收件資訊' : 'Shipping Info'}</div>
        <div className="modal-row">
          <span className="modal-label">{zh ? '姓名' : 'Name'}</span>
          <span className="modal-value">{o.customer_name}</span>
        </div>
        <div className="modal-row">
          <span className="modal-label">{zh ? '電話' : 'Phone'}</span>
          <span className="modal-value">{o.phone}</span>
        </div>
        <div className="modal-row" style={{ alignItems: 'flex-start' }}>
          <span className="modal-label">{zh ? '地址' : 'Address'}</span>
          <span className="modal-value" style={{ textAlign: 'right', maxWidth: '58%' }}>{o.address}</span>
        </div>
        {o.note && (
          <div className="modal-row">
            <span className="modal-label">{zh ? '備註' : 'Note'}</span>
            <span className="modal-value">{o.note}</span>
          </div>
        )}

        <hr style={{ border: 'none', borderTop: '0.5px solid var(--border)', margin: '14px 0' }} />

        {/* Items */}
        <div className="modal-section-label">{zh ? '訂購商品' : 'Items'}</div>
        {items ? items.map((item, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{item.name}</div>
              {(item.color || item.size) && (
                <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
                  {[item.color, item.size].filter(Boolean).join(' / ')}
                </div>
              )}
              {item.customNote && <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{item.customNote}</div>}
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 14 }}>
              <div style={{ fontSize: 13 }}>× {item.qty}</div>
              <div style={{ fontSize: 13, color: 'var(--text-2)' }}>NT${(item.price * item.qty).toLocaleString()}</div>
            </div>
          </div>
        )) : (
          <div style={{ fontSize: 14, color: 'var(--text-2)' }}>{o.items}</div>
        )}

        {canCancel && (
          <button
            onClick={onCancel}
            disabled={cancelling}
            style={{
              width: '100%', marginTop: 20, padding: 13, borderRadius: 12,
              border: `0.5px solid var(--red)`, background: 'transparent',
              color: 'var(--red)', fontSize: 15, fontWeight: 600,
              cursor: cancelling ? 'not-allowed' : 'pointer',
              opacity: cancelling ? 0.5 : 1, transition: 'opacity .15s',
            }}
          >
            {cancelling ? (zh ? '取消中…' : 'Cancelling…') : (zh ? '取消訂單' : 'Cancel Order')}
          </button>
        )}
      </div>
    </div>
  )
}
