import { Resend } from 'resend'
import { NextResponse } from 'next/server'
import { getStoreEmailBranding } from '../../../lib/emailBranding'

const resend = new Resend(process.env.RESEND_API_KEY)

export async function POST(request) {
  const { order, items, total, discount, couponName, lang, notifyEmail, storeId } = await request.json()
  const zh = lang !== 'en'

  if (!order?.email) {
    return NextResponse.json({ error: 'Missing email' }, { status: 400 })
  }

  // 依下單店家動態帶入品牌名、匯款資訊、客服聯絡與店家通知信箱
  const brand = await getStoreEmailBranding(storeId)
  const storeName = brand.name

  const orderNo = order.id?.toString().slice(-6)
  const subject = zh
    ? `【${storeName}】訂單確認 #${orderNo} — 感謝您的訂購！`
    : `${storeName} · Order Confirmed #${orderNo} — Thank you!`

  const itemsRows = (items || []).map(item => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #f0f0ea;vertical-align:top;">
        <div style="font-size:15px;font-weight:600;color:#1a1a1a;margin-bottom:3px;">${item.name}</div>
        ${item.color || item.size
          ? `<div style="font-size:13px;color:#888;margin-bottom:2px;">${[item.color, item.size].filter(Boolean).join(' / ')}</div>`
          : ''}
        ${item.customNote
          ? `<div style="font-size:12px;color:#aaa;">${zh ? '備註：' : 'Note: '}${item.customNote}</div>`
          : ''}
      </td>
      <td style="padding:12px 0;border-bottom:1px solid #f0f0ea;text-align:right;vertical-align:top;white-space:nowrap;padding-left:16px;">
        <div style="font-size:13px;color:#888;">× ${item.qty}</div>
        <div style="font-size:15px;font-weight:600;color:#1a1a1a;">NT$${(item.price * item.qty).toLocaleString()}</div>
      </td>
    </tr>
  `).join('')

  // 匯款資訊：店家有設定才顯示帳號；未設定則提示洽客服，絕不露出其他店家帳號
  const bankRowsHtml = brand.bank
    ? `
              <tr>
                <td style="font-size:13px;color:#4a7ab5;padding:4px 0;width:80px;">${zh ? '銀行' : 'Bank'}</td>
                <td style="font-size:14px;color:#1e4d8c;padding:4px 0;font-weight:600;">${brand.bank.name}${brand.bank.code ? ` (${brand.bank.code})` : ''}</td>
              </tr>
              <tr>
                <td style="font-size:13px;color:#4a7ab5;padding:4px 0;">${zh ? '帳號' : 'Account'}</td>
                <td style="font-size:16px;color:#1e4d8c;padding:4px 0;font-weight:700;letter-spacing:1px;">${brand.bank.account}</td>
              </tr>
              ${brand.bank.holder ? `
              <tr>
                <td style="font-size:13px;color:#4a7ab5;padding:4px 0;">${zh ? '戶名' : 'Account Name'}</td>
                <td style="font-size:14px;color:#1e4d8c;padding:4px 0;font-weight:600;">${brand.bank.holder}</td>
              </tr>` : ''}
              ${order.remittance_last5 ? `
              <tr>
                <td style="font-size:13px;color:#4a7ab5;padding:4px 0;">${zh ? '您的末五碼' : 'Your last 5'}</td>
                <td style="font-size:14px;color:#1e4d8c;padding:4px 0;font-weight:600;">${order.remittance_last5}</td>
              </tr>` : ''}`
    : `
              <tr>
                <td colspan="2" style="font-size:14px;color:#4a7ab5;padding:4px 0;line-height:1.6;">
                  ${zh ? '匯款帳號請洽客服取得。' : 'Please contact us for transfer account details.'}
                </td>
              </tr>`

  // footer 客服聯絡：店家有填才顯示對應項目
  const contactParts = []
  if (brand.contactLine) contactParts.push(`LINE：<a href="${brand.contactLine}" style="color:#aaa;">${brand.contactLine.replace(/^https?:\/\/line\.me\/R\/ti\/p\//, '')}</a>`)
  if (brand.contactEmail) contactParts.push(`Email：<a href="mailto:${brand.contactEmail}" style="color:#aaa;">${brand.contactEmail}</a>`)
  const contactLineHtml = contactParts.length
    ? `${zh ? '如有任何問題，歡迎透過以下方式聯繫我們：' : 'If you have any questions, feel free to contact us:'}<br>${contactParts.join('&nbsp;&nbsp;|&nbsp;&nbsp;')}<br><br>`
    : ''
  const footerHtml = `${contactLineHtml}© 2026 ${storeName}. All rights reserved.`

  const html = `<!DOCTYPE html>
<html lang="${zh ? 'zh-TW' : 'en'}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#fafaf8;font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;">

  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafaf8;padding:40px 0;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">

        <!-- Header -->
        <tr><td style="background:#1a1a1a;border-radius:16px 16px 0 0;padding:28px 32px;text-align:center;">
          <div style="font-size:22px;font-weight:700;color:#fff;letter-spacing:-0.5px;">${storeName}</div>
          <div style="font-size:14px;color:rgba(255,255,255,0.6);margin-top:6px;">
            ${zh ? '感謝您的訂購！' : 'Thank you for your order!'}
          </div>
        </td></tr>

        <!-- Body -->
        <tr><td style="background:#fff;padding:32px;border-left:0.5px solid #e8e8e0;border-right:0.5px solid #e8e8e0;">

          <!-- Order number -->
          <div style="background:#fafaf8;border-radius:12px;padding:16px 20px;margin-bottom:24px;text-align:center;">
            <div style="font-size:12px;color:#999;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;">
              ${zh ? '訂單編號' : 'Order Number'}
            </div>
            <div style="font-size:24px;font-weight:700;color:#1a1a1a;letter-spacing:1px;">#${orderNo}</div>
          </div>

          <!-- Items -->
          <div style="font-size:13px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px;">
            ${zh ? '訂購商品' : 'Items'}
          </div>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
            ${itemsRows}
          </table>

          <!-- Total -->
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
            ${discount > 0 ? `
            <tr>
              <td style="padding:8px 0;border-top:1px solid #e8e8e0;">
                <span style="font-size:14px;color:#888;">${zh ? '小計' : 'Subtotal'}</span>
              </td>
              <td style="padding:8px 0;border-top:1px solid #e8e8e0;text-align:right;">
                <span style="font-size:14px;color:#888;">NT$${(total + discount).toLocaleString()}</span>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 0;">
                <span style="font-size:14px;color:#1a7a3a;">${couponName || (zh ? '優惠折扣' : 'Discount')}</span>
              </td>
              <td style="padding:8px 0;text-align:right;">
                <span style="font-size:14px;font-weight:600;color:#1a7a3a;">-NT$${discount.toLocaleString()}</span>
              </td>
            </tr>
            ` : ''}
            <tr>
              <td style="padding:14px 0;border-top:1.5px solid #1a1a1a;">
                <span style="font-size:16px;font-weight:700;color:#1a1a1a;">${zh ? '總金額' : 'Total'}</span>
              </td>
              <td style="padding:14px 0;border-top:1.5px solid #1a1a1a;text-align:right;">
                <span style="font-size:20px;font-weight:700;color:#1a1a1a;">NT$${total.toLocaleString()}</span>
              </td>
            </tr>
          </table>

          <!-- Shipping info -->
          <div style="font-size:13px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px;">
            ${zh ? '收件資訊' : 'Pickup Info'}
          </div>
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafaf8;border-radius:12px;padding:16px 20px;margin-bottom:24px;">
            <tr>
              <td style="font-size:13px;color:#999;padding:4px 0;width:80px;">${zh ? '姓名' : 'Name'}</td>
              <td style="font-size:14px;color:#1a1a1a;padding:4px 0;font-weight:500;">${order.name}</td>
            </tr>
            <tr>
              <td style="font-size:13px;color:#999;padding:4px 0;">${zh ? '電話' : 'Phone'}</td>
              <td style="font-size:14px;color:#1a1a1a;padding:4px 0;">${order.phone}</td>
            </tr>
            <tr>
              <td style="font-size:13px;color:#999;padding:4px 0;">${zh ? '取貨門市' : 'Store'}</td>
              <td style="font-size:14px;color:#1a1a1a;padding:4px 0;">${order.store_name || ''} (${order.store_number || ''})</td>
            </tr>
            ${order.note ? `
            <tr>
              <td style="font-size:13px;color:#999;padding:4px 0;">${zh ? '備註' : 'Note'}</td>
              <td style="font-size:14px;color:#1a1a1a;padding:4px 0;">${order.note}</td>
            </tr>` : ''}
          </table>

          <!-- Bank transfer info -->
          <div style="font-size:13px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px;">
            ${zh ? '匯款資訊' : 'Bank Transfer Info'}
          </div>
          <div style="background:#f0f7ff;border-radius:12px;padding:16px 20px;margin-bottom:16px;">
            <table width="100%" cellpadding="0" cellspacing="0">${bankRowsHtml}
            </table>
          </div>

          <!-- Payment reminder -->
          <div style="background:#fff8e8;border-radius:12px;padding:16px 20px;margin-bottom:8px;">
            <div style="font-size:14px;font-weight:700;color:#8a5c00;margin-bottom:6px;">
              ⚠️ ${zh ? '付款提醒' : 'Payment Reminder'}
            </div>
            <div style="font-size:14px;color:#8a5c00;line-height:1.7;">
              ${zh
                ? '請將<strong>匯款截圖</strong>與<strong>訂單編號 #' + orderNo + '</strong> 傳給客服，以便我們加速核對款項。'
                : 'Please send your <strong>transfer screenshot</strong> and <strong>order number #' + orderNo + '</strong> to our customer service for faster payment verification.'}
            </div>
          </div>

        </td></tr>

        <!-- Footer -->
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
    to: order.email,
    subject,
    html,
  })

  if (error) {
    console.error('Resend error:', error)
    return NextResponse.json({ error }, { status: 500 })
  }

  // ── 通知店家 ──────────────────────────────────────────
  const notifyItemsRows = (items || []).map(item => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #f0f0ea;font-size:14px;color:#1a1a1a;">
        ${item.name}
        ${item.color || item.size ? `<span style="color:#888;"> (${[item.color, item.size].filter(Boolean).join(' / ')})</span>` : ''}
      </td>
      <td style="padding:8px 0;border-bottom:1px solid #f0f0ea;text-align:center;font-size:14px;color:#1a1a1a;">× ${item.qty}</td>
      <td style="padding:8px 0;border-bottom:1px solid #f0f0ea;text-align:right;font-size:14px;font-weight:600;color:#1a1a1a;">NT$${(item.price * item.qty).toLocaleString()}</td>
    </tr>
  `).join('')

  const notifyHtml = `<!DOCTYPE html>
<html lang="zh-TW">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#fafaf8;font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafaf8;padding:40px 0;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td style="background:#1a1a1a;border-radius:16px 16px 0 0;padding:24px 32px;text-align:center;">
          <div style="font-size:20px;font-weight:700;color:#fff;">📦 新訂單通知</div>
          <div style="font-size:14px;color:rgba(255,255,255,0.6);margin-top:4px;">訂單 #${orderNo}</div>
        </td></tr>
        <tr><td style="background:#fff;padding:28px 32px;border-left:0.5px solid #e8e8e0;border-right:0.5px solid #e8e8e0;">

          <div style="font-size:13px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;">客戶資訊</div>
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafaf8;border-radius:10px;padding:14px 18px;margin-bottom:20px;">
            <tr><td style="font-size:13px;color:#999;padding:3px 0;width:80px;">姓名</td><td style="font-size:14px;color:#1a1a1a;font-weight:500;">${order.name}</td></tr>
            <tr><td style="font-size:13px;color:#999;padding:3px 0;">電話</td><td style="font-size:14px;color:#1a1a1a;">${order.phone || '—'}</td></tr>
            <tr><td style="font-size:13px;color:#999;padding:3px 0;">Email</td><td style="font-size:14px;color:#1a1a1a;">${order.email || '—'}</td></tr>
            <tr><td style="font-size:13px;color:#999;padding:3px 0;">LINE</td><td style="font-size:14px;color:#1a1a1a;">${order.line_id || '—'}</td></tr>
            ${order.store_name ? `<tr><td style="font-size:13px;color:#999;padding:3px 0;">取貨門市</td><td style="font-size:14px;color:#1a1a1a;">${order.store_name} (${order.store_number || ''})</td></tr>` : ''}
            ${order.address ? `<tr><td style="font-size:13px;color:#999;padding:3px 0;">地址</td><td style="font-size:14px;color:#1a1a1a;">${order.address}</td></tr>` : ''}
            ${order.remittance_last5 ? `<tr><td style="font-size:13px;color:#999;padding:3px 0;">匯款末五碼</td><td style="font-size:14px;color:#1a1a1a;font-weight:600;">${order.remittance_last5}</td></tr>` : ''}
            ${order.note ? `<tr><td style="font-size:13px;color:#999;padding:3px 0;">備註</td><td style="font-size:14px;color:#1a1a1a;">${order.note}</td></tr>` : ''}
          </table>

          <div style="font-size:13px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;">訂購商品</div>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
            ${notifyItemsRows}
          </table>

          <table width="100%" cellpadding="0" cellspacing="0">
            ${discount > 0 ? `
            <tr>
              <td style="padding:6px 0;font-size:14px;color:#888;">小計</td>
              <td style="padding:6px 0;text-align:right;font-size:14px;color:#888;">NT$${(total + discount).toLocaleString()}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;font-size:14px;color:#1a7a3a;">${couponName || '優惠折扣'}</td>
              <td style="padding:6px 0;text-align:right;font-size:14px;font-weight:600;color:#1a7a3a;">-NT$${discount.toLocaleString()}</td>
            </tr>
            ` : ''}
            <tr>
              <td style="padding:12px 0;border-top:1.5px solid #1a1a1a;font-size:16px;font-weight:700;color:#1a1a1a;">總金額</td>
              <td style="padding:12px 0;border-top:1.5px solid #1a1a1a;text-align:right;font-size:20px;font-weight:700;color:#1a1a1a;">NT$${total.toLocaleString()}</td>
            </tr>
          </table>

        </td></tr>
        <tr><td style="background:#f0f0ea;border-radius:0 0 16px 16px;padding:16px 32px;text-align:center;border:0.5px solid #e8e8e0;border-top:none;">
          <div style="font-size:12px;color:#aaa;">此為系統自動通知，請至後台處理訂單。</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`

  // 本機測試：略過寄給店家的新訂單通知；僅正式環境寄出
  const storeNotifyTo = notifyEmail || brand.notifyEmail
  if (process.env.NODE_ENV === 'production' && storeNotifyTo) {
    resend.emails.send({
      from: `${storeName} <no-reply@daigogotw.com>`,
      to: storeNotifyTo,
      subject: `📦【${storeName}】新訂單 #${orderNo} — ${order.name}（NT$${total.toLocaleString()}）`,
      html: notifyHtml,
    }).catch(err => console.error('Store notify error:', err))
  } else {
    console.log(`[send-order-email] 本機模式：略過店家通知信 (#${orderNo})`)
  }

  return NextResponse.json({ success: true })
}
