import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import { resolveShopBaseUrl } from '../lib/socialShare'
import { revalidateShop } from '../lib/revalidateShop'
import BlocksEditor from './BlocksEditor'
import LivePreview from './LivePreview'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { CONTENT_VERSION, TEMPLATES, buildTemplate, normalizeContent, blockCount } from '../lib/contentBlocks'

// 商品介紹（區塊內容），掛在既有的上架編輯流程裡，不另開一頁。
//
// 存 storefront_products.intro_blocks（正式）與 intro_blocks_draft（草稿）。
// 刻意與上架表單的「儲存」分開存：介紹是「編好幾天再一起上線」的東西，
// 混進上架表單會讓店主改個售價就順手把還沒寫完的介紹推上線。
//
// Props: spId = storefront_products.id、productId = 商品 id
export default function ProductIntroEditor({ spId, productId }) {
  const { store, storeId } = useAuth()

  const [expanded, setExpanded] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [blocks, setBlocks] = useState([])
  const [published, setPublished] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [products, setProducts] = useState([])
  const [categories, setCategories] = useState([])
  // 這張表單本身就窄，即時預覽走右側浮動面板；螢幕不夠寬就不提供（會蓋住表單）
  const [livePreview, setLivePreview] = useState(false)
  const wide = useMediaQuery('(min-width: 1000px)')

  const shopBase = (import.meta.env.DEV && import.meta.env.VITE_SHOP_URL)
    ? import.meta.env.VITE_SHOP_URL.replace(/\/+$/, '')
    : resolveShopBaseUrl(store)

  // 展開才載入：多數人開這張表只是改價格，沒必要每次都多打三次查詢
  useEffect(() => {
    if (!expanded || loaded || !spId || !storeId) return
    let alive = true
    Promise.all([
      supabase.from('storefront_products').select('intro_blocks, intro_blocks_draft').eq('id', spId).maybeSingle(),
      supabase.from('storefront_products').select('product_id, products(name)')
        .eq('store_id', storeId).eq('published', true).order('sort_order'),
      supabase.from('categories').select('id, name, parent_id, sort_order')
        .eq('store_id', storeId).order('sort_order').order('name'),
    ]).then(([row, prodRes, catRes]) => {
      if (!alive) return
      if (row.error) setError('載入失敗：' + row.error.message)
      const source = row.data?.intro_blocks_draft ?? row.data?.intro_blocks ?? null
      setBlocks(normalizeContent(source)?.blocks ?? [])
      setPublished(row.data?.intro_blocks ?? null)
      setProducts((prodRes.data || []).map(r => ({ product_id: r.product_id, name: r.products?.name || `#${r.product_id}` })))
      setCategories(catRes.data || [])
      setLoaded(true)
    })
    return () => { alive = false }
  }, [expanded, loaded, spId, storeId])

  const content = { version: CONTENT_VERSION, blocks }

  function onBlocksChange(next) { setBlocks(next); setDirty(true); setMsg('') }

  function applyTemplate(key) {
    if (blocks.length > 0 && !window.confirm('套用模板會覆蓋目前草稿的所有區塊，確定嗎？')) return
    const built = buildTemplate(key)
    if (built) onBlocksChange(built.blocks)
  }

  async function saveDraft() {
    setError(''); setMsg(''); setBusy('saving')
    const { error: err } = await supabase.from('storefront_products')
      .update({ intro_blocks_draft: content }).eq('id', spId)
    if (err) setError('儲存失敗：' + err.message)
    else { setDirty(false); setMsg('✓ 草稿已儲存（商城上還是舊版）') }
    setBusy('')
  }

  async function publish() {
    setError(''); setMsg(''); setBusy('publishing')
    const value = blocks.length === 0 ? null : content
    const { error: err } = await supabase.from('storefront_products')
      .update({ intro_blocks: value, intro_blocks_draft: content }).eq('id', spId)
    if (err) { setError('發佈失敗：' + err.message); setBusy(''); return }
    setPublished(value); setDirty(false)
    await revalidateShop({ storeId, productIds: [productId] })
    setMsg(value ? '✓ 已發佈，商品頁已更新' : '✓ 已發佈：商品頁不再顯示介紹')
    setBusy('')
  }

  async function openPreview() {
    setError('')
    const { data: { session } } = await supabase.auth.getSession()
    const token = session?.access_token
    if (!token) { setError('登入憑證已失效，請重新整理頁面'); return }
    if (dirty) { setError('草稿有未儲存的變更，請先按「儲存草稿」再預覽'); return }
    window.open(
      `${shopBase}/preview?target=product&id=${productId}&t=${encodeURIComponent(token)}`,
      '_blank', 'noopener',
    )
  }

  if (!spId) {
    return (
      <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginBottom: 8 }}>
        先建立上架設定，才能編排商品介紹。
      </div>
    )
  }

  const publishedCount = blockCount(published)

  return (
    <div style={{ marginBottom: 20 }}>
      <button type="button" onClick={() => setExpanded(e => !e)}
        style={{
          width: '100%', textAlign: 'left', padding: '10px 12px', borderRadius: 10,
          border: '1px solid var(--border)', background: 'var(--bg)', cursor: 'pointer',
        }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 600, fontSize: 13.5, flex: 1 }}>
            商品介紹（區塊）
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
            {publishedCount > 0 ? `線上 ${publishedCount} 個區塊` : '未發佈'}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{expanded ? '▲' : '▼'}</span>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>
          比「中文描述」更完整的介紹版面，顯示在商品詳情頁下方。草稿與發佈分開。
        </div>
      </button>

      {expanded && (
        <div style={{ marginTop: 10 }}>
          {error && <div className="error-msg" style={{ marginBottom: 10 }}>{error}</div>}
          {msg && (
            <div style={{ marginBottom: 10, padding: '8px 12px', borderRadius: 8, background: 'var(--blue-bg)', color: 'var(--blue)', fontSize: 13 }}>
              {msg}
            </div>
          )}
          {!loaded ? (
            <div style={{ fontSize: 13, color: 'var(--text-3)', padding: '12px 0' }}>載入中…</div>
          ) : (
            <>
              {blocks.length === 0 && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                  {Object.entries(TEMPLATES).map(([key, tpl]) => (
                    <button key={key} type="button" className="btn btn-outline"
                      style={{ width: 'auto', padding: '7px 14px', fontSize: 13 }}
                      onClick={() => applyTemplate(key)}>
                      套用「{tpl.label}」
                    </button>
                  ))}
                </div>
              )}
              <BlocksEditor
                blocks={blocks}
                onChange={onBlocksChange}
                storeId={storeId}
                products={products}
                categories={categories}
              />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
                <button type="button" className="btn" style={{ width: 'auto', padding: '9px 18px' }}
                  disabled={!!busy} onClick={saveDraft}>
                  {busy === 'saving' ? '儲存中…' : '儲存草稿'}
                </button>
                <button type="button" className="btn btn-outline" style={{ width: 'auto', padding: '9px 18px' }}
                  disabled={!!busy} onClick={openPreview}>
                  預覽草稿
                </button>
                {wide && (
                  <button type="button" className="btn btn-outline" style={{ width: 'auto', padding: '9px 18px' }}
                    onClick={() => setLivePreview(v => !v)}>
                    {livePreview ? '關閉即時預覽' : '即時預覽'}
                  </button>
                )}
                <button type="button" className="btn" style={{ width: 'auto', padding: '9px 18px' }}
                  disabled={!!busy} onClick={publish}>
                  {busy === 'publishing' ? '發佈中…' : '發佈到商城'}
                </button>
              </div>
              {dirty && (
                <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8 }}>有未儲存的變更</div>
              )}

              {livePreview && wide && (
                <LivePreview
                  blocks={blocks}
                  shopBase={shopBase}
                  target="product"
                  productId={productId}
                  mode="dock"
                  onClose={() => setLivePreview(false)}
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
