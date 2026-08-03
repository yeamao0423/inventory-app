import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { CONTENT_VERSION } from '../lib/contentBlocks'
import { DEVICES, computeScale } from '../lib/previewScale'

// 即時預覽：把商城的 /preview/live 嵌成 iframe，編輯器一改就用 postMessage 推過去。
//
// 為什麼是 iframe 而不是在後台自己畫一份：預覽的價值在於「所見即所得」，
// 自己畫就是另一套 CSS，兩邊遲早漂移。iframe 裡跑的是商城本人（含品牌色、響應式斷點），
// 而且不需要先存草稿、也不打資料庫 —— 內容只在兩個視窗之間傳。
//
// 握手：iframe 掛好 listener 後送 ready，這邊收到才推第一份。
// 反過來（載入就推）會因為 iframe 還沒準備好而掉包，預覽會停在「等待後台連線」。
//
// 為什麼要縮放而不是把 iframe 調窄：媒體查詢量的是 iframe 自己的寬度。
// 舊版「手機預覽就把 iframe 設成 390px」的做法反過來害了桌機預覽 ——
// 預覽欄本來就只有幾百 px，遠小於商城 901px / 1024px 的桌機斷點，
// 所以不管選哪個裝置，商城都老實地渲染手機版。現在 iframe 一律渲染在裝置寬度，
// 再用 transform: scale() 縮到欄位放得下（見 lib/previewScale.js）。
//
// ⚠️ 協定常數在商城有一份對應（shop/src/lib/previewBridge.js），兩邊要一起改。

const PREVIEW_READY = 'daigogo:preview-ready'
const PREVIEW_CONTENT = 'daigogo:preview-content'
const PREVIEW_SELECT = 'daigogo:preview-select'
const PREVIEW_HIGHLIGHT = 'daigogo:preview-highlight'
const DEBOUNCE_MS = 250
const CONNECT_TIMEOUT_MS = 8000

function originOf(url) {
  try { return new URL(url).origin } catch { return '' }
}

/**
 * Props:
 *   blocks     – 目前編輯中的區塊陣列（未存檔也沒關係，這正是重點）
 *   shopBase   – 商城網址
 *   target     – 'home' | 'product'
 *   productId  – target='product' 時必填
 *   mode       – 'inline'（寬螢幕右欄）| 'dock'（右側浮動面板）
 *   onClose    – dock 模式的關閉鈕
 *   editing    – 預覽進入編輯模式：iframe 內攔截連結與按鈕（點加入購物車不該真的加入）、
 *                滑鼠移到區塊上顯示外框、點擊回報選中
 *   selectedId – 目前選中的 blockId，推給 iframe 讓它畫外框
 *   onSelect   – iframe 回報使用者點了哪個 blockId 時呼叫，簽名 (blockId) => void
 *   highlightId– 滑鼠正移過清單裡的哪個 blockId（null = 沒有）。
 *                跟 selectedId 分開走一條輕訊息，因為 hover 一秒可能觸發幾十次，
 *                跟著整份 blocks 一起重推會讓 iframe 白忙一場。
 */
export default function LivePreview({
  blocks, shopBase, target = 'home', productId, mode = 'inline', onClose,
  editing = false, selectedId = null, onSelect, highlightId = null,
}) {
  const [token, setToken] = useState('')
  const [status, setStatus] = useState('loading')   // loading | connecting | live | error
  const [error, setError] = useState('')
  const [device, setDevice] = useState('desktop')   // DEVICES 的 key
  const [containerWidth, setContainerWidth] = useState(0)
  const [reloadKey, setReloadKey] = useState(0)
  const iframeRef = useRef(null)
  const bodyRef = useRef(null)

  // 推內容時要拿「當下最新的」，而不是 effect 建立當時那份
  const blocksRef = useRef(blocks)
  blocksRef.current = blocks
  const editingRef = useRef(editing)
  editingRef.current = editing
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId
  // onSelect 常是 inline 箭頭函式，放進 ref 才不會每次 render 都重掛 listener
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  const shopOrigin = originOf(shopBase)

  const deviceWidth = (DEVICES[device] ?? DEVICES.desktop).width
  const scale = computeScale(containerWidth, deviceWidth)

  const connect = useCallback(async () => {
    setError(''); setStatus('loading')
    const { data: { session } } = await supabase.auth.getSession()
    const t = session?.access_token
    if (!t) { setStatus('error'); setError('登入憑證已失效，請重新整理頁面。'); return }
    if (!shopOrigin) { setStatus('error'); setError('商城網址無法解析，請確認店家設定。'); return }
    setToken(t)
    setStatus('connecting')
    setReloadKey(k => k + 1)
  }, [shopOrigin])

  useEffect(() => { connect() }, [connect])

  // 容器寬度會因為收側欄、拉視窗、開關 dock 而變 —— 只在掛載時量一次會讓縮放停在舊值
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    setContainerWidth(el.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width)
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const src = useMemo(() => {
    if (!token || !shopOrigin) return ''
    const q = new URLSearchParams({ target, t: token, parentOrigin: window.location.origin })
    if (target === 'product') q.set('id', String(productId))
    return `${shopBase}/preview/live?${q.toString()}`
  }, [token, shopOrigin, shopBase, target, productId])

  const push = useCallback(() => {
    const win = iframeRef.current?.contentWindow
    if (!win || !shopOrigin) return
    win.postMessage(
      {
        type: PREVIEW_CONTENT,
        content: { version: CONTENT_VERSION, blocks: blocksRef.current },
        editing: editingRef.current,
        selectedId: selectedIdRef.current,
      },
      shopOrigin,
    )
  }, [shopOrigin])

  // 滑鼠移過左側清單 → 預覽把對應區塊框起來。只送一個 id，不重推內容
  useEffect(() => {
    if (status !== 'live') return
    const win = iframeRef.current?.contentWindow
    if (!win || !shopOrigin) return
    win.postMessage({ type: PREVIEW_HIGHLIGHT, blockId: highlightId ?? null }, shopOrigin)
  }, [highlightId, status, shopOrigin])

  // iframe 說它準備好了 → 標記連線成功並立刻推第一份；點選則轉交給呼叫端
  useEffect(() => {
    function onMessage(e) {
      // origin 檢查是這個元件唯一的信任邊界：iframe 裡跑的是商城，
      // 但 window 上任何人都能發 message，不比對就等於讓外站控制編輯器
      if (!shopOrigin || e.origin !== shopOrigin) return
      if (e.data?.type === PREVIEW_READY) {
        setStatus('live')
        push()
        return
      }
      if (e.data?.type === PREVIEW_SELECT) {
        onSelectRef.current?.(e.data.blockId ?? null)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [shopOrigin, push])

  // 編輯中每次改動都推，debounce 是為了打字時不要每個字都送一次。
  // editing / selectedId 也在依賴裡：切到編輯模式或換選中區塊時預覽要跟著變。
  useEffect(() => {
    if (status !== 'live') return
    const id = setTimeout(push, DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [blocks, editing, selectedId, status, push])

  // 商城沒開、網址不通、被權限擋下時 iframe 不會回話 —— 給個明確的死線與說法
  useEffect(() => {
    if (status !== 'connecting') return
    const id = setTimeout(() => {
      setStatus('error')
      setError(`連不到商城（${shopBase}）。本機開發要先啟動商城的 npm run dev；也可能是登入憑證過期。`)
    }, CONNECT_TIMEOUT_MS)
    return () => clearTimeout(id)
  }, [status, shopBase, reloadKey])

  const scalePercent = Math.round(scale * 100)

  return (
    <div className={`lp-shell ${mode === 'dock' ? 'lp-dock' : 'lp-inline'}`}>
      <div className="lp-bar">
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          {Object.entries(DEVICES).map(([key, d]) => (
            <button key={key} type="button" onClick={() => setDevice(key)}
              aria-pressed={device === key}
              style={{
                padding: '4px 10px', borderRadius: 999, fontSize: 12, cursor: 'pointer',
                border: `1px solid ${device === key ? 'var(--text)' : 'var(--border)'}`,
                background: device === key ? 'var(--text)' : 'var(--bg)',
                color: device === key ? '#fff' : 'var(--text-2)',
              }}>
              {d.label}
            </button>
          ))}
        </div>
        {/* 畫面縮小不是壞掉 —— 沒有這個百分比，店主會以為字級與間距真的變小了 */}
        <div style={{ flexShrink: 0, fontSize: 11.5, color: 'var(--text-3)', fontVariantNumeric: 'tabular-nums' }}>
          {scalePercent}%
        </div>
        {/* 三顆裝置鈕加縮放百分比之後這列變擠，狀態文字是最不重要的那個，讓它先被截斷 */}
        <div style={{
          flex: 1, minWidth: 0, fontSize: 11.5, color: 'var(--text-3)', textAlign: 'right',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {status === 'live' ? '即時預覽（未存檔也看得到）' : status === 'error' ? '未連線' : '連線中…'}
        </div>
        <button type="button" onClick={connect} title="重新連線"
          style={{
            flexShrink: 0, whiteSpace: 'nowrap',
            padding: '4px 10px', borderRadius: 8, fontSize: 12, cursor: 'pointer',
            border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-2)',
          }}>
          重新連線
        </button>
        {onClose && (
          <button type="button" onClick={onClose} title="關閉預覽" aria-label="關閉預覽"
            style={{
              width: 26, height: 26, borderRadius: 8, fontSize: 13, cursor: 'pointer', lineHeight: 1,
              border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-2)',
            }}>
            ×
          </button>
        )}
      </div>

      <div
        className="lp-body"
        ref={bodyRef}
        style={{ '--lp-device-w': `${deviceWidth}px`, '--lp-scale': scale }}
      >
        {status === 'error' ? (
          <div style={{ padding: '40px 20px', fontSize: 13, color: 'var(--text-2)', textAlign: 'center', lineHeight: 1.7 }}>
            {error}
          </div>
        ) : src ? (
          <iframe
            key={reloadKey}
            ref={iframeRef}
            src={src}
            title="商城即時預覽"
            className="lp-frame"
          />
        ) : (
          <div style={{ padding: '40px 20px', fontSize: 13, color: 'var(--text-3)' }}>準備中…</div>
        )}
      </div>
    </div>
  )
}
