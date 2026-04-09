'use client'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '../../../lib/supabase'
import { useI18n } from '../../layout'

export default function OrderSuccessPage() {
  const { id } = useParams()
  const { t, lang } = useI18n()
  const [order, setOrder] = useState(null)

  useEffect(() => {
    supabase.from('consumer_orders').select('*').eq('id', id).single()
      .then(({ data }) => setOrder(data))
  }, [id])

  return (
    <div className="success-wrap">
      <div className="success-icon">🎉</div>
      <h1 className="success-title">{t('order.success_title')}</h1>
      <p className="success-sub">{t('order.success_sub')}</p>

      {order?.email && (
        <div style={{
          background: '#f0f7ff',
          border: '0.5px solid #bdd6f5',
          borderRadius: 12,
          padding: '14px 20px',
          marginBottom: 20,
          fontSize: 14,
          color: '#1e4d8c',
          lineHeight: 1.7,
          textAlign: 'left',
        }}>
          📧 {lang === 'en'
            ? <>A confirmation email has been sent to <strong>{order.email}</strong>. Please check your inbox.</>
            : <>訂單確認信已寄至 <strong>{order.email}</strong>，請至信箱查收。</>
          }
        </div>
      )}

      <div className="order-no-card">
        <div className="order-no-label">{t('order.order_no')}</div>
        <div className="order-no-value">#{String(id).slice(-8).toUpperCase()}</div>
      </div>

      {order && (
        <div style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 14, padding: 20, marginBottom: 20, textAlign: 'left' }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>{t('order.items')}</div>
          <div style={{ fontSize: 14, color: 'var(--text-2)', lineHeight: 1.8 }}>{order.items}</div>
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '0.5px solid var(--border-light)', display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 16 }}>
            <span>{t('cart.total')}</span>
            <span>NT${Number(order.total_amount || 0).toLocaleString()}</span>
          </div>
        </div>
      )}

      <div className="contact-note">{t('order.contact')}</div>

      <Link href="/" className="btn-primary" style={{ display: 'inline-block', padding: '14px 32px', borderRadius: 12 }}>
        {t('order.back_home')}
      </Link>
    </div>
  )
}
