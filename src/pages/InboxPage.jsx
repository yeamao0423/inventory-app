import { useEffect, useMemo, useRef, useState } from 'react'
import { isComposing } from '../lib/imeSafeEnter'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import {
  nextStatusOnHandback, nextStatusOnTakeover, sortConversations,
} from '../lib/customerInbox'
import { subscribePush, unsubscribePush, pushState } from '../lib/pushNotify'
import ConsumerOrderDetailSheet from '../components/ConsumerOrderDetailSheet'

// 後台客服工作台：對話列表（waiting_human 置頂、未讀優先）＋ 對話詳情。
//
// 這一頁走既有的 Supabase JS + RLS，不經 Edge Function ——
// 後台成員是 authenticated 身分，RLS 已經把跨店擋住了。
const POLL_MS = 6000

const STATUS_LABEL = {
  bot: '助理回覆中',
  waiting_human: '等待真人',
  human: '真人接管中',
  closed: '已結束',
}

// AI 關閉後，開關打開時留下的舊對話還停在 bot，但已經沒有助理會回它們了。
// 顧客下次發話就會轉進 waiting_human，在那之前別讓標籤說謊。
const statusLabel = (status, aiEnabled) =>
  status === 'bot' && !aiEnabled ? '尚未回覆' : STATUS_LABEL[status]

const STATUS_BADGE = {
  bot: 'badge',
  waiting_human: 'badge badge-warn',
  human: 'badge badge-blue',
  closed: 'badge',
}

export default function InboxPage() {
  const { profile, storeId, user, store, can } = useAuth()
  // AI 自動回覆預設關閉，逐店開通。關著的時候沒有助理可以「交還」，
  // 也不會有助理插話，所以底下的按鈕與提示都要跟著換。
  const aiEnabled = store?.settings?.ai_reply === true
  const [conversations, setConversations] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [messages, setMessages] = useState([])
  const [customer, setCustomer] = useState(null)   // { name, email, phone, orders }
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [push, setPush] = useState(pushState())
  const [orderSheet, setOrderSheet] = useState(null)     // 開著的訂單完整資料
  const [orderLoading, setOrderLoading] = useState(null) // 正在撈的訂單 id，避免連點開兩個
  const bodyRef = useRef(null)
  // 推給訪客網頁用的 Broadcast 頻道（頻道名＝訪客識別碼，見 ADR-0002）。
  // 必須先 subscribe 再 send —— 沒訂閱就送會退回 REST 路徑而失敗。
  const channelRef = useRef(null)

  const canReply = ['super_admin', 'admin', 'editor'].includes(profile?.role)
  const canAccess = canReply || profile?.role === 'viewer'

  // 開啟網址帶 ?c=123（推播點進來）就直接開那條對話
  useEffect(() => {
    const c = Number(new URLSearchParams(window.location.search).get('c'))
    if (Number.isInteger(c) && c > 0) setActiveId(c)
  }, [])

  useEffect(() => {
    if (!storeId || !canAccess) return
    fetchConversations().finally(() => setLoading(false))
    const timer = setInterval(() => {
      if (!document.hidden) fetchConversations()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [storeId, canAccess])

  useEffect(() => {
    if (!activeId) { setMessages([]); setCustomer(null); return }
    fetchMessages(activeId)
    markRead(activeId)
    const timer = setInterval(() => {
      if (!document.hidden) fetchMessages(activeId)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [activeId])

  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  async function fetchConversations() {
    const { data, error } = await supabase
      .from('conversations')
      // last_message_preview / customer_label 是 trigger 維護的快照（20250081），
      // 這樣列表每 6 秒輪詢一次仍是單表查詢，不必 join messages。
      .select('id, channel, status, consumer_id, visitor_token, assigned_to, last_message_at, unread_for_store, created_at, last_message_preview, last_message_sender, customer_label')
      .eq('store_id', storeId)
      .order('last_message_at', { ascending: false })
      .limit(200)
    if (error) { console.error('conversations', error); return }
    setConversations(data ?? [])
  }

  async function fetchMessages(id) {
    const { data } = await supabase
      .from('messages')
      .select('id, sender, sender_user_id, content, created_at')
      .eq('conversation_id', id)
      .order('id', { ascending: true })
      .limit(500)
    setMessages(data ?? [])
  }

  // 消費者基本資料與近期訂單。
  // consumers 表的 RLS 只讓本人讀，所以這裡改從該店的 consumer_orders 取 ——
  // 那是店家自己的訂單資料，本來就看得到。
  async function fetchCustomer(conv) {
    if (!conv?.consumer_id) { setCustomer(null); return }
    const { data } = await supabase
      .from('consumer_orders')
      .select('id, store_order_no, customer_name, email, phone, total_amount, payment_status, status, created_at')
      .eq('store_id', storeId)
      .eq('consumer_id', conv.consumer_id)
      .order('created_at', { ascending: false })
      .limit(5)
    const latest = data?.[0]
    setCustomer({
      name: latest?.customer_name ?? null,
      email: latest?.email ?? null,
      phone: latest?.phone ?? null,
      orders: data ?? [],
    })
  }

  // 右欄的近期訂單只 select 了七個欄位（fetchCustomer），
  // ConsumerOrderDetailSheet 要的是完整一列，所以點下去才另外撈。
  async function openOrder(orderId) {
    if (orderLoading) return
    setOrderLoading(orderId)
    const { data, error } = await supabase
      .from('consumer_orders')
      .select('*')
      // RLS 已經擋住跨店；這個條件是為了讓「拿到別店的 id」這種程式錯誤直接查不到，
      // 而不是靜靜開一個空 sheet
      .eq('store_id', storeId)
      .eq('id', orderId)
      .maybeSingle()
    setOrderLoading(null)
    if (error) { alert('讀取訂單失敗：' + error.message); return }
    if (!data) { alert('這筆訂單已不存在'); return }
    setOrderSheet(data)
  }

  const active = useMemo(
    () => conversations.find(c => c.id === activeId) ?? null,
    [conversations, activeId],
  )

  useEffect(() => { fetchCustomer(active) }, [active?.id, active?.consumer_id])

  // 開著哪條對話就訂哪個訪客的頻道，回覆時直接從這條連線送出去
  useEffect(() => {
    channelRef.current = null
    const token = active?.visitor_token
    if (!token) return
    const ch = supabase.channel(`chat:${token}`)
    ch.subscribe(status => { if (status === 'SUBSCRIBED') channelRef.current = ch })
    return () => { channelRef.current = null; supabase.removeChannel(ch) }
  }, [active?.visitor_token])

  async function markRead(id) {
    if (!canReply) return
    await supabase.from('conversations').update({ unread_for_store: 0 }).eq('id', id)
    setConversations(prev => prev.map(c => c.id === id ? { ...c, unread_for_store: 0 } : c))
  }

  async function setStatus(status, extra = {}) {
    if (!active || !canReply) return
    setBusy(true)
    const { error } = await supabase
      .from('conversations')
      .update({ status, ...extra })
      .eq('id', active.id)
    if (error) alert('更新失敗：' + error.message)
    else await fetchConversations()
    setBusy(false)
  }

  const takeover = () => setStatus(nextStatusOnTakeover(), { assigned_to: user?.id ?? null })
  const handback = () => setStatus(nextStatusOnHandback({ aiEnabled }), { assigned_to: null })
  const closeConv = () => setStatus('closed', { assigned_to: null })

  async function send() {
    const text = draft.trim()
    if (!text || !active || !canReply || busy) return
    setBusy(true)
    const { error } = await supabase.from('messages').insert({
      conversation_id: active.id,
      store_id: storeId,
      sender: 'staff',
      sender_user_id: user.id,
      content: text,
    })
    if (error) { alert('送出失敗：' + error.message); setBusy(false); return }

    const now = new Date().toISOString()
    await supabase.from('conversations')
      .update({ last_message_at: now, unread_for_store: 0 })
      .eq('id', active.id)

    // 推給訪客的網頁；推不出去也沒關係，訪客端每 6 秒會輪詢兜底
    if (channelRef.current) {
      const { data } = await supabase.from('messages')
        .select('id, sender, content, created_at')
        .eq('conversation_id', active.id)
        .order('id', { ascending: false }).limit(1).maybeSingle()
      try {
        await channelRef.current.send({
          type: 'broadcast',
          event: 'message',
          payload: { conversationId: active.id, message: data, status: active.status },
        })
      } catch (e) {
        console.error('broadcast failed', e)
      }
    }

    setDraft('')
    await fetchMessages(active.id)
    await fetchConversations()
    setBusy(false)
  }

  async function togglePush() {
    setBusy(true)
    try {
      if (push.subscribed) {
        await unsubscribePush()
      } else {
        await subscribePush({ storeId, userId: user.id })
      }
      setPush(pushState())
    } catch (e) {
      alert(e.message)
    }
    setBusy(false)
  }

  if (!canAccess) return (
    <div className="page"><div className="empty" style={{ paddingTop: 80 }}>
      <div style={{ fontSize: 36, marginBottom: 12 }}>🔒</div><div>無權限存取此頁面</div>
    </div></div>
  )

  const sorted = sortConversations(conversations)
  const unreadCount = conversations.filter(c => (c.unread_for_store ?? 0) > 0).length
  const waitingCount = conversations.filter(c => c.status === 'waiting_human').length

  return (
    <div className="page page-wide">
      <div className="ph">
        <div>
          <div className="ph-title">客服收件匣</div>
          <div className="ph-sub">
            {waitingCount > 0 ? `${waitingCount} 條等待真人・` : ''}未讀 {unreadCount}・共 {conversations.length} 條對話
          </div>
        </div>
        {canReply && (
          <button className="btn" onClick={togglePush} disabled={busy || !push.supported}
            title={push.deviceSupported && !push.configured
              ? '部署環境缺少 VITE_VAPID_PUBLIC_KEY，不是裝置的問題' : undefined}
            style={{ width: 'auto', padding: '9px 16px', fontSize: 13 }}>
            {!push.deviceSupported ? '此裝置不支援推播'
              : !push.configured ? '推播尚未設定'
              : push.subscribed ? '關閉推播' : '開啟推播通知'}
          </button>
        )}
      </div>

      {canReply && push.supported && !push.subscribed && (
        <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.6, marginBottom: 12 }}>
          開啟後顧客一有新訊息就會推到這台裝置。
          <b>iPhone / iPad 必須先用 Safari 把後台「加入主畫面」</b>，從主畫面圖示開啟才收得到推播。
        </div>
      )}

      <div className="inbox-split">
        {/* ── 對話列表：名字＋預覽，一眼看得出誰在問什麼 ── */}
        <div className="inbox-list card">
          {loading ? <div className="empty">載入中…</div>
            : sorted.length === 0 ? <div className="empty">還沒有任何對話</div>
            : sorted.map(c => {
              const unread = (c.unread_for_store ?? 0) > 0
              return (
                <button
                  key={c.id}
                  className={`inbox-row${c.id === activeId ? ' active' : ''}`}
                  onClick={() => setActiveId(c.id)}
                >
                  <span className={`inbox-avatar${c.consumer_id ? '' : ' guest'}`} aria-hidden="true">
                    {avatarText(c)}
                  </span>
                  <span className="inbox-row-main">
                    <span className="inbox-row-top">
                      <span className={`inbox-row-name${unread ? ' unread' : ''}`}>{displayName(c)}</span>
                      <span className="inbox-row-time">{shortTime(c.last_message_at)}</span>
                    </span>
                    <span className="inbox-row-preview">
                      {c.last_message_preview
                        ? <>{senderPrefix(c.last_message_sender)}{c.last_message_preview}</>
                        : <i style={{ color: 'var(--text-3)' }}>尚無訊息</i>}
                    </span>
                    <span className="inbox-row-meta">
                      {c.status === 'waiting_human' && <span className="badge badge-warn">等待真人</span>}
                      {c.status === 'human' && <span className="badge badge-blue">真人接管中</span>}
                      {c.status === 'closed' && <span className="badge">已結束</span>}
                      {unread && <span className="inbox-dot" aria-label="未讀" />}
                      <span className="inbox-row-channel">{c.channel === 'line' ? 'LINE' : '站內'}</span>
                    </span>
                  </span>
                </button>
              )
            })}
        </div>

        {/* ── 對話 ── */}
        <div className="inbox-thread card">
          {!active ? <div className="empty">從左邊選一條對話</div> : (
            <>
              <div className="inbox-thread-head">
                <div className="inbox-thread-title">
                  <b>{displayName(active)}</b>
                  <span className={STATUS_BADGE[active.status]}>{statusLabel(active.status, aiEnabled)}</span>
                  {active.assigned_to && (
                    <span className="badge badge-blue">
                      {active.assigned_to === user?.id ? '你在處理' : '同事處理中'}
                    </span>
                  )}
                  <span className="inbox-thread-id">#{active.id}</span>
                </div>
                {/* 窄螢幕看不到右欄，把最關鍵的兩項摘要在這裡 */}
                <div className="inbox-brief">
                  {active.consumer_id
                    ? `${customer?.phone || '未留電話'}・${customer?.orders?.length ?? 0} 筆訂單`
                    : '尚未識別身分的訪客'}
                </div>
              </div>

              <div ref={bodyRef} className="inbox-msgs">
                {messages.map(m => (
                  <div key={m.id} className={`inbox-msg ${m.sender === 'consumer' ? 'them' : 'me'}`}>
                    <div className="inbox-who">
                      {m.sender === 'consumer'
                        ? displayName(active)
                        : m.sender === 'assistant'
                          ? '客服助理'
                          : m.sender_user_id === user?.id ? '你' : '同事'}
                      ・{shortTime(m.created_at)}
                    </div>
                    <div className="inbox-bubble">{m.content}</div>
                  </div>
                ))}
                {messages.length === 0 && <div className="empty">還沒有訊息</div>}
              </div>

              {canReply && (
                <div className="inbox-compose">
                  <div className="inbox-actions">
                    {active.status !== 'human' && (
                      <button className="btn" onClick={takeover} disabled={busy}>接管</button>
                    )}
                    {active.status === 'human' && aiEnabled && (
                      <button className="btn btn-outline" onClick={handback} disabled={busy}>交還助理</button>
                    )}
                    {active.status !== 'closed' && (
                      <button className="btn btn-outline" onClick={closeConv} disabled={busy}>結束對話</button>
                    )}
                  </div>
                  <div className="inbox-input-row">
                    <textarea
                      className="form-input"
                      rows={2}
                      value={draft}
                      placeholder={active.status === 'human' || !aiEnabled
                        ? '輸入回覆，按 Enter 送出，Shift + Enter 換行'
                        : '接管後回覆才不會被助理插話'}
                      onChange={e => setDraft(e.target.value)}
                      onKeyDown={e => {
                        if (isComposing(e)) return          // 中文選字中，Enter 是在選字不是送出
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
                      }}
                    />
                    <button className="btn" onClick={send} disabled={busy || !draft.trim()}>送出</button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* ── 顧客面板：客服判斷的依據，值得一整欄 ── */}
        <aside className="inbox-side card">
          {!active ? <div className="empty">顧客資料</div> : (
            <>
              <div className="inbox-side-id">
                <span className={`inbox-avatar lg${active.consumer_id ? '' : ' guest'}`} aria-hidden="true">
                  {avatarText(active)}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div className="inbox-side-name">{displayName(active)}</div>
                  <div className="inbox-side-role">
                    {active.consumer_id ? '會員' : '訪客・尚未識別身分'}
                  </div>
                </div>
              </div>

              <div className="inbox-side-sec">
                <div className="inbox-side-h">聯絡方式</div>
                <dl className="inbox-kv">
                  <dt>電話</dt><dd>{customer?.phone || <i>未提供</i>}</dd>
                  <dt>Email</dt><dd className="ellip">{customer?.email || <i>未提供</i>}</dd>
                </dl>
              </div>

              <div className="inbox-side-sec">
                <div className="inbox-side-h">
                  近期訂單{customer?.orders?.length ? `（${customer.orders.length}）` : ''}
                </div>
                {customer?.orders?.length
                  ? customer.orders.map(o => (
                    <button
                      key={o.id}
                      type="button"
                      className="inbox-order"
                      onClick={() => openOrder(o.id)}
                      disabled={orderLoading === o.id}
                      aria-label={`查看訂單 #${o.store_order_no ?? o.id} 的詳細資料`}
                    >
                      <div className="inbox-order-top">
                        <span className="inbox-order-no">#{o.store_order_no ?? o.id}</span>
                        <span className="inbox-order-amt">NT${Number(o.total_amount || 0).toLocaleString()}</span>
                      </div>
                      <div className="inbox-order-meta">
                        <span className="badge">{o.status}</span>
                        <span className="badge badge-ok">{o.payment_status}</span>
                        <span>{orderLoading === o.id ? '讀取中…' : shortTime(o.created_at)}</span>
                      </div>
                    </button>
                  ))
                  : <div className="inbox-side-none">
                      {active.consumer_id ? '這位會員還沒有訂單' : '訪客登入或下單後才看得到'}
                    </div>}
              </div>
            </>
          )}
        </aside>
      </div>

      {orderSheet && (
        <ConsumerOrderDetailSheet
          order={orderSheet}
          canEdit={can('pay')}
          onClose={() => setOrderSheet(null)}
          onSaved={() => { fetchCustomer(active); setOrderSheet(null) }}
        />
      )}

      <style>{`
        /* 三欄：列表｜對話｜顧客。整頁不捲，各欄自己捲，輸入框釘在對話欄底部。 */
        .inbox-split {
          display: grid; gap: 12px;
          grid-template-columns: 320px minmax(0, 1fr) 300px;
          height: calc(100dvh - 210px); min-height: 460px;
        }
        .inbox-list, .inbox-thread, .inbox-side { overflow: hidden; display: flex; flex-direction: column; }
        .inbox-list { overflow-y: auto; padding: 0; }
        .inbox-side { overflow-y: auto; padding: 14px; gap: 16px; }

        /* 列表列：頭像＋名字＋時間＋訊息預覽＋狀態 */
        .inbox-row {
          display: flex; gap: 10px; align-items: flex-start; width: 100%; text-align: left;
          padding: 11px 12px; background: none; border: none;
          border-bottom: 0.5px solid var(--border-light); cursor: pointer;
        }
        .inbox-row:hover { background: var(--bg); }
        .inbox-row.active { background: var(--bg); }
        .inbox-avatar {
          flex-shrink: 0; width: 34px; height: 34px; border-radius: 17px;
          background: var(--border-light); color: var(--text-2);
          display: flex; align-items: center; justify-content: center;
          font-size: 13px; font-weight: 600;
        }
        .inbox-avatar.guest { background: transparent; border: 0.5px dashed var(--border); color: var(--text-3); }
        .inbox-avatar.lg { width: 44px; height: 44px; border-radius: 22px; font-size: 15px; }
        .inbox-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
        .inbox-row-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
        .inbox-row-name { font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .inbox-row-name.unread { font-weight: 700; }
        .inbox-row-time { font-size: 11px; color: var(--text-3); flex-shrink: 0; }
        .inbox-row-preview {
          font-size: 12.5px; color: var(--text-2); line-height: 1.5;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .inbox-row-meta { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-3); }
        .inbox-row-channel { margin-left: auto; }
        .inbox-dot { width: 7px; height: 7px; border-radius: 4px; background: var(--red); flex-shrink: 0; }

        /* 對話欄 */
        .inbox-thread-head { padding: 11px 14px; border-bottom: 0.5px solid var(--border-light); flex-shrink: 0; }
        .inbox-thread-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 14px; }
        .inbox-thread-id { font-size: 11.5px; color: var(--text-3); margin-left: auto; }
        .inbox-brief { display: none; font-size: 12px; color: var(--text-3); margin-top: 5px; }
        .inbox-msgs { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
        .inbox-msg { max-width: 76%; display: flex; flex-direction: column; }
        .inbox-msg.them { align-self: flex-start; }
        .inbox-msg.me { align-self: flex-end; align-items: flex-end; }
        .inbox-who { font-size: 11px; color: var(--text-3); margin-bottom: 3px; }
        .inbox-bubble {
          font-size: 13.5px; line-height: 1.65; padding: 9px 12px; border-radius: 13px;
          white-space: pre-wrap; word-break: break-word;
          background: var(--bg); border: 0.5px solid var(--border);
        }
        .inbox-msg.me .inbox-bubble { background: var(--text); color: #fff; border-color: var(--text); }
        .inbox-compose { border-top: 0.5px solid var(--border-light); padding: 10px 12px; flex-shrink: 0; }
        .inbox-actions { display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
        .inbox-actions .btn { width: auto; padding: 7px 14px; font-size: 12.5px; }
        .inbox-input-row { display: flex; gap: 8px; align-items: flex-end; }
        .inbox-input-row textarea { flex: 1; resize: none; }
        .inbox-input-row .btn { width: auto; padding: 9px 18px; font-size: 13px; }

        /* 顧客面板 */
        .inbox-side-id { display: flex; gap: 11px; align-items: center; }
        .inbox-side-name { font-size: 15px; font-weight: 700; }
        .inbox-side-role { font-size: 12px; color: var(--text-3); margin-top: 1px; }
        .inbox-side-sec { border-top: 0.5px solid var(--border-light); padding-top: 13px; }
        .inbox-side-h { font-size: 12px; font-weight: 600; color: var(--text-2); margin-bottom: 8px; }
        .inbox-side-none { font-size: 12.5px; color: var(--text-3); line-height: 1.6; }
        .inbox-kv { display: grid; grid-template-columns: 52px 1fr; gap: 5px 8px; margin: 0; font-size: 12.5px; }
        .inbox-kv dt { color: var(--text-3); }
        .inbox-kv dd { margin: 0; color: var(--text); }
        .inbox-kv i, .inbox-side-none i { color: var(--text-3); font-style: normal; }
        .ellip { overflow: hidden; text-overflow: ellipsis; }
        .inbox-order {
          display: block; width: 100%; text-align: left;
          border: 0.5px solid var(--border); border-radius: 10px; padding: 9px 10px;
          margin-bottom: 8px; background: none; cursor: pointer;
          transition: border-color .15s;
        }
        .inbox-order:hover:not(:disabled) { border-color: var(--text-3); }
        .inbox-order:disabled { opacity: .6; cursor: wait; }
        .inbox-order:last-child { margin-bottom: 0; }
        .inbox-order-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
        .inbox-order-no { font-size: 12.5px; font-weight: 600; }
        .inbox-order-amt { font-size: 12.5px; }
        .inbox-order-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11px; color: var(--text-3); margin-top: 5px; }

        /* 放不下三欄時收掉顧客欄，關鍵兩項改在對話標題下摘要 */
        @media (max-width: 1100px) {
          .inbox-split { grid-template-columns: 290px minmax(0, 1fr); }
          .inbox-side { display: none; }
          .inbox-brief { display: block; }
        }
        @media (max-width: 760px) {
          .inbox-split { grid-template-columns: 1fr; height: auto; min-height: 0; }
          .inbox-list { max-height: 46vh; }
          .inbox-thread { height: 72vh; }
        }
      `}</style>
    </div>
  )
}

// 訪客沒有名字，用對話編號當代號 —— 總比一整排 #41 好認
function displayName(c) {
  if (c?.customer_label) return c.customer_label
  if (c?.consumer_id) return '會員'
  return `訪客 #${c?.id ?? ''}`
}

function avatarText(c) {
  if (c?.customer_label) return c.customer_label.trim().slice(0, 1)
  return c?.consumer_id ? '會' : '訪'
}

function senderPrefix(sender) {
  if (sender === 'assistant') return '助理：'
  if (sender === 'staff') return '你：'
  return ''
}

// 今天只顯示時間，其他日子顯示月/日 —— 收件匣掃視時，年份是雜訊
function shortTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  return d.toLocaleString('zh-TW', sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
