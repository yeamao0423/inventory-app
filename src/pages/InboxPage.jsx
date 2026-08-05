import { useEffect, useMemo, useRef, useState } from 'react'
import { isComposing } from '../lib/imeSafeEnter'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import {
  nextStatusOnHandback, nextStatusOnTakeover, groupConversations, sortGroups,
} from '../lib/customerInbox'
import { subscribePush, unsubscribePush, pushState } from '../lib/pushNotify'
import ConsumerOrderDetailSheet from '../components/ConsumerOrderDetailSheet'

// 後台客服工作台：顧客列表（waiting_human 置頂、未讀優先）＋ 對話詳情。
//
// 這一頁走既有的 Supabase JS + RLS，不經 Edge Function ——
// 後台成員是 authenticated 身分，RLS 已經把跨店擋住了。
//
// 列表的單位是「人」不是「對話記錄」：同一位會員換瀏覽器、清快取、換手機都會多一條
// conversations，客服要處理的卻是同一個人。收斂只發生在顯示層（groupConversations），
// 資料表不動、既有對話不搬 —— 見 docs/superpowers/specs/2026-08-05-s2-…-design.md。
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
  const [activeKey, setActiveKey] = useState(null)   // 選的是「哪一組」，不是哪一條對話
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
  // 一組可能掛了好幾台裝置，客人正在看哪一台我們並不知道，所以每一台都訂、每一台都推。
  // 必須先 subscribe 再 send —— 沒訂閱就送會退回 REST 路徑而失敗。
  const channelsRef = useRef([])
  // ?c= 只在進頁時認一次。groups 每 6 秒換一次 identity，不擋的話會把客服
  // 後來點開的那一組硬拉回推播帶進來的那一組。
  const deepLinkedRef = useRef(false)

  const canReply = ['super_admin', 'admin', 'editor'].includes(profile?.role)
  const canAccess = canReply || profile?.role === 'viewer'

  useEffect(() => {
    if (!storeId || !canAccess) return
    fetchConversations().finally(() => setLoading(false))
    const timer = setInterval(() => {
      if (!document.hidden) fetchConversations()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [storeId, canAccess])

  const groups = useMemo(
    () => sortGroups(groupConversations(conversations)),
    [conversations],
  )
  const active = useMemo(
    () => groups.find(g => g.key === activeKey) ?? null,
    [groups, activeKey],
  )
  // 組內對話的 id 清單。用字串當依賴，避免每次輪詢都因為陣列換了 identity 而重跑。
  const activeIdsKey = active ? active.conversationIds.join(',') : ''

  // 開啟網址帶 ?c=123（推播點進來）就直接開含有那條對話的那一組
  useEffect(() => {
    if (deepLinkedRef.current) return
    const c = Number(new URLSearchParams(window.location.search).get('c'))
    if (!Number.isInteger(c) || c <= 0) { deepLinkedRef.current = true; return }
    const g = groups.find(x => x.conversationIds.includes(c))
    if (g) { setActiveKey(g.key); deepLinkedRef.current = true }
  }, [groups])

  useEffect(() => {
    if (!activeIdsKey) { setMessages([]); setCustomer(null); return }
    const ids = activeIdsKey.split(',').map(Number)
    fetchMessages(ids)
    markRead(ids)
    const timer = setInterval(() => {
      if (!document.hidden) fetchMessages(ids)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [activeIdsKey])

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

  // 組內所有對話的訊息合併成單一時間軸。
  // 刻意由新往舊撈再倒回來：上限砍掉的必須是最舊的那一段，
  // 由舊往新撈會在對話夠長時把「最近的訊息」整批砍掉。
  async function fetchMessages(ids) {
    if (!ids?.length) { setMessages([]); return }
    const { data } = await supabase
      .from('messages')
      .select('id, conversation_id, sender, sender_user_id, content, created_at')
      .in('conversation_id', ids)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(500)
    setMessages((data ?? []).slice().reverse())
  }

  // 消費者基本資料與近期訂單。
  // consumers 表的 RLS 只讓本人讀，所以這裡改從該店的 consumer_orders 取 ——
  // 那是店家自己的訂單資料，本來就看得到。
  async function fetchCustomer(group) {
    if (!group?.consumerId) { setCustomer(null); return }
    const { data } = await supabase
      .from('consumer_orders')
      .select('id, store_order_no, customer_name, email, phone, total_amount, payment_status, status, created_at')
      .eq('store_id', storeId)
      .eq('consumer_id', group.consumerId)
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

  useEffect(() => { fetchCustomer(active) }, [active?.key, active?.consumerId])

  // 回覆要寫進組內最新的那一條對話（客人的下一則也會落在那裡）
  const targetConvId = useMemo(() => {
    if (!active) return null
    const rows = conversations.filter(c => active.conversationIds.includes(c.id))
    rows.sort((a, b) => new Date(b.last_message_at ?? 0) - new Date(a.last_message_at ?? 0))
    return rows[0]?.id ?? null
  }, [conversations, active])

  // 這一組有幾台裝置就訂幾個頻道 —— 客服回的訊息要推到客人「正在看的那一台」，
  // 而我們不知道是哪一台。
  useEffect(() => {
    channelsRef.current = []
    if (!activeIdsKey) return
    const ids = activeIdsKey.split(',').map(Number)
    let cancelled = false
    const chans = []
    ;(async () => {
      const { data } = await supabase
        .from('conversation_devices')
        .select('visitor_token')
        .in('conversation_id', ids)
      if (cancelled) return
      const tokens = [...new Set((data ?? []).map(r => r.visitor_token))]
      tokens.forEach(t => {
        const ch = supabase.channel(`chat:${t}`)
        ch.subscribe(status => {
          if (status === 'SUBSCRIBED' && !cancelled) channelsRef.current.push(ch)
        })
        chans.push(ch)
      })
    })()
    return () => {
      cancelled = true
      channelsRef.current = []
      chans.forEach(ch => supabase.removeChannel(ch))
    }
  }, [activeIdsKey])

  async function markRead(ids) {
    if (!canReply || !ids?.length) return
    await supabase.from('conversations').update({ unread_for_store: 0 }).in('id', ids)
    setConversations(prev => prev.map(c => ids.includes(c.id) ? { ...c, unread_for_store: 0 } : c))
  }

  async function setStatus(status, extra = {}) {
    if (!active || !canReply) return
    setBusy(true)
    // 客服的心智模型是「處理這個人」，不是「處理這條記錄」——
    // 只改其中一條會讓同一個人在列表上同時是「真人接管中」和「等待真人」
    const { error } = await supabase
      .from('conversations')
      .update({ status, ...extra })
      .in('id', active.conversationIds)
    if (error) alert('更新失敗：' + error.message)
    else await fetchConversations()
    setBusy(false)
  }

  const takeover = () => setStatus(nextStatusOnTakeover(), { assigned_to: user?.id ?? null })
  const handback = () => setStatus(nextStatusOnHandback({ aiEnabled }), { assigned_to: null })
  const closeConv = () => setStatus('closed', { assigned_to: null })

  async function send() {
    const text = draft.trim()
    if (!text || !active || !targetConvId || !canReply || busy) return
    setBusy(true)
    const { error } = await supabase.from('messages').insert({
      conversation_id: targetConvId,
      store_id: storeId,
      sender: 'staff',
      sender_user_id: user.id,
      content: text,
    })
    if (error) { alert('送出失敗：' + error.message); setBusy(false); return }

    const now = new Date().toISOString()
    await supabase.from('conversations')
      .update({ last_message_at: now, unread_for_store: 0 })
      .eq('id', targetConvId)

    // 推給訪客的網頁；推不出去也沒關係，訪客端每 6 秒會輪詢兜底
    if (channelsRef.current.length) {
      const { data } = await supabase.from('messages')
        .select('id, sender, content, created_at')
        .eq('conversation_id', targetConvId)
        .order('id', { ascending: false }).limit(1).maybeSingle()
      await Promise.all(channelsRef.current.map(ch => ch.send({
        type: 'broadcast',
        event: 'message',
        payload: { conversationId: targetConvId, message: data, status: active.status },
      }).catch(e => console.error('broadcast failed', e))))
    }

    setDraft('')
    await fetchMessages(active.conversationIds)
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

  const unreadCount = groups.filter(g => g.unread > 0).length
  const waitingCount = groups.filter(g => g.status === 'waiting_human').length

  return (
    <div className="page page-wide">
      <div className="ph">
        <div>
          <div className="ph-title">客服收件匣</div>
          <div className="ph-sub">
            {waitingCount > 0 ? `${waitingCount} 位等待真人・` : ''}未讀 {unreadCount}・共 {groups.length} 位顧客
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
        {/* ── 顧客列表：名字＋預覽，一眼看得出誰在問什麼 ── */}
        <div className="inbox-list card">
          {loading ? <div className="empty">載入中…</div>
            : groups.length === 0 ? <div className="empty">還沒有任何對話</div>
            : groups.map(g => {
              const unread = g.unread > 0
              return (
                <button
                  key={g.key}
                  className={`inbox-row${g.key === activeKey ? ' active' : ''}`}
                  onClick={() => setActiveKey(g.key)}
                >
                  <span className={`inbox-avatar${g.consumerId ? '' : ' guest'}`} aria-hidden="true">
                    {avatarText(g)}
                  </span>
                  <span className="inbox-row-main">
                    <span className="inbox-row-top">
                      <span className={`inbox-row-name${unread ? ' unread' : ''}`}>{displayName(g)}</span>
                      <span className="inbox-row-time">{shortTime(g.lastMessageAt)}</span>
                    </span>
                    <span className="inbox-row-preview">
                      {g.lastMessagePreview
                        ? <>{senderPrefix(g.lastMessageSender)}{g.lastMessagePreview}</>
                        : <i style={{ color: 'var(--text-3)' }}>尚無訊息</i>}
                    </span>
                    <span className="inbox-row-meta">
                      {g.status === 'waiting_human' && <span className="badge badge-warn">等待真人</span>}
                      {g.status === 'human' && <span className="badge badge-blue">真人接管中</span>}
                      {g.status === 'closed' && <span className="badge">已結束</span>}
                      {unread && <span className="inbox-dot" aria-label="未讀" />}
                      {/* 只有真的散在多條對話時才提 —— 一段的情況說「1 段對話」是雜訊 */}
                      {g.conversationIds.length > 1 && (
                        <span className="inbox-row-devices">{g.conversationIds.length} 段對話</span>
                      )}
                      <span className="inbox-row-channel">{g.channel === 'line' ? 'LINE' : '站內'}</span>
                    </span>
                  </span>
                </button>
              )
            })}
        </div>

        {/* ── 對話 ── */}
        <div className="inbox-thread card">
          {!active ? <div className="empty">從左邊選一位顧客</div> : (
            <>
              <div className="inbox-thread-head">
                <div className="inbox-thread-title">
                  <b>{displayName(active)}</b>
                  <span className={STATUS_BADGE[active.status]}>{statusLabel(active.status, aiEnabled)}</span>
                  {active.assignedTo && (
                    <span className="badge badge-blue">
                      {active.assignedTo === user?.id ? '你在處理' : '同事處理中'}
                    </span>
                  )}
                  {/* 顯示的是回覆會寫進哪一條 —— 客服要對照資料庫時看的就是這個號碼 */}
                  <span className="inbox-thread-id">#{targetConvId ?? ''}</span>
                </div>
                {/* 窄螢幕看不到右欄，把最關鍵的兩項摘要在這裡 */}
                <div className="inbox-brief">
                  {active.consumerId
                    ? `${customer?.phone || '未留電話'}・${customer?.orders?.length ?? 0} 筆訂單`
                    : '尚未識別身分的訪客'}
                </div>
              </div>

              <div ref={bodyRef} className="inbox-msgs">
                {messages.map((m, i) => {
                  // 換了一條對話就是換了一台裝置。不標的話時間軸會突然跳一大段，
                  // 客服會以為自己漏看了什麼。
                  const prev = messages[i - 1]
                  const seam = prev && prev.conversation_id !== m.conversation_id
                  return (
                    <div key={m.id} className="inbox-msg-slot">
                      {seam && (
                        <div className="inbox-seam">
                          另一個裝置・{new Date(m.created_at).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' })} 起
                        </div>
                      )}
                      <div className={`inbox-msg ${m.sender === 'consumer' ? 'them' : 'me'}`}>
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
                    </div>
                  )
                })}
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
                <span className={`inbox-avatar lg${active.consumerId ? '' : ' guest'}`} aria-hidden="true">
                  {avatarText(active)}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div className="inbox-side-name">{displayName(active)}</div>
                  <div className="inbox-side-role">
                    {active.consumerId ? '會員' : '訪客・尚未識別身分'}
                    {active.conversationIds.length > 1 && `・${active.conversationIds.length} 段對話`}
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
                      {active.consumerId ? '這位會員還沒有訂單' : '訪客登入或下單後才看得到'}
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
          // 只刷新、不關閉：ConsumerOrderDetailSheet 有幾條路徑是「存完繼續編輯」
          // （折讓失焦、登記收付款、刪除收付款紀錄都只呼叫 onSaved），
          // 在這裡順手關掉會讓客服登記一筆收款就被踢出 sheet。
          // 該關的路徑（save()、退還優惠券）元件自己會呼叫 onClose()。
          onSaved={() => fetchCustomer(active)}
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
        /* 每則訊息包一層，接縫分隔線才有地方擺；泡泡的左右對齊改在這一層之內完成 */
        .inbox-msg-slot { display: flex; flex-direction: column; }
        .inbox-seam {
          text-align: center; font-size: 11px; color: var(--text-3);
          margin: 6px 0; position: relative;
        }
        .inbox-seam::before, .inbox-seam::after {
          content: ''; position: absolute; top: 50%; width: calc(50% - 60px);
          border-top: 0.5px solid var(--border-light);
        }
        .inbox-seam::before { left: 0; }
        .inbox-seam::after { right: 0; }
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

// 吃的是 groupConversations 產出的「一位顧客」，不是單一 conversations 列。
// 訪客沒有名字，用組內第一條對話的編號當代號 —— 總比一整排「訪客」好認
function displayName(g) {
  if (g?.label) return g.label
  if (g?.consumerId) return '會員'
  return `訪客 #${g?.conversationIds?.[0] ?? ''}`
}

function avatarText(g) {
  if (g?.label) return g.label.trim().slice(0, 1)
  return g?.consumerId ? '會' : '訪'
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
