import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import { resolveShopBaseUrl } from '../lib/socialShare'
import { revalidateShop } from '../lib/revalidateShop'
import BlocksEditor from '../components/BlocksEditor'
import LivePreview from '../components/LivePreview'
import { useMediaQuery } from '../hooks/useMediaQuery'
import {
  CONTENT_VERSION, TEMPLATES, buildTemplate, normalizeContent, blockCount,
} from '../lib/contentBlocks'

// 商城首頁編排。內容是「區塊」，存 stores.home_blocks（正式）與 home_blocks_draft（草稿）。
//
// 草稿與發佈是分開的：儲存只動草稿，客人看到的還是舊版；按發佈才把草稿複製到正式欄位
// 並通知商城重新產生頁面。這是刻意的，讓店主可以慢慢編、編完再一次上線。
//
// 沒編過（home_blocks 為 null）時商城首頁維持既有預設版面（轉址到商品列表），
// 不是變成一片空白 —— 所以「刪光所有區塊再發佈」等於把首頁還原成預設。
export default function HomeDesignPage() {
  const { profile, store, storeId } = useAuth()
  const isOwner = profile?.role === 'super_admin'

  const [loading, setLoading] = useState(true)
  const [blocks, setBlocks] = useState([])
  const [published, setPublished] = useState(null)   // 目前線上版（原始 jsonb）
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState('')               // '' | 'saving' | 'publishing'
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [products, setProducts] = useState([])
  const [categories, setCategories] = useState([])

  // 窄螢幕塞不下「左編輯右預覽」，就不掛 iframe（連都不連），維持開新分頁預覽
  const wide = useMediaQuery('(min-width: 1200px)')

  const shopBase = (import.meta.env.DEV && import.meta.env.VITE_SHOP_URL)
    ? import.meta.env.VITE_SHOP_URL.replace(/\/+$/, '')
    : resolveShopBaseUrl(store)

  useEffect(() => {
    if (!storeId) return
    let alive = true
    setLoading(true)
    Promise.all([
      supabase.from('stores').select('home_blocks, home_blocks_draft').eq('id', storeId).maybeSingle(),
      supabase.from('storefront_products')
        .select('product_id, products(name)')
        .eq('store_id', storeId).eq('published', true).order('sort_order'),
      supabase.from('categories').select('id, name, parent_id, sort_order')
        .eq('store_id', storeId).order('sort_order').order('name'),
    ]).then(([storeRes, prodRes, catRes]) => {
      if (!alive) return
      if (storeRes.error) setError('載入失敗：' + storeRes.error.message)
      const row = storeRes.data
      // 沒有草稿時以線上版當起點（而不是空白），店主才不會誤以為內容不見了
      const source = row?.home_blocks_draft ?? row?.home_blocks ?? null
      setBlocks(normalizeContent(source)?.blocks ?? [])
      setPublished(row?.home_blocks ?? null)
      setProducts((prodRes.data || []).map(r => ({ product_id: r.product_id, name: r.products?.name || `#${r.product_id}` })))
      setCategories(catRes.data || [])
      setDirty(false)
      setLoading(false)
    })
    return () => { alive = false }
  }, [storeId])

  function onBlocksChange(next) {
    setBlocks(next)
    setDirty(true)
    setMsg('')
  }

  function applyTemplate(key) {
    if (blocks.length > 0 && !window.confirm('套用模板會覆蓋目前草稿的所有區塊，確定嗎？')) return
    const content = buildTemplate(key)
    if (!content) return
    onBlocksChange(content.blocks)
  }

  const content = { version: CONTENT_VERSION, blocks }

  async function saveDraft() {
    setError(''); setMsg(''); setBusy('saving')
    const { error: err } = await supabase.from('stores')
      .update({ home_blocks_draft: content }).eq('id', storeId)
    if (err) setError('儲存失敗：' + err.message)
    else { setDirty(false); setMsg('✓ 草稿已儲存（客人看到的還是舊版，按「發佈」才會上線）') }
    setBusy('')
  }

  async function publish() {
    setError(''); setMsg(''); setBusy('publishing')
    // 空的內容存成 null，商城才認得出「沒編過」並走預設版面
    const value = blocks.length === 0 ? null : content
    const { error: err } = await supabase.from('stores')
      .update({ home_blocks: value, home_blocks_draft: content }).eq('id', storeId)
    if (err) { setError('發佈失敗：' + err.message); setBusy(''); return }
    setPublished(value)
    setDirty(false)
    // 通知商城清快取 → 首頁立刻換上新面貌
    await revalidateShop({ storeId, slug: store?.slug })
    setMsg(value ? '✓ 已發佈，商城首頁已更新' : '✓ 已發佈：首頁還原成預設版面')
    setBusy('')
  }

  function revertToPublished() {
    if (!window.confirm('丟掉目前草稿、改回線上版內容？')) return
    setBlocks(normalizeContent(published)?.blocks ?? [])
    setDirty(true)
    setMsg('')
  }

  async function openPreview() {
    setError('')
    const { data: { session } } = await supabase.auth.getSession()
    const token = session?.access_token
    if (!token) { setError('登入憑證已失效，請重新整理頁面'); return }
    if (dirty) { setError('草稿有未儲存的變更，請先按「儲存草稿」再預覽'); return }
    window.open(`${shopBase}/preview?target=home&t=${encodeURIComponent(token)}`, '_blank', 'noopener')
  }

  if (!isOwner) return (
    <div className="page">
      <div className="empty" style={{ paddingTop: 80 }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>🔒</div>
        <div>僅店主可編排首頁</div>
      </div>
    </div>
  )

  const publishedCount = blockCount(published)

  return (
    <div className={wide ? 'page page-wide' : 'page'}>
      <div className="ph">
        <div>
          <div className="ph-title">首頁</div>
          <div className="ph-sub">
            用區塊編排商城首頁。
            {publishedCount > 0
              ? `目前線上版有 ${publishedCount} 個區塊。`
              : '目前還沒發佈過，商城首頁走預設版面（直接進商品列表）。'}
          </div>
        </div>
      </div>

      {error && <div className="error-msg" style={{ marginBottom: 12 }}>{error}</div>}
      {msg && (
        <div style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 8, background: 'var(--blue-bg)', color: 'var(--blue)', fontSize: 13 }}>
          {msg}
        </div>
      )}

      {loading ? (
        <div className="empty" style={{ paddingTop: 60 }}>載入中…</div>
      ) : (
        <div className="hd-split">
          <div style={{ minWidth: 0 }}>
            {blocks.length === 0 && (
              <>
                <div className="sec">從一套起點開始</div>
                <div className="card" style={{ padding: 16 }}>
                  <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 12 }}>
                    空白畫布不好下手。挑一套填進來，再把文字與圖片換成自己的。
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {Object.entries(TEMPLATES).map(([key, tpl]) => (
                      <button key={key} type="button" onClick={() => applyTemplate(key)}
                        style={{ textAlign: 'left', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', cursor: 'pointer' }}>
                        <div style={{ fontWeight: 600, fontSize: 14 }}>＋ {tpl.label}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>{tpl.hint}</div>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            <div className="sec" style={{ marginTop: 20 }}>
              區塊{dirty && <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>（有未儲存的變更）</span>}
            </div>
            <BlocksEditor
              blocks={blocks}
              onChange={onBlocksChange}
              storeId={storeId}
              products={products}
              categories={categories}
            />

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 20 }}>
              <button className="btn" style={{ width: 'auto', padding: '10px 20px' }}
                disabled={!!busy} onClick={saveDraft}>
                {busy === 'saving' ? '儲存中…' : '儲存草稿'}
              </button>
              <button className="btn btn-outline" style={{ width: 'auto', padding: '10px 20px' }}
                disabled={!!busy} onClick={openPreview}>
                預覽草稿
              </button>
              <button className="btn" style={{ width: 'auto', padding: '10px 20px' }}
                disabled={!!busy} onClick={publish}>
                {busy === 'publishing' ? '發佈中…' : '發佈到商城'}
              </button>
              {publishedCount > 0 && (
                <button className="btn btn-outline" style={{ width: 'auto', padding: '10px 20px' }}
                  disabled={!!busy} onClick={revertToPublished}>
                  還原成線上版
                </button>
              )}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 10, lineHeight: 1.7 }}>
              {wide
                ? '右邊的預覽跟著你打字更新，不必先儲存。儲存只動草稿，按「發佈到商城」才會上線。'
                : '儲存只動草稿，客人看到的還是舊版；按「發佈到商城」才會上線。'}<br />
              把區塊全部刪掉再發佈，首頁就還原成預設版面（直接進商品列表）。
            </div>
          </div>

          {wide && (
            <LivePreview blocks={blocks} shopBase={shopBase} target="home" />
          )}
        </div>
      )}
    </div>
  )
}
