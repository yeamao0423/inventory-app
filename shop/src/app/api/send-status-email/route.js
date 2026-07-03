import { Resend } from 'resend'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getStoreEmailBranding } from '../../../lib/emailBranding'
import { escapeHtml as esc } from '../../../lib/escapeHtml'

const resend = new Resend(process.env.RESEND_API_KEY)

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
}

export async function OPTIONS() {
  return NextResponse.json(null, { headers: corsHeaders })
}

export async function POST(request) {
  const { order, activeItems, cancelledItems, shippingFee, newTotal, fulfillment_type, trackingNumber, lang, storeId } = await request.json().catch(() => ({}))
  const zh = lang !== 'en'

  console.log(`[send-status-email] type=${fulfillment_type} order=${order?.id} active=${activeItems?.length} cancelled=${cancelledItems?.length} total=${newTotal}`)

  // P0-1：後台（已登入員工）才可觸發。用呼叫者的 Supabase JWT 驗身分＋店家角色，
  //       收件人一律以 DB 訂單的 email 為準（不信前端傳入），杜絕匿名開放中繼。
  const jwt = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  if (!jwt || storeId == null || order?.id == null) {
    return NextResponse.json({ error: 'missing token / storeId / order id' }, { status: 400, headers: corsHeaders })
  }
  if (!SUPA_URL || !ANON) {
    return NextResponse.json({ error: 'server not configured' }, { status: 500, headers: corsHeaders })
  }

  const sb = createClient(SUPA_URL, ANON, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  })

  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: corsHeaders })

  const { data: role } = await sb
    .from('user_store_roles').select('role')
    .eq('user_id', user.id).eq('store_id', storeId)
    .in('role', ['super_admin', 'admin', 'editor'])
    .maybeSingle()
  if (!role) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: corsHeaders })

  // 收件人取自 DB（RLS 確保此員工看得到該店訂單）；查不到或跨店 → 拒絕
  const { data: orderRow } = await sb
    .from('consumer_orders').select('email, store_id')
    .eq('id', order.id).maybeSingle()
  if (!orderRow || orderRow.store_id !== storeId || !orderRow.email) {
    return NextResponse.json({ error: 'order not found' }, { status: 403, headers: corsHeaders })
  }
  const recipient = orderRow.email

  // 依訂單店家動態帶入品牌名與客服聯絡
  const brand = await getStoreEmailBranding(storeId)
  const storeName = brand.name

  const orderNo = order.id?.toString().slice(-6)
  const tag = zh ? `【${storeName}】` : `${storeName} · `

  const subjectMap = {
    full:              zh ? `${tag}【已出貨】訂單 #${orderNo} 已全數出貨` : `${tag}[Shipped] Order #${orderNo} has shipped`,
    partial:           zh ? `${tag}【部分出貨】訂單 #${orderNo} 處理結果通知` : `${tag}[Partial Shipment] Order #${orderNo} update`,
    cancelled:         zh ? `${tag}【訂單取消】訂單 #${orderNo} 已全數取消` : `${tag}[Cancelled] Order #${orderNo} has been cancelled`,
    payment_received:  zh ? `${tag}【已收款】訂單 #${orderNo} 款項已確認` : `${tag}[Payment Received] Order #${orderNo} payment confirmed`,
    order_modified:    zh ? `${tag}【訂單修改】訂單 #${orderNo} 內容已更新` : `${tag}[Order Updated] Order #${orderNo} has been modified`,
  }
  const subject = subjectMap[fulfillment_type] || subjectMap.full

  function renderItems(items, isCancelled = false) {
    return (items || []).map(item => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #f0f0ea;vertical-align:top;${isCancelled ? 'opacity:0.5;' : ''}">
          <div style="font-size:14px;font-weight:600;color:#1a1a1a;${isCancelled ? 'text-decoration:line-through;' : ''}">${esc(item.name)}</div>
          ${item.color || item.size
            ? `<div style="font-size:12px;color:#888;">${esc([item.color, item.size].filter(Boolean).join(' / '))}</div>`
            : ''}
        </td>
        <td style="padding:10px 0;border-bottom:1px solid #f0f0ea;text-align:right;vertical-align:top;white-space:nowrap;padding-left:12px;">
          <div style="font-size:12px;color:#888;">&times; ${item.qty}</div>
          <div style="font-size:14px;font-weight:600;color:${isCancelled ? '#aaa' : '#1a1a1a'};">NT$${(item.price * item.qty).toLocaleString()}</div>
        </td>
      </tr>
    `).join('')
  }

  let bodyHtml = ''

  const trackingHtml = trackingNumber ? `
      <div style="background:#f5f5ff;border-radius:12px;padding:14px 18px;margin-bottom:24px;">
        <div style="font-size:13px;color:#666;margin-bottom:4px;">${zh ? '📦 物流追蹤單號' : '📦 Tracking Number'}</div>
        <div style="font-size:16px;font-weight:700;color:#1a1a1a;letter-spacing:0.5px;">${esc(trackingNumber)}</div>
      </div>
  ` : ''

  if (fulfillment_type === 'payment_received') {
    bodyHtml = `
      <div style="background:#f0fff4;border-radius:12px;padding:16px 20px;margin-bottom:24px;text-align:center;">
        <div style="font-size:32px;margin-bottom:8px;">&#9989;</div>
        <div style="font-size:16px;font-weight:700;color:#1a7a3a;">${zh ? '您的款項已確認收到！' : 'Your payment has been received!'}</div>
      </div>
      <div style="background:#fafaf8;border-radius:12px;padding:16px 20px;margin-bottom:24px;">
        <div style="font-size:14px;color:#555;line-height:1.7;">
          ${zh
            ? '感謝您的付款，我們將盡快為您處理訂單並安排出貨，届時會再寄出出貨通知。'
            : 'Thank you for your payment! We will process your order and arrange shipment as soon as possible. A shipping notification will follow.'}
        </div>
      </div>
      <div style="font-size:13px;font-weight:600;color:#999;margin-bottom:10px;">${zh ? '訂購商品' : 'Ordered Items'}</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
        ${renderItems(activeItems)}
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
        <tr>
          <td style="padding:12px 0;border-top:1.5px solid #1a1a1a;">
            <span style="font-size:15px;font-weight:700;">${zh ? '總金額' : 'Total'}</span>
          </td>
          <td style="padding:12px 0;border-top:1.5px solid #1a1a1a;text-align:right;">
            <span style="font-size:18px;font-weight:700;">NT$${(newTotal || 0).toLocaleString()}</span>
          </td>
        </tr>
      </table>
    `
  } else if (fulfillment_type === 'order_modified') {
    bodyHtml = `
      <div style="background:#fff8e8;border-radius:12px;padding:16px 20px;margin-bottom:24px;text-align:center;">
        <div style="font-size:32px;margin-bottom:8px;">&#128221;</div>
        <div style="font-size:16px;font-weight:700;color:#8a5c00;">${zh ? '您的訂單內容已更新' : 'Your order has been updated'}</div>
      </div>
      <div style="font-size:13px;font-weight:600;color:#1a7a3a;margin-bottom:10px;">&#10004; ${zh ? '目前商品' : 'Current Items'}</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
        ${renderItems(activeItems)}
      </table>
      ${(cancelledItems || []).length > 0 ? `
        <div style="font-size:13px;font-weight:600;color:#cc3333;margin-bottom:10px;">&#10005; ${zh ? '取消商品（缺貨）' : 'Cancelled Items (Out of Stock)'}</div>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
          ${renderItems(cancelledItems, true)}
        </table>
      ` : ''}
      ${shippingFee > 0 ? `
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
        <tr>
          <td style="font-size:13px;color:#999;padding:6px 0;">${zh ? '運費' : 'Shipping'}</td>
          <td style="text-align:right;font-size:13px;color:#999;padding:6px 0;">NT$${shippingFee.toLocaleString()}</td>
        </tr>
      </table>` : ''}
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
        <tr>
          <td style="padding:12px 0;border-top:1.5px solid #1a1a1a;">
            <span style="font-size:15px;font-weight:700;">${zh ? '更新後總金額' : 'Updated Total'}</span>
          </td>
          <td style="padding:12px 0;border-top:1.5px solid #1a1a1a;text-align:right;">
            <span style="font-size:18px;font-weight:700;">NT$${(newTotal || 0).toLocaleString()}</span>
          </td>
        </tr>
      </table>
      <div style="background:#fafaf8;border-radius:12px;padding:14px 18px;margin-bottom:16px;">
        <div style="font-size:13px;color:#666;line-height:1.7;">
          ${zh
            ? '如有任何疑問，請透過 LINE 或 Email 與我們聯繫。'
            : 'If you have any questions, please contact us via LINE or Email.'}
        </div>
      </div>
    `
  } else if (fulfillment_type === 'full') {
    bodyHtml = `
      <div style="background:#f0fff4;border-radius:12px;padding:16px 20px;margin-bottom:24px;text-align:center;">
        <div style="font-size:32px;margin-bottom:8px;">&#127881;</div>
        <div style="font-size:16px;font-weight:700;color:#1a7a3a;">${zh ? '您的商品已全數出貨！' : 'Your order has shipped!'}</div>
      </div>
      ${trackingHtml}
      <div style="font-size:13px;font-weight:600;color:#999;margin-bottom:10px;">${zh ? '出貨商品' : 'Shipped Items'}</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
        ${renderItems(activeItems)}
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
        <tr>
          <td style="padding:12px 0;border-top:1.5px solid #1a1a1a;">
            <span style="font-size:15px;font-weight:700;">${zh ? '總金額' : 'Total'}</span>
          </td>
          <td style="padding:12px 0;border-top:1.5px solid #1a1a1a;text-align:right;">
            <span style="font-size:18px;font-weight:700;">NT$${(newTotal || 0).toLocaleString()}</span>
          </td>
        </tr>
      </table>
    `
  } else if (fulfillment_type === 'partial') {
    bodyHtml = `
      <div style="background:#fff8e8;border-radius:12px;padding:16px 20px;margin-bottom:24px;">
        <div style="font-size:15px;font-weight:700;color:#8a5c00;margin-bottom:4px;">
          ${zh ? '&#9888;&#65039; 部分商品出貨通知' : '&#9888;&#65039; Partial Shipment Notice'}
        </div>
        <div style="font-size:13px;color:#8a5c00;line-height:1.6;">
          ${zh
            ? '因部分商品庫存不足，以下為出貨與取消明細。取消商品將另行安排退款，造成不便敬請見諒。'
            : 'Some items were out of stock. Please see the shipment and cancellation details below. Refunds for cancelled items will be arranged separately.'}
        </div>
      </div>
      ${trackingHtml}
      <div style="font-size:13px;font-weight:600;color:#1a7a3a;margin-bottom:10px;">&#10004; ${zh ? '出貨商品' : 'Shipped Items'}</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
        ${renderItems(activeItems)}
      </table>
      ${shippingFee > 0 ? `
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
        <tr>
          <td style="font-size:13px;color:#999;padding:6px 0;">${zh ? '運費' : 'Shipping'}</td>
          <td style="text-align:right;font-size:13px;color:#999;padding:6px 0;">NT$${shippingFee.toLocaleString()}</td>
        </tr>
      </table>` : ''}
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
        <tr>
          <td style="padding:12px 0;border-top:1.5px solid #1a1a1a;">
            <span style="font-size:15px;font-weight:700;">${zh ? '更新後總金額' : 'Updated Total'}</span>
          </td>
          <td style="padding:12px 0;border-top:1.5px solid #1a1a1a;text-align:right;">
            <span style="font-size:18px;font-weight:700;">NT$${(newTotal || 0).toLocaleString()}</span>
          </td>
        </tr>
      </table>
      <div style="font-size:13px;font-weight:600;color:#cc3333;margin-bottom:10px;">&#10005; ${zh ? '取消商品（缺貨）' : 'Cancelled Items (Out of Stock)'}</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
        ${renderItems(cancelledItems, true)}
      </table>
    `
  } else if (fulfillment_type === 'cancelled') {
    bodyHtml = `
      <div style="background:#fff5f5;border-radius:12px;padding:16px 20px;margin-bottom:24px;text-align:center;">
        <div style="font-size:32px;margin-bottom:8px;">&#128532;</div>
        <div style="font-size:16px;font-weight:700;color:#cc3333;">${zh ? '很遺憾，本筆訂單已全數取消' : "We're sorry — your order has been cancelled"}</div>
      </div>
      <div style="background:#fafaf8;border-radius:12px;padding:16px 20px;margin-bottom:24px;">
        <div style="font-size:14px;color:#555;line-height:1.7;">
          ${zh
            ? '由於本次採購商品全數缺貨，訂單已取消。退款將由我們以人工方式處理，請稍待通知，造成不便敬請見諒。'
            : 'Due to stock unavailability, your entire order has been cancelled. Refunds will be processed manually — we will notify you shortly. We apologize for the inconvenience.'}
        </div>
      </div>
      <div style="font-size:13px;font-weight:600;color:#999;margin-bottom:10px;">${zh ? '取消商品' : 'Cancelled Items'}</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
        ${renderItems(cancelledItems, true)}
      </table>
    `
  }

  // 退款提醒（部分取消或全數取消時加入）
  if (fulfillment_type === 'partial' || fulfillment_type === 'cancelled') {
    bodyHtml += `
      <div style="background:#fafaf8;border-radius:12px;padding:14px 18px;margin-bottom:16px;">
        <div style="font-size:13px;color:#666;line-height:1.7;">
          ${zh
            ? '&#128176; 取消商品的退款將由我們以人工方式處理，會再透過 LINE 或 Email 與您聯繫，請留意通知。'
            : '&#128176; Refunds for cancelled items will be processed manually. We will contact you via LINE or Email — please keep an eye out for our message.'}
        </div>
      </div>
    `
  }

  // footer 客服聯絡：店家有填才顯示對應項目
  const contactParts = []
  if (brand.contactLine) contactParts.push(`LINE：<a href="${brand.contactLine}" style="color:#aaa;">${brand.contactLine.replace(/^https?:\/\/line\.me\/R\/ti\/p\//, '')}</a>`)
  if (brand.contactEmail) contactParts.push(`Email：<a href="mailto:${brand.contactEmail}" style="color:#aaa;">${brand.contactEmail}</a>`)
  const contactLineHtml = contactParts.length
    ? `${zh ? '如有任何問題，歡迎透過以下方式聯繫我們：' : 'If you have any questions, feel free to contact us:'}<br>${contactParts.join('&nbsp;&nbsp;|&nbsp;&nbsp;')}<br><br>`
    : ''
  const footerHtml = `${contactLineHtml}© 2026 ${esc(storeName)}. All rights reserved.`

  const html = `<!DOCTYPE html>
<html lang="${zh ? 'zh-TW' : 'en'}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#fafaf8;font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafaf8;padding:40px 0;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td style="background:#1a1a1a;border-radius:16px 16px 0 0;padding:28px 32px;text-align:center;">
          <div style="font-size:22px;font-weight:700;color:#fff;letter-spacing:-0.5px;">${esc(storeName)}</div>
          <div style="font-size:13px;color:rgba(255,255,255,0.5);margin-top:4px;">${zh ? '訂單' : 'Order'} #${orderNo}</div>
        </td></tr>
        <tr><td style="background:#fff;padding:32px;border-left:0.5px solid #e8e8e0;border-right:0.5px solid #e8e8e0;">
          ${bodyHtml}
        </td></tr>
        <tr><td style="background:#f0f0ea;border-radius:0 0 16px 16px;padding:20px 32px;text-align:center;border:0.5px solid #e8e8e0;border-top:none;">
          <div style="font-size:12px;color:#aaa;line-height:1.7;">
            ${footerHtml}
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`

  const { error } = await resend.emails.send({
    from: `${storeName} <no-reply@daigogotw.com>`,
    to: recipient,
    subject,
    html,
  })

  if (error) {
    console.error('Resend error:', error)
    return NextResponse.json({ error }, { status: 500, headers: corsHeaders })
  }

  return NextResponse.json({ success: true }, { headers: corsHeaders })
}
