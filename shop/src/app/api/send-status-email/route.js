import { Resend } from 'resend'
import { NextResponse } from 'next/server'

const resend = new Resend(process.env.RESEND_API_KEY)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function OPTIONS() {
  return NextResponse.json(null, { headers: corsHeaders })
}

export async function POST(request) {
  const { order, activeItems, cancelledItems, shippingFee, newTotal, fulfillment_type, lang } = await request.json()
  const zh = lang !== 'en'

  console.log(`[send-status-email] type=${fulfillment_type} to=${order?.email} active=${activeItems?.length} cancelled=${cancelledItems?.length} total=${newTotal}`)

  if (!order?.email) {
    return NextResponse.json({ error: 'Missing email' }, { status: 400, headers: corsHeaders })
  }

  const orderNo = order.id?.toString().slice(-6)

  const subjectMap = {
    full:      zh ? `【已出貨】訂單 #${orderNo} 已全數出貨` : `[Shipped] Order #${orderNo} has shipped`,
    partial:   zh ? `【部分出貨】訂單 #${orderNo} 處理結果通知` : `[Partial Shipment] Order #${orderNo} update`,
    cancelled: zh ? `【訂單取消】訂單 #${orderNo} 已全數取消` : `[Cancelled] Order #${orderNo} has been cancelled`,
  }
  const subject = subjectMap[fulfillment_type] || subjectMap.full

  function renderItems(items, isCancelled = false) {
    return (items || []).map(item => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #f0f0ea;vertical-align:top;${isCancelled ? 'opacity:0.5;' : ''}">
          <div style="font-size:14px;font-weight:600;color:#1a1a1a;${isCancelled ? 'text-decoration:line-through;' : ''}">${item.name}</div>
          ${item.color || item.size
            ? `<div style="font-size:12px;color:#888;">${[item.color, item.size].filter(Boolean).join(' / ')}</div>`
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

  if (fulfillment_type === 'full') {
    bodyHtml = `
      <div style="background:#f0fff4;border-radius:12px;padding:16px 20px;margin-bottom:24px;text-align:center;">
        <div style="font-size:32px;margin-bottom:8px;">&#127881;</div>
        <div style="font-size:16px;font-weight:700;color:#1a7a3a;">${zh ? '您的商品已全數出貨！' : 'Your order has shipped!'}</div>
      </div>
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

  const html = `<!DOCTYPE html>
<html lang="${zh ? 'zh-TW' : 'en'}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#fafaf8;font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafaf8;padding:40px 0;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td style="background:#1a1a1a;border-radius:16px 16px 0 0;padding:28px 32px;text-align:center;">
          <div style="font-size:22px;font-weight:700;color:#fff;letter-spacing:-0.5px;">&#128230; Shop</div>
          <div style="font-size:13px;color:rgba(255,255,255,0.5);margin-top:4px;">${zh ? '訂單' : 'Order'} #${orderNo}</div>
        </td></tr>
        <tr><td style="background:#fff;padding:32px;border-left:0.5px solid #e8e8e0;border-right:0.5px solid #e8e8e0;">
          ${bodyHtml}
        </td></tr>
        <tr><td style="background:#f0f0ea;border-radius:0 0 16px 16px;padding:20px 32px;text-align:center;border:0.5px solid #e8e8e0;border-top:none;">
          <div style="font-size:12px;color:#aaa;line-height:1.7;">
            ${zh
              ? '如有任何問題，歡迎透過以下方式聯繫我們：<br>LINE：<a href="https://line.me/R/ti/p/@705wgspe" style="color:#aaa;">@705wgspe</a>&nbsp;&nbsp;|&nbsp;&nbsp;Email：<a href="mailto:daigogosg@gmail.com" style="color:#aaa;">daigogosg@gmail.com</a><br><br>&copy; 2026 Daigo. All rights reserved.'
              : 'If you have any questions, feel free to contact us:<br>LINE: <a href="https://line.me/R/ti/p/@705wgspe" style="color:#aaa;">@705wgspe</a>&nbsp;&nbsp;|&nbsp;&nbsp;Email: <a href="mailto:daigogosg@gmail.com" style="color:#aaa;">daigogosg@gmail.com</a><br><br>&copy; 2026 Daigo. All rights reserved.'}
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`

  const { error } = await resend.emails.send({
    from: 'Daigo Shop <no-reply@daigogotw.com>',
    to: order.email,
    subject,
    html,
  })

  if (error) {
    console.error('Resend error:', error)
    return NextResponse.json({ error }, { status: 500, headers: corsHeaders })
  }

  return NextResponse.json({ success: true }, { headers: corsHeaders })
}
