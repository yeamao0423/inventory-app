'use client'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '../../../lib/supabase'
import { getStore } from '../../../lib/store'
import { useI18n } from '../../layout'

export default function OrderSuccessPage() {
  // 路由參數雖名為 id，實為不可猜的 public_token（見 20250031 migration）。
  const { id: token } = useParams()
  const { t, lang } = useI18n()
  const [order, setOrder] = useState(null)
  const [store, setStore] = useState(null)

  useEffect(() => {
    supabase.rpc('get_consumer_order', { p_token: token })
      .then(({ data }) => setOrder(data))
    getStore().then(setStore).catch(() => {})
  }, [token])

  const bank = store?.settings?.bank_account ? store.settings : null

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

      {/* 匯款資訊 */}
      <div style={{
        background: '#f0f7ff',
        border: '0.5px solid #bdd6f5',
        borderRadius: 12,
        padding: '16px 20px',
        marginBottom: 16,
        fontSize: 14,
        color: '#1e4d8c',
        lineHeight: 1.8,
        textAlign: 'left',
      }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>
          🏦 {lang === 'zh' ? '匯款資訊' : 'Bank Transfer Info'}
        </div>
        {bank ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: '#4a7ab5' }}>{lang === 'zh' ? '銀行' : 'Bank'}</span>
              <span style={{ fontWeight: 600 }}>{bank.bank_name}{bank.bank_code ? ` (${bank.bank_code})` : ''}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: '#4a7ab5' }}>{lang === 'zh' ? '帳號' : 'Account'}</span>
              <span style={{ fontWeight: 700, fontSize: 16, letterSpacing: 1 }}>{bank.bank_account}</span>
            </div>
            {bank.bank_account_holder && (
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#4a7ab5' }}>{lang === 'zh' ? '戶名' : 'Account Name'}</span>
                <span style={{ fontWeight: 600 }}>{bank.bank_account_holder}</span>
              </div>
            )}
          </>
        ) : (
          <div style={{ color: '#4a7ab5' }}>
            {lang === 'zh' ? '匯款帳號請洽客服取得。' : 'Please contact us for transfer account details.'}
          </div>
        )}
        {order?.remittance_last5 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
            <span style={{ color: '#4a7ab5' }}>{t('order.remittance_last5')}</span>
            <span style={{ fontWeight: 600 }}>{order.remittance_last5}</span>
          </div>
        )}
      </div>

      {/* 截圖提醒 */}
      <div style={{
        background: '#fff8e8',
        border: '0.5px solid #f0d68a',
        borderRadius: 12,
        padding: '16px 20px',
        marginBottom: 20,
        fontSize: 14,
        color: '#8a5c00',
        lineHeight: 1.8,
        textAlign: 'left',
      }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>
          ⚠️ {lang === 'zh' ? '付款提醒' : 'Payment Reminder'}
        </div>
        <div>{t('order.remittance_reminder')}</div>
      </div>

      <div className="order-no-card">
        <div className="order-no-label">{t('order.order_no')}</div>
        <div className="order-no-value">{order?.id ? `#${String(order.id).slice(-8).toUpperCase()}` : '…'}</div>
      </div>

      {order && (
        <div style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 14, padding: 20, marginBottom: 20, textAlign: 'left' }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>{t('order.items')}</div>
          <div style={{ fontSize: 14, color: 'var(--text-2)', lineHeight: 1.8 }}>{order.items}</div>
          {Number(order.discount_amount) > 0 && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '0.5px solid var(--border-light)', display: 'flex', justifyContent: 'space-between', fontSize: 14, color: '#1a7a3c' }}>
              <span>{lang === 'zh' ? '優惠券折抵' : 'Coupon discount'}</span>
              <span>-NT${Number(order.discount_amount).toLocaleString()}</span>
            </div>
          )}
          <div style={{ marginTop: Number(order.discount_amount) > 0 ? 8 : 12, paddingTop: Number(order.discount_amount) > 0 ? 0 : 12, borderTop: Number(order.discount_amount) > 0 ? 'none' : '0.5px solid var(--border-light)', display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 16 }}>
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
