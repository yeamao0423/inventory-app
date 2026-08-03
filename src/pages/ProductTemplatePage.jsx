import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import { resolveShopBaseUrl } from '../lib/socialShare'
import { revalidateShop } from '../lib/revalidateShop'
import ProductPageEditor from '../components/ProductPageEditor'
import CustomSelect from '../components/CustomSelect'
import {
  ALL_BLOCK_TYPES, CONTENT_VERSION,
  blockCount, buildProductTemplate, normalizeProductContent,
} from '../lib/contentBlocks'
import '../styles/product-editor.css'

// 商品頁編排（範本與單一商品覆寫共用這張薄殼）。
//
// 兩個路由進來的是同一個元件：
//   /product-template        全店範本 → stores.product_template_blocks(_draft)
//   /storefront/:spId/page   單一商品 → storefront_products.page_blocks(_draft)
// 差別只有讀寫哪張表、以及覆寫模式多一組「脫離範本／還原成範本」。編輯器本體完全一樣，
// 分成兩個頁面元件只會讓草稿發佈那段邏輯被抄兩份，然後慢慢長歪。
//
// 草稿與發佈分離，做法與首頁編排一致（HomeDesignPage）：儲存只動 _draft，
// 按發佈才複製到正式欄位並通知商城清快取。
//
// 空版面的意義在兩個模式裡不一樣，這是這張頁面唯一需要小心的地方：
//   範本：空 → 存 null → 商品頁走內建版型（等於「沒編過」）
//   覆寫：空 → 存 {blocks: []} → 這件商品就是空白版面（店主刻意清空）
//         要回去跟隨範本得按「還原成範本」，那才是寫 null 的路徑
// 資料層分得開，商城端才有辦法照計畫書 §9 的表格處理。
export default function ProductTemplatePage() {
  const { spId } = useParams()
  const navigate = useNavigate()
  const isOverride = !!spId
  const { profile, store, storeId } = useAuth()
  const isOwner = profile?.role === 'super_admin'

  const [loading, setLoading] = useState(true)
  const [blocks, setBlocks] = useState([])
  const [published, setPublished] = useState(null)     // 目前線上版（原始 jsonb）
  const [templateRaw, setTemplateRaw] = useState(null) // 覆寫模式：全店範本，脫離時複製它
  const [following, setFollowing] = useState(false)    // 覆寫模式：目前跟隨範本（沒有自己的版面）
  const [productId, setProductId] = useState(null)     // 預覽拿哪件商品當範例
  const [productName, setProductName] = useState('')
  const [products, setProducts] = useState([])
  const [categories, setCategories] = useState([])
  const [fatal, setFatal] = useState(false)            // 這個 :spId 根本不存在 → 沒有東西可編
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState('')                 // '' | 'saving' | 'publishing' | 'resetting'
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')

  const shopBase = (import.meta.env.DEV && import.meta.env.VITE_SHOP_URL)
    ? import.meta.env.VITE_SHOP_URL.replace(/\/+$/, '')
    : resolveShopBaseUrl(store)

  useEffect(() => {
    if (!storeId) return
    let alive = true
    setLoading(true)
    Promise.all([
      supabase.from('stores')
        .select('product_template_blocks, product_template_blocks_draft')
        .eq('id', storeId).maybeSingle(),
      supabase.from('storefront_products')
        .select('product_id, products(name)')
        .eq('store_id', storeId).eq('published', true).order('sort_order'),
      supabase.from('categories').select('id, name, parent_id, sort_order')
        .eq('store_id', storeId).order('sort_order').order('name'),
      // 覆寫模式才需要那一列；範本模式送 null 進 Promise.all 比多寫一組分支乾淨
      isOverride
        ? supabase.from('storefront_products')
          .select('id, product_id, page_blocks, page_blocks_draft, products(name)')
          .eq('id', spId).eq('store_id', storeId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]).then(([storeRes, prodRes, catRes, spRes]) => {
      if (!alive) return
      if (storeRes.error) setError('載入失敗：' + storeRes.error.message)

      const storeRow = storeRes.data
      const tpl = storeRow?.product_template_blocks_draft ?? storeRow?.product_template_blocks ?? null
      setTemplateRaw(tpl)

      const list = (prodRes.data || []).map(r => ({
        product_id: r.product_id,
        name: r.products?.name || `#${r.product_id}`,
      }))
      setProducts(list)
      setCategories(catRes.data || [])

      if (isOverride) {
        const row = spRes.data
        if (spRes.error || !row) {
          setError(spRes.error ? '載入失敗：' + spRes.error.message : '找不到這件上架商品（可能已被刪除）。')
          setFatal(true)
          setLoading(false)
          return
        }
        setFatal(false)
        const source = row.page_blocks_draft ?? row.page_blocks ?? null
        setFollowing(source == null)
        // 跟隨範本時清單顯示的是範本內容（唯讀情境），店主按「脫離範本」才真的成為自己的
        setBlocks(normalizeProductContent(source ?? tpl)?.blocks ?? [])
        setPublished(row.page_blocks ?? null)
        setProductId(row.product_id)
        setProductName(row.products?.name || `#${row.product_id}`)
      } else {
        setBlocks(normalizeProductContent(tpl)?.blocks ?? [])
        setPublished(storeRow?.product_template_blocks ?? null)
        // 範本沒有「自己的商品」，隨便挑一件上架中的當預覽對象；店主可以在面板頂端換
        setProductId(list[0]?.product_id ?? null)
      }
      setDirty(false)
      setLoading(false)
    })
    return () => { alive = false }
  }, [storeId, spId, isOverride])

  const content = { version: CONTENT_VERSION, blocks }

  function onBlocksChange(next) {
    setBlocks(next)
    setDirty(true)
    setMsg('')
  }

  async function saveDraft() {
    setError(''); setMsg(''); setBusy('saving')
    const { error: err } = isOverride
      ? await supabase.from('storefront_products').update({ page_blocks_draft: content }).eq('id', spId)
      : await supabase.from('stores').update({ product_template_blocks_draft: content }).eq('id', storeId)
    if (err) setError('儲存失敗：' + err.message)
    else { setDirty(false); setMsg('✓ 草稿已儲存（客人看到的還是舊版，按「發佈」才會上線）') }
    setBusy('')
  }

  async function publish() {
    setError(''); setMsg(''); setBusy('publishing')
    if (isOverride) {
      // 覆寫模式空陣列照存：null 是「跟隨範本」的專用值，不能拿來表示「刻意清空」
      const { error: err } = await supabase.from('storefront_products')
        .update({ page_blocks: content, page_blocks_draft: content }).eq('id', spId)
      if (err) { setError('發佈失敗：' + err.message); setBusy(''); return }
      setPublished(content); setFollowing(false); setDirty(false)
      await revalidateShop({ storeId, productIds: [productId] })
      setMsg(blocks.length === 0
        ? '✓ 已發佈：這件商品現在是空白版面'
        : '✓ 已發佈，這件商品的頁面已更新')
    } else {
      // 範本模式空的存 null，商城才認得出「沒編過」並走內建版型
      const value = blocks.length === 0 ? null : content
      const { error: err } = await supabase.from('stores')
        .update({ product_template_blocks: value, product_template_blocks_draft: content }).eq('id', storeId)
      if (err) { setError('發佈失敗：' + err.message); setBusy(''); return }
      setPublished(value); setDirty(false)
      // 範本影響全店每一頁商品，清整家店的快取而不是單一商品
      await revalidateShop({ storeId, slug: store?.slug })
      setMsg(value ? '✓ 已發佈，全店商品頁已換上新版面' : '✓ 已發佈：商品頁還原成內建版型')
    }
    setBusy('')
  }

  function revertToPublished() {
    if (!window.confirm('丟掉目前草稿、改回線上版內容？')) return
    setBlocks(normalizeProductContent(published)?.blocks ?? [])
    setDirty(true)
    setMsg('')
  }

  // 脫離範本：把當下範本複製一份成為這件商品自己的草稿。
  // 只動本地狀態，要按「儲存草稿」才進資料庫 —— 按錯的人可以直接離開頁面當作沒發生。
  function detachFromTemplate() {
    const base = normalizeProductContent(templateRaw) ?? buildProductTemplate()
    setBlocks(base.blocks)
    setFollowing(false)
    setDirty(true)
    setMsg('已複製一份範本內容，改完記得儲存草稿。')
  }

  // 還原成範本：把兩個欄位都設回 null。這是唯一寫 null 的路徑，
  // 也因為它會直接影響線上版，所以不走草稿、按下去就生效（並且要確認）。
  async function resetToTemplate() {
    if (!window.confirm('這件商品會回去跟隨全店範本，它自己的版面（含草稿）會被刪掉，確定嗎？')) return
    setError(''); setMsg(''); setBusy('resetting')
    const { error: err } = await supabase.from('storefront_products')
      .update({ page_blocks: null, page_blocks_draft: null }).eq('id', spId)
    if (err) { setError('還原失敗：' + err.message); setBusy(''); return }
    setPublished(null)
    setFollowing(true)
    setBlocks(normalizeProductContent(templateRaw)?.blocks ?? [])
    setDirty(false)
    await revalidateShop({ storeId, productIds: [productId] })
    setMsg('✓ 已還原：這件商品跟著全店範本走')
    setBusy('')
  }

  if (!isOwner) return (
    <div className="page">
      <div className="empty" style={{ paddingTop: 80 }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>🔒</div>
        <div>僅店主可編排商品頁</div>
      </div>
    </div>
  )

  const publishedCount = blockCount(published, { allow: ALL_BLOCK_TYPES })
  const templateCount = blockCount(templateRaw, { allow: ALL_BLOCK_TYPES })
  const missingCta = blocks.length > 0 && !blocks.some(b => b.type === 'product_cta')

  const footer = (
    <div>
      {missingCta && (
        <div className="pe-warn" style={{ marginBottom: 10 }}>
          這個版面沒有購買按鈕，客人將無法下單。
        </div>
      )}
      {isOverride && blocks.length === 0 && (
        <div className="pe-warn" style={{ marginBottom: 10 }}>
          版面是空的，發佈後這件商品會是一片空白。要回去跟隨範本請按「還原成範本」。
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn" style={{ width: 'auto', padding: '9px 18px' }}
          disabled={!!busy} onClick={saveDraft}>
          {busy === 'saving' ? '儲存中…' : '儲存草稿'}
        </button>
        <button className="btn" style={{ width: 'auto', padding: '9px 18px' }}
          disabled={!!busy} onClick={publish}>
          {busy === 'publishing' ? '發佈中…' : '發佈到商城'}
        </button>
        {publishedCount > 0 && (
          <button className="btn btn-outline" style={{ width: 'auto', padding: '9px 18px' }}
            disabled={!!busy} onClick={revertToPublished}>
            還原成線上版
          </button>
        )}
        {isOverride && (
          <button className="btn btn-outline" style={{ width: 'auto', padding: '9px 18px' }}
            disabled={!!busy} onClick={resetToTemplate}>
            {busy === 'resetting' ? '還原中…' : '還原成範本'}
          </button>
        )}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 9, lineHeight: 1.7 }}>
        {dirty ? '有未儲存的變更。' : ''}
        右邊的預覽跟著你編輯更新，不必先儲存；儲存只動草稿，按「發佈到商城」才會上線。
      </div>
    </div>
  )

  const header = isOverride ? (
    <span className="pe-head-title">{productName}</span>
  ) : (
    <>
      <span className="pe-head-sub" style={{ flexShrink: 0 }}>預覽商品</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <CustomSelect
          compact
          label="— 挑一件來試版面 —"
          value={productId}
          options={products.map(p => ({ value: p.product_id, label: p.name }))}
          onChange={(v) => { if (v != null) setProductId(v) }}
          allowClear={false}
          emptyText="這家店還沒有上架商品"
        />
      </div>
    </>
  )

  const emptyAction = !isOverride && (
    <button type="button" className="btn btn-outline" style={{ width: 'auto', padding: '8px 16px' }}
      onClick={() => onBlocksChange(buildProductTemplate().blocks)}>
      從現有版型開始
    </button>
  )

  return (
    <div className="page page-wide">
      <div className="ph">
        <div>
          <div className="ph-title">{isOverride ? `商品頁：${productName}` : '商品頁範本'}</div>
          <div className="ph-sub">
            {isOverride
              ? (following
                ? `這件商品目前跟隨全店範本${templateCount > 0 ? `（${templateCount} 個區塊）` : ''}。`
                : '這件商品有自己的版面，不受全店範本影響。')
              : (publishedCount > 0
                ? `全店商品頁共用這個版面，目前線上版有 ${publishedCount} 個區塊。`
                : '還沒發佈過，所有商品頁都走內建版型。編好發佈後才會換上。')}
          </div>
        </div>
        {isOverride && (
          <button className="btn btn-outline" style={{ width: 'auto', padding: '8px 14px', fontSize: 13 }}
            onClick={() => navigate('/product-template')}>
            編輯全店範本
          </button>
        )}
      </div>

      {error && <div className="error-msg" style={{ marginBottom: 12 }}>{error}</div>}
      {msg && (
        <div className="pe-note" style={{ marginBottom: 12 }}>{msg}</div>
      )}

      {loading ? (
        <div className="empty" style={{ paddingTop: 60 }}>載入中…</div>
      ) : fatal ? (
        <button className="btn btn-outline" style={{ width: 'auto', padding: '9px 18px' }}
          onClick={() => navigate('/products?tab=listings')}>
          回到上架清單
        </button>
      ) : (isOverride && following) ? (
        // 跟隨範本時不給編輯：這裡改了東西，店主會以為改的是這一件，其實動到的是全店。
        // 要單獨排版就先明確「脫離」，之後兩邊各走各的。
        <div className="card" style={{ padding: 20, maxWidth: 560 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>目前跟隨全店範本</div>
          <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.8, marginBottom: 16 }}>
            {templateCount > 0
              ? `這件商品的頁面由全店範本（${templateCount} 個區塊）決定，範本改了它就跟著改。`
              : '全店範本還沒編排，這件商品的頁面走內建版型。'}<br />
            只有這一件要不一樣的話，按下面的按鈕複製一份範本開始改；
            之後範本再怎麼改都不會影響它。
          </div>
          <button className="btn" style={{ width: 'auto', padding: '9px 18px' }}
            onClick={detachFromTemplate}>
            脫離範本，單獨排版
          </button>
        </div>
      ) : (
        <ProductPageEditor
          blocks={blocks}
          onChange={onBlocksChange}
          shopBase={shopBase}
          productId={productId}
          storeId={storeId}
          products={products}
          categories={categories}
          header={header}
          footer={footer}
          emptyAction={emptyAction}
        />
      )}
    </div>
  )
}
