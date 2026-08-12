'use client'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '../../../lib/supabase'
import { getStore } from '../../../lib/store'
import { useI18n, useCart } from '../../layout'
import { formatDeadline, appendInfoFor } from '../../../lib/append'

// payment_method → 顯示標籤；未知值（或欄位缺值，見 get_consumer_order）回 null 讓呼叫端隱藏該列
function paymentMethodLabel(pm, lang) {
  if (pm === 'credit') return lang === 'zh' ? '信用卡' : 'Credit Card'
  if (pm === 'cod') return lang === 'zh' ? '貨到付款' : 'Cash on Delivery'
  if (pm === 'remittance') return lang === 'zh' ? '銀行匯款' : 'Bank Transfer'
  return null
}

export default function OrderSuccessPage() {
  // 路由參數雖名為 id，實為不可猜的 public_token（見 20250031 migration）。
  const { id: token } = useParams()
  const { t, lang } = useI18n()
  const { startAppend } = useCart()
  const router = useRouter()
  const [order, setOrder] = useState(null)
  const [store, setStore] = useState(null)

  function goAppend() {
    startAppend(appendInfoFor(order, token))
    router.push('/products')
  }

  useEffect(() => {
    supabase.rpc('get_consumer_order', { p_token: token })
      .then(({ data }) => setOrder(data))
    getStore().then(setStore).catch(() => {})
  }, [token])

  const bank = store?.settings?.bank_account ? store.settings : null
  // 匯款資訊／匯款提醒只給匯款訂單看；payment_method 缺值（例如舊資料、RPC 尚未回傳）一律視為匯款，維持原行為
  const isRemittance = !order || (order.payment_method !== 'credit' && order.payment_method !== 'cod')
  const canRepay = !!order && order.payment_method === 'credit'
    && Number(order.paid_amount || 0) < Number(order.total_amount || 0)
    && order.status !== '已取消'

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

      {isRemittance && (
        <>
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
        </>
      )}

      {/* 超商門市（cod／credit 走超商取貨時才有值） */}
      {order?.cvs_store_name && order?.cvs_store_id && (
        <div style={{
          background: 'var(--surface)', border: '0.5px solid var(--border)',
          borderRadius: 12, padding: '16px 20px', marginBottom: 16,
          fontSize: 14, lineHeight: 1.8, textAlign: 'left',
        }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>
            🏪 {lang === 'zh' ? '取貨門市' : 'Pickup Store'}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--text-2)' }}>{lang === 'zh' ? '門市' : 'Store'}</span>
            <span style={{ fontWeight: 600 }}>{order.cvs_store_name}（{order.cvs_store_id}）</span>
          </div>
        </div>
      )}

      {/* 物流狀態（綠界背景通知回填後才有值） */}
      {order?.logistics_status_msg && (
        <div style={{
          background: 'var(--surface)', border: '0.5px solid var(--border)',
          borderRadius: 12, padding: '16px 20px', marginBottom: 16,
          fontSize: 14, lineHeight: 1.8, textAlign: 'left',
        }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>
            🚚 {lang === 'zh' ? '物流狀態' : 'Shipping Status'}
          </div>
          <div>{order.logistics_status_msg}</div>
        </div>
      )}

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
          {paymentMethodLabel(order.payment_method, lang) && (
            <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', fontSize: 14, color: 'var(--text-2)' }}>
              <span>{lang === 'zh' ? '付款方式' : 'Payment Method'}</span>
              <span style={{ fontWeight: 600 }}>{paymentMethodLabel(order.payment_method, lang)}</span>
            </div>
          )}
          {Number(order.paid_amount) > 0 && Number(order.balance_due) !== 0 && (
            <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', fontSize: 14, color: Number(order.balance_due) > 0 ? 'var(--amber, #b45309)' : '#1a7a3c' }}>
              <span>{Number(order.balance_due) > 0
                ? (lang === 'zh' ? '尚需補匯' : 'Balance due')
                : (lang === 'zh' ? '待退款' : 'Refund due')}</span>
              <span>NT${Math.abs(Number(order.balance_due)).toLocaleString()}</span>
            </div>
          )}
        </div>
      )}

      {/* 重新付款：信用卡棄單想再付、或加購後補差額，兩者共用同一個入口 */}
      {canRepay && (
        <div style={{
          background: 'var(--surface)', border: '0.5px solid var(--border)',
          borderRadius: 14, padding: 20, marginBottom: 20, textAlign: 'left',
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
            {lang === 'zh' ? '這筆訂單尚未付款完成' : 'This order is not fully paid'}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.7, marginBottom: 12 }}>
            {lang === 'zh'
              ? '可能是刷卡中斷未完成，或加購後產生差額，點下方按鈕繼續付款。'
              : 'Payment may have been interrupted, or a balance is due after adding items. Continue below.'}
          </div>
          <a href={`/api/ecpay/credit/${order.id}`} className="btn-primary" style={{
            display: 'block', textAlign: 'center', padding: '11px 0', borderRadius: 10,
            fontSize: 14, fontWeight: 600,
          }}>
            {lang === 'zh' ? '重新付款' : 'Pay Now'}
          </a>
        </div>
      )}

      {/* 加購入口：老闆尚未開始採購、且還在加購窗口內才出現 */}
      {order?.can_append && (
        <div style={{
          background: 'var(--surface)', border: '0.5px solid var(--border)',
          borderRadius: 14, padding: 20, marginBottom: 20, textAlign: 'left',
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
            {lang === 'zh' ? '還想再買點什麼？' : 'Want to add more?'}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.7, marginBottom: 12 }}>
            {lang === 'zh'
              ? <>可加購至 <strong>{formatDeadline(order.append_deadline, lang)}</strong>，加購商品會與本單一起出貨，運費不會重複計算。</>
              : <>You can add items until <strong>{formatDeadline(order.append_deadline, lang)}</strong>. They ship together with this order — no extra shipping.</>}
          </div>
          <button onClick={goAppend} style={{
            width: '100%', padding: '11px 0', borderRadius: 10,
            border: '0.5px solid var(--text-1, #111)', background: 'transparent',
            fontSize: 14, fontWeight: 600, cursor: 'pointer', color: 'inherit',
          }}>
            {lang === 'zh' ? '＋ 加購到這筆訂單' : '＋ Add items to this order'}
          </button>
        </div>
      )}

      <div className="contact-note">{t('order.contact')}</div>

      <Link href="/" className="btn-primary" style={{ display: 'inline-block', padding: '14px 32px', borderRadius: 12 }}>
        {t('order.back_home')}
      </Link>
    </div>
  )
}
