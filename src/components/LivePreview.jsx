import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { CONTENT_VERSION } from '../lib/contentBlocks'

// 即時預覽：把商城的 /preview/live 嵌成 iframe，編輯器一改就用 postMessage 推過去。
//
// 為什麼是 iframe 而不是在後台自己畫一份：預覽的價值在於「所見即所得」，
// 自己畫就是另一套 CSS，兩邊遲早漂移。iframe 裡跑的是商城本人（含品牌色、響應式斷點），
// 而且不需要先存草稿、也不打資料庫 —— 內容只在兩個視窗之間傳。
//
// 握手：iframe 掛好 listener 後送 ready，這邊收到才推第一份。
// 反過來（載入就推）會因為 iframe 還沒準備好而掉包，預覽會停在「等待後台連線」。
//
// ⚠️ 協定常數在商城有一份對應（shop/src/lib/previewBridge.js），兩邊要一起改。

const PREVIEW_READY = 'daigogo:preview-ready'
const PREVIEW_CONTENT = 'daigogo:preview-content'
const DEBOUNCE_MS = 250
const CONNECT_TIMEOUT_MS = 8000

function originOf(url) {
  try { return new URL(url).origin } catch { return '' }
}

/**
 * Props:
 *   blocks    – 目前編輯中的區塊陣列（未存檔也沒關係，這正是重點）
 *   shopBase  – 商城網址
 *   target    – 'home' | 'product'
 *   productId – target='product' 時必填
 *   mode      – 'inline'（寬螢幕右欄）| 'dock'（右側浮動面板）
 *   onClose   – dock 模式的關閉鈕
 */
export default function LivePreview({ blocks, shopBase, target = 'home', productId, mode = 'inline', onClose }) {
  const [token, setToken] = useState('')
  const [status, setStatus] = useState('loading')   // loading | connecting | live | error
  const [error, setError] = useState('')
  const [device, setDevice] = useState('desktop')   // desktop | mobile
  const [reloadKey, setReloadKey] = useState(0)
  const iframeRef = useRef(null)

  // 推內容時要拿「當下最新的」，而不是 effect 建立當時那份
  const blocksRef = useRef(blocks)
  blocksRef.current = blocks

  const shopOrigin = originOf(shopBase)

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
      { type: PREVIEW_CONTENT, content: { version: CONTENT_VERSION, blocks: blocksRef.current } },
      shopOrigin,
    )
  }, [shopOrigin])

  // iframe 說它準備好了 → 標記連線成功並立刻推第一份
  useEffect(() => {
    function onMessage(e) {
      if (!shopOrigin || e.origin !== shopOrigin) return
      if (e.data?.type !== PREVIEW_READY) return
      setStatus('live')
      push()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [shopOrigin, push])

  // 編輯中每次改動都推，debounce 是為了打字時不要每個字都送一次
  useEffect(() => {
    if (status !== 'live') return
    const id = setTimeout(push, DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [blocks, status, push])

  // 商城沒開、網址不通、被權限擋下時 iframe 不會回話 —— 給個明確的死線與說法
  useEffect(() => {
    if (status !== 'connecting') return
    const id = setTimeout(() => {
      setStatus('error')
      setError(`連不到商城（${shopBase}）。本機開發要先啟動商城的 npm run dev；也可能是登入憑證過期。`)
    }, CONNECT_TIMEOUT_MS)
    return () => clearTimeout(id)
  }, [status, shopBase, reloadKey])

  return (
    <div className={`lp-shell ${mode === 'dock' ? 'lp-dock' : 'lp-inline'}`}>
      <div className="lp-bar">
        <div style={{ display: 'flex', gap: 4 }}>
          {[{ v: 'desktop', label: '桌機' }, { v: 'mobile', label: '手機' }].map(o => (
            <button key={o.v} type="button" onClick={() => setDevice(o.v)}
              style={{
                padding: '4px 10px', borderRadius: 999, fontSize: 12, cursor: 'pointer',
                border: `1px solid ${device === o.v ? 'var(--text)' : 'var(--border)'}`,
                background: device === o.v ? 'var(--text)' : 'var(--bg)',
                color: device === o.v ? '#fff' : 'var(--text-2)',
              }}>
              {o.label}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: 'var(--text-3)', textAlign: 'right' }}>
          {status === 'live' ? '即時預覽（未存檔也看得到）' : status === 'error' ? '未連線' : '連線中…'}
        </div>
        <button type="button" onClick={connect} title="重新連線"
          style={{
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

      <div className="lp-body">
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
            className={`lp-frame ${device === 'mobile' ? 'lp-frame-mobile' : ''}`}
          />
        ) : (
          <div style={{ padding: '40px 20px', fontSize: 13, color: 'var(--text-3)' }}>準備中…</div>
        )}
      </div>
    </div>
  )
}
