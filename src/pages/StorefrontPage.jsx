import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import CustomSelect from '../components/CustomSelect'
import {
  PLATFORMS, DEFAULT_SHARE_TEMPLATE, renderTemplate, buildShareUrl,
  buildProductUrl, resolveShopBaseUrl,
} from '../lib/socialShare'
import { buildCollageBlob, canShareFile, downloadBlob } from '../lib/shareImage'
import { revalidateShop } from '../lib/revalidateShop'

export default function StorefrontPage() {
  const { can, storeId, store } = useAuth()
  // 改動商品後通知商城清快取（store tag 涵蓋列表＋所有商品詳情）
  const syncShop = () => revalidateShop({ storeId, slug: store?.slug })
  const [tab, setTab] = useState('listings')   // listings | taxonomy
  const [listings, setListings] = useState([])
  const [products, setProducts] = useState([])
  const [categories, setCategories] = useState([])
  const [tags, setTags] = useState([])
  const [optionTypes, setOptionTypes] = useState([])
  const [newCat, setNewCat] = useState({ name: '', name_en: '' })
  const [newTag, setNewTag] = useState({ name: '', name_en: '' })
  const [newOptTypeName, setNewOptTypeName] = useState('')
  const [newOptValues, setNewOptValues] = useState({}) // { typeId: inputString }
  const [loading, setLoading] = useState(true)
  const [sheet, setSheet] = useState(null)     // null | 'add' | listing obj
  const [shareItem, setShareItem] = useState(null)  // 分享面板：上架商品 listing obj
  const [exchangeRates, setExchangeRates] = useState({})
  const [filter, setFilter] = useState('all')   // all | published | unpublished | sold_out | expired
  const [search, setSearch] = useState('')
  const [filterCat, setFilterCat] = useState('')
  const [filterTag, setFilterTag] = useState('')
  const [filterSource, setFilterSource] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [page, setPage] = useState(1)
  const PAGE_SIZE = 15

  useEffect(() => {
    if (!storeId) return
    supabase.from('exchange_rates').select('*').eq('store_id', storeId)
      .then(({ data }) => {
        const map = {}
        ;(data || []).forEach(r => { map[r.currency] = Number(r.rate) })
        setExchangeRates(map)
      })
  }, [storeId])
  useEffect(() => {
    if (!storeId) return
    fetchAll()
  }, [tab, storeId])

  async function fetchAll() {
    setLoading(true)
    if (tab === 'listings') {
      const [{ data: sp }, { data: pr }, { data: cats }, { data: tgs }] = await Promise.all([
        supabase.from('storefront_products').select('*, products(*, product_images(id, url, sort_order), categories(id, name), product_tags(tag_id))').eq('store_id', storeId).order('sort_order'),
        supabase.from('products').select('id, name, sku, cost, currency').eq('store_id', storeId).order('name'),
        supabase.from('categories').select('id, name').eq('store_id', storeId).order('sort_order').order('name'),
        supabase.from('tags').select('id, name').eq('store_id', storeId).order('sort_order').order('name'),
      ])
      setListings(sp || [])
      setCategories(cats || [])
      setTags(tgs || [])
      const listed = new Set((sp || []).map(s => s.product_id))
      setProducts((pr || []).filter(p => !listed.has(p.id)))
    } else if (tab === 'taxonomy') {
      const [{ data: cats }, { data: tgs }, { data: opts }] = await Promise.all([
        supabase.from('categories').select('*').eq('store_id', storeId).order('sort_order').order('name'),
        supabase.from('tags').select('*').eq('store_id', storeId).order('sort_order').order('name'),
        supabase.from('variant_option_types')
          .select('*, variant_option_values(id, value, sort_order)')
          .eq('store_id', storeId)
          .order('sort_order').order('name'),
      ])
      setCategories(cats || [])
      setTags(tgs || [])
      setOptionTypes(opts || [])
    }
    setLoading(false)
  }

  async function addCategory() {
    if (!newCat.name.trim()) return
    await supabase.from('categories').insert({ name: newCat.name.trim(), name_en: newCat.name_en.trim() || null, store_id: storeId })
    setNewCat({ name: '', name_en: '' })
    fetchAll()
  }

  async function deleteCategory(id) {
    if (!window.confirm('刪除此分類？（已設定的商品分類將變為空）')) return
    await supabase.from('categories').delete().eq('id', id)
    fetchAll()
  }

  async function addTag() {
    if (!newTag.name.trim()) return
    await supabase.from('tags').insert({ name: newTag.name.trim(), name_en: newTag.name_en.trim() || null, store_id: storeId })
    setNewTag({ name: '', name_en: '' })
    fetchAll()
  }

  async function deleteTag(id) {
    if (!window.confirm('刪除此標籤？（已套用的商品標籤將一併移除）')) return
    await supabase.from('tags').delete().eq('id', id)
    fetchAll()
  }

  async function addOptionType() {
    if (!newOptTypeName.trim()) return
    const { error } = await supabase.from('variant_option_types').insert({ name: newOptTypeName.trim(), store_id: storeId })
    if (error) { alert('建立失敗：' + error.message); return }
    setNewOptTypeName('')
    fetchAll()
  }

  async function deleteOptionType(id) {
    if (!window.confirm('刪除此規格類型？（所有相關規格值和商品規格將一併刪除）')) return
    await supabase.from('variant_option_types').delete().eq('id', id)
    fetchAll()
  }

  async function addOptionValue(typeId) {
    const val = (newOptValues[typeId] || '').trim()
    if (!val) return
    const { error } = await supabase.from('variant_option_values').insert({ option_type_id: typeId, value: val })
    if (error) { alert('新增失敗：' + error.message); return }
    setNewOptValues(f => ({ ...f, [typeId]: '' }))
    fetchAll()
  }

  async function deleteOptionValue(id) {
    await supabase.from('variant_option_values').delete().eq('id', id)
    fetchAll()
  }

  // Check if product has any stock (base qty or any variant stock > 0)
  function hasStock(item) {
    const baseQty = item.products?.quantity || 0
    // variants are loaded in ListingSheet, but for listing display we check base qty
    // For a more accurate check we'd need to query variants, but base qty is sufficient for toggle
    return baseQty > 0
  }

  const [collectionPrompt, setCollectionPrompt] = useState(null) // { item, collectionEnd }

  async function togglePublish(item) {
    if (!item.published) {
      // Going from unpublished → published: check stock
      const { data: vars } = await supabase
        .from('product_variants').select('stock').eq('product_id', item.product_id)
      const hasVariantStock = (vars || []).some(v => v.stock > 0)
      const baseQty = item.products?.quantity || 0
      const hasAnyStock = baseQty > 0 || hasVariantStock

      if (!hasAnyStock && !item.collection_end && !item.skip_stock_check) {
        // No stock → prompt for collection end time
        setCollectionPrompt({ item, collectionEnd: '' })
        return
      }
    }
    await supabase.from('storefront_products')
      .update({ published: !item.published })
      .eq('id', item.id)
    syncShop()
    fetchAll()
  }

  async function confirmCollectionPublish() {
    if (!collectionPrompt?.collectionEnd) return
    await supabase.from('storefront_products')
      .update({ published: true, collection_end: localToISO(collectionPrompt.collectionEnd), skip_stock_check: true })
      .eq('id', collectionPrompt.item.id)
    setCollectionPrompt(null)
    syncShop()
    fetchAll()
  }

  async function toggleSoldOut(item) {
    await supabase.from('storefront_products')
      .update({ sold_out: !item.sold_out })
      .eq('id', item.id)
    syncShop()
    fetchAll()
  }

  async function deleteListing(id) {
    if (!window.confirm('確定從商城下架並刪除此設定？')) return
    await supabase.from('storefront_products').delete().eq('id', id)
    syncShop()
    fetchAll()
  }


  return (
    <div className="page">
      <div className="ph">
        <div>
          <div className="ph-title">商城管理</div>
          <div className="ph-sub">前台上架設定</div>
        </div>
        {tab === 'listings' && can('add') && (
          <button className="icon-btn" onClick={() => setSheet('add')} title="上架商品">+</button>
        )}
      </div>

      {/* Tab switcher */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {[
          { key: 'listings', label: '商城商品' },
          { key: 'taxonomy', label: '分類/標籤/規格' },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              flex: 1, padding: '9px 0', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600,
              background: tab === t.key ? 'var(--text)' : 'var(--card)',
              color: tab === t.key ? '#fff' : 'var(--text-2)',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Search & filters (only on listings tab) */}
      {tab === 'listings' && (() => {
        const statusFilters = [
          { key: 'all', label: '全部' },
          { key: 'published', label: '上架中' },
          { key: 'unpublished', label: '已下架' },
          { key: 'sold_out', label: '缺貨中' },
          { key: 'expired', label: '已截止' },
        ]
        const sources = [...new Set(listings.map(l => l.products?.source).filter(Boolean))].sort()
        const catIds = [...new Set(listings.map(l => l.products?.category_id).filter(Boolean))]
        const catsInUse = categories.filter(c => catIds.includes(c.id))
        const tagIds = [...new Set(listings.flatMap(l => (l.products?.product_tags || []).map(pt => pt.tag_id)))]
        const tagsInUse = tags.filter(t => tagIds.includes(t.id))
        const hasActiveFilter = filter !== 'all' || filterCat || filterTag || filterSource || search
        const activeLabel = statusFilters.find(f => f.key === filter)?.label || '全部'
        // count filtered results for the button label
        const countFiltered = listings.filter(item => {
          if (filter === 'published' && !(item.published && !item.sold_out)) return false
          if (filter === 'unpublished' && item.published) return false
          if (filter === 'sold_out' && !item.sold_out) return false
          if (filter === 'expired' && !(item.collection_end && new Date(item.collection_end) < new Date() && !item.sold_out)) return false
          if (search) {
            const q = search.toLowerCase()
            const name = (item.products?.name || '').toLowerCase()
            const sku = (item.products?.sku || '').toLowerCase()
            if (!name.includes(q) && !sku.includes(q)) return false
          }
          if (filterCat && item.products?.category_id !== Number(filterCat)) return false
          if (filterTag && !(item.products?.product_tags || []).some(pt => pt.tag_id === Number(filterTag))) return false
          if (filterSource && item.products?.source !== filterSource) return false
          return true
        }).length
        return (
          <>
            {/* 搜尋列 */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <div style={{
                flex: 1, display: 'flex', alignItems: 'center', gap: 8,
                padding: '0 12px', borderRadius: 12, border: '1px solid var(--border)',
                background: 'var(--card)', height: 42,
              }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  value={search}
                  onChange={e => { setSearch(e.target.value); setPage(1) }}
                  placeholder="搜尋商品名稱或 SKU…"
                  style={{
                    flex: 1, border: 'none', outline: 'none', background: 'transparent',
                    fontSize: 14, color: 'var(--text)', minWidth: 0,
                  }}
                />
                {search && (
                  <button onClick={() => { setSearch(''); setPage(1) }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--text-3)', fontSize: 16, lineHeight: 1 }}>✕</button>
                )}
              </div>
            </div>

            {/* 篩選列（可收合） */}
            <button
              onClick={() => setShowFilters(f => !f)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                padding: '10px 14px', borderRadius: 12, border: '1px solid var(--border)',
                background: 'var(--card)', cursor: 'pointer', marginBottom: showFilters ? 0 : 12,
                fontSize: 14, fontWeight: 600, color: 'var(--text)',
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="4" y1="6" x2="20" y2="6" /><line x1="8" y1="12" x2="20" y2="12" /><line x1="12" y1="18" x2="20" y2="18" />
              </svg>
              {activeLabel}（{countFiltered}）
              {hasActiveFilter && (
                <span style={{
                  width: 6, height: 6, borderRadius: '50%', background: '#3b82f6', flexShrink: 0,
                }} />
              )}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ marginLeft: 'auto', transition: 'transform .2s', transform: showFilters ? 'rotate(180deg)' : '' }}>
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>

            {showFilters && (
              <div style={{ padding: '12px 0 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                {/* 狀態 pills */}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {statusFilters.map(f => {
                    const count = f.key === 'all'
                      ? listings.length
                      : f.key === 'published' ? listings.filter(l => l.published && !l.sold_out).length
                      : f.key === 'unpublished' ? listings.filter(l => !l.published).length
                      : f.key === 'sold_out' ? listings.filter(l => l.sold_out).length
                      : listings.filter(l => l.collection_end && new Date(l.collection_end) < new Date() && !l.sold_out).length
                    const isActive = filter === f.key
                    return (
                      <button
                        key={f.key}
                        onClick={() => { setFilter(f.key); setPage(1) }}
                        style={{
                          padding: '6px 12px', borderRadius: 20, border: '1px solid var(--border)',
                          background: isActive ? 'var(--text)' : 'var(--card)',
                          color: isActive ? '#fff' : 'var(--text-2)',
                          fontSize: 13, fontWeight: isActive ? 700 : 400, cursor: 'pointer',
                        }}
                      >
                        {f.label}（{count}）
                      </button>
                    )
                  })}
                </div>
                {/* 下拉篩選 */}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {catsInUse.length > 0 && (
                    <CustomSelect compact
                      label="全部分類"
                      value={filterCat || null}
                      options={catsInUse.map(c => ({ value: String(c.id), label: c.name }))}
                      onChange={v => { setFilterCat(v || ''); setPage(1) }}
                      style={{ flex: 1, minWidth: 100 }}
                    />
                  )}
                  {tagsInUse.length > 0 && (
                    <CustomSelect compact
                      label="全部標籤"
                      value={filterTag || null}
                      options={tagsInUse.map(t => ({ value: String(t.id), label: t.name }))}
                      onChange={v => { setFilterTag(v || ''); setPage(1) }}
                      style={{ flex: 1, minWidth: 100 }}
                    />
                  )}
                  {sources.length > 0 && (
                    <CustomSelect compact
                      label="全部來源"
                      value={filterSource || null}
                      options={sources.map(s => ({ value: s, label: s }))}
                      onChange={v => { setFilterSource(v || ''); setPage(1) }}
                      style={{ flex: 1, minWidth: 100 }}
                    />
                  )}
                </div>
                {/* 清除全部 */}
                {hasActiveFilter && (
                  <button
                    onClick={() => { setFilter('all'); setFilterCat(''); setFilterTag(''); setFilterSource(''); setSearch(''); setPage(1) }}
                    style={{ alignSelf: 'flex-start', fontSize: 12, color: 'var(--red, #ef4444)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0' }}
                  >
                    清除全部篩選
                  </button>
                )}
              </div>
            )}
          </>
        )
      })()}

      {loading && <div className="empty">載入中…</div>}

      {/* Listings tab */}
      {!loading && tab === 'listings' && (() => {
        const filtered = listings.filter(item => {
          // Status filter
          if (filter === 'published' && !(item.published && !item.sold_out)) return false
          if (filter === 'unpublished' && item.published) return false
          if (filter === 'sold_out' && !item.sold_out) return false
          if (filter === 'expired' && !(item.collection_end && new Date(item.collection_end) < new Date() && !item.sold_out)) return false
          // Search
          if (search) {
            const q = search.toLowerCase()
            const name = (item.products?.name || '').toLowerCase()
            const sku = (item.products?.sku || '').toLowerCase()
            if (!name.includes(q) && !sku.includes(q)) return false
          }
          // Category
          if (filterCat && item.products?.category_id !== Number(filterCat)) return false
          // Tag
          if (filterTag && !(item.products?.product_tags || []).some(pt => pt.tag_id === Number(filterTag))) return false
          // Source
          if (filterSource && item.products?.source !== filterSource) return false
          return true
        })
        // Pagination
        const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
        const safePage = Math.min(page, totalPages)
        const paged = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
        return (
        <>
          {paged.length === 0 && (
            <div className="empty">{listings.length === 0 ? '尚未上架任何商品，點右上角 + 開始上架' : '沒有符合篩選條件的商品'}</div>
          )}
          <div className="card-grid">
          {paged.map(item => {
            const isCollection = !!item.collection_end
            const collectionExpired = isCollection && new Date(item.collection_end) < new Date()
            const modeLabel = item.sold_out
              ? '缺貨中'
              : isCollection
                ? (collectionExpired ? '已截止' : `收單至 ${new Date(item.collection_end).toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`)
                : '現貨'
            const modeBadge = item.sold_out
              ? 'badge-low'
              : (isCollection && collectionExpired) ? 'badge-warn' : 'badge-blue'

            const thumb = item.products?.product_images?.sort((a, b) => a.sort_order - b.sort_order)[0]?.url
            return (
              <div className="card" key={item.id} style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{ display: 'flex', gap: 0 }}>
                  {/* 左側縮圖 */}
                  {thumb
                    ? <img src={thumb} style={{ width: 80, height: 80, objectFit: 'cover', flexShrink: 0 }} />
                    : <div style={{ width: 80, height: 80, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f5f5', fontSize: 28 }}>🛍️</div>}
                  {/* 右側資訊 */}
                  <div style={{ flex: 1, minWidth: 0, padding: '10px 12px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span className="fw600 fs15" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '50%' }}>{item.products?.name}</span>
                      <span className={`badge ${item.published ? 'badge-ok' : 'badge-warn'}`} style={{ fontSize: 11 }}>
                        {item.published ? '上架中' : '已下架'}
                      </span>
                      <span className={`badge ${modeBadge}`} style={{ fontSize: 11 }}>{modeLabel}</span>
                    </div>
                    <div className="muted fs12">
                      {item.products?.sku && <span>{item.products.sku} · </span>}
                      售價 NT${Number(item.shop_price).toLocaleString()}
                      {item.products?.cost != null && (() => {
                        const cur = item.products.currency || 'TWD'
                        const cost = Number(item.products.cost)
                        const isTWD = cur === 'TWD'
                        const rate = exchangeRates[cur]
                        const twdCost = !isTWD && rate ? Math.round(cost * rate * 10) / 10 : null
                        return (
                          <span style={{ color: 'var(--text-3)' }}>
                            {' · 成本 '}{cost.toLocaleString()} {cur}
                            {twdCost != null && ` ≈ ${twdCost.toLocaleString()} TWD`}
                          </span>
                        )
                      })()}
                    </div>
                    {item.name_en && <div className="muted fs12">{item.name_en}</div>}
                  </div>
                </div>
                {/* 底部操作按鈕 */}
                {(can('edit') || can('delete')) && (
                  <div style={{ display: 'flex', gap: 8, padding: '8px 12px', borderTop: '1px solid var(--border-light, #f0f0f0)', background: '#fafafa' }}>
                    {can('edit') && (
                      <>
                        <button onClick={() => setSheet(item)} style={smallBtn}>設定</button>
                        <button onClick={() => toggleSoldOut(item)} style={{ ...smallBtn, background: item.sold_out ? '#e8f7ee' : '#fff0e8', color: item.sold_out ? 'var(--green)' : 'var(--red)', borderColor: 'transparent' }}>
                          {item.sold_out ? '恢復' : '缺貨'}
                        </button>
                        <button
                          onClick={() => togglePublish(item)}
                          style={{ ...smallBtn, background: item.published ? '#fff0e8' : '#e8f7ee', color: item.published ? 'var(--red)' : 'var(--green)', borderColor: 'transparent' }}
                        >
                          {item.published ? '下架' : '上架'}
                        </button>
                      </>
                    )}
                    {item.published && (
                      <button onClick={() => setShareItem(item)}
                        style={{ ...smallBtn, background: '#eef4ff', color: 'var(--blue)', borderColor: 'transparent' }}>
                        分享
                      </button>
                    )}
                    <div style={{ flex: 1 }} />
                    {can('delete') && (
                      <button onClick={() => deleteListing(item.id)} style={{ ...smallBtn, color: 'var(--red)' }}>刪除</button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
          </div>

          {/* 分頁 */}
          {totalPages > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 20, flexWrap: 'wrap' }}>
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={safePage === 1}
                style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', cursor: safePage === 1 ? 'default' : 'pointer', opacity: safePage === 1 ? 0.4 : 1 }}
              >
                ‹
              </button>
              {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
                <button
                  key={p}
                  onClick={() => setPage(p)}
                  style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)', background: p === safePage ? 'var(--text)' : 'var(--bg)', color: p === safePage ? '#fff' : 'var(--text)', cursor: 'pointer', fontWeight: p === safePage ? 700 : 400, minWidth: 36 }}
                >
                  {p}
                </button>
              ))}
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={safePage === totalPages}
                style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', cursor: safePage === totalPages ? 'default' : 'pointer', opacity: safePage === totalPages ? 0.4 : 1 }}
              >
                ›
              </button>
            </div>
          )}
        </>
        )
      })()}

      {/* Taxonomy tab */}
      {!loading && tab === 'taxonomy' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

          {/* Categories */}
          <div>
            <div className="sec">商品分類（每件商品只屬於一個分類）</div>
            {categories.length === 0 && <div className="muted fs13" style={{ marginBottom: 12 }}>尚未建立分類</div>}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              {categories.map(c => (
                <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 20, padding: '5px 12px' }}>
                  <span className="fs13 fw600">{c.name}</span>
                  {c.name_en && <span className="muted fs12">/ {c.name_en}</span>}
                  {can('delete') && (
                    <button onClick={() => deleteCategory(c.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', fontSize: 14, padding: '0 0 0 4px', lineHeight: 1 }}>×</button>
                  )}
                </div>
              ))}
            </div>
            {can('add') && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                <div>
                  <label className="form-label fs12">中文名稱 *</label>
                  <input className="form-input" placeholder="例：上衣" value={newCat.name} onChange={e => setNewCat(f => ({ ...f, name: e.target.value }))} onKeyDown={e => e.key === 'Enter' && addCategory()} style={{ width: 120 }} />
                </div>
                <div>
                  <label className="form-label fs12">英文名稱</label>
                  <input className="form-input" placeholder="e.g. Tops" value={newCat.name_en} onChange={e => setNewCat(f => ({ ...f, name_en: e.target.value }))} onKeyDown={e => e.key === 'Enter' && addCategory()} style={{ width: 120 }} />
                </div>
                <button className="btn" onClick={addCategory} style={{ fontSize: 13, padding: '9px 16px', marginBottom: 0 }}>新增分類</button>
              </div>
            )}
          </div>

          {/* Tags */}
          <div>
            <div className="sec">商品標籤（每件商品可有 0～N 個標籤）</div>
            {tags.length === 0 && <div className="muted fs13" style={{ marginBottom: 12 }}>尚未建立標籤</div>}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              {tags.map(t => (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#f0f6ff', border: '0.5px solid #c5d9f7', borderRadius: 20, padding: '5px 12px' }}>
                  <span className="fs13 fw600" style={{ color: '#2563eb' }}>{t.name}</span>
                  {t.name_en && <span style={{ fontSize: 12, color: '#6b9be8' }}>/ {t.name_en}</span>}
                  {can('delete') && (
                    <button onClick={() => deleteTag(t.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b9be8', fontSize: 14, padding: '0 0 0 4px', lineHeight: 1 }}>×</button>
                  )}
                </div>
              ))}
            </div>
            {can('add') && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                <div>
                  <label className="form-label fs12">中文名稱 *</label>
                  <input className="form-input" placeholder="例：特價" value={newTag.name} onChange={e => setNewTag(f => ({ ...f, name: e.target.value }))} onKeyDown={e => e.key === 'Enter' && addTag()} style={{ width: 120 }} />
                </div>
                <div>
                  <label className="form-label fs12">英文名稱</label>
                  <input className="form-input" placeholder="e.g. Sale" value={newTag.name_en} onChange={e => setNewTag(f => ({ ...f, name_en: e.target.value }))} onKeyDown={e => e.key === 'Enter' && addTag()} style={{ width: 120 }} />
                </div>
                <button className="btn" onClick={addTag} style={{ fontSize: 13, padding: '9px 16px', marginBottom: 0 }}>新增標籤</button>
              </div>
            )}
          </div>

          {/* Variant Option Types */}
          <div>
            <div className="sec">商品規格選項（可組合，例：顏色 + 尺寸）</div>
            <div className="muted fs12" style={{ marginBottom: 12 }}>在此建立規格類型與選項值，再到商品的「設定」頁面選擇組合套用</div>

            {optionTypes.length === 0 && <div className="muted fs13" style={{ marginBottom: 12 }}>尚未建立規格類型</div>}

            {optionTypes.map(type => {
              const values = [...(type.variant_option_values || [])].sort((a, b) => a.sort_order - b.sort_order)
              return (
                <div key={type.id} style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: values.length > 0 || can('add') ? 12 : 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="fw600 fs15">{type.name}</span>
                      <span className="muted fs12">{values.length} 個選項</span>
                    </div>
                    {can('delete') && (
                      <button onClick={() => deleteOptionType(type.id)} style={{ ...smallBtn, color: 'var(--red)', fontSize: 11 }}>刪除類型</button>
                    )}
                  </div>

                  {/* Existing values as chips */}
                  {(values.length > 0 || !can('add')) && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: can('add') ? 14 : 0 }}>
                      {values.map(v => (
                        <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 16, padding: '5px 12px' }}>
                          <span className="fs13">{v.value}</span>
                          {can('delete') && (
                            <button onClick={() => deleteOptionValue(v.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', fontSize: 13, padding: '0 0 0 2px', lineHeight: 1 }}>×</button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {values.length === 0 && can('add') && (
                    <div className="muted fs12" style={{ marginBottom: 12 }}>尚無選項值，請在下方新增</div>
                  )}

                  {/* Add value input */}
                  {can('add') && (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                      <div>
                        <label className="form-label fs12">新增選項值</label>
                        <input
                          className="form-input"
                          placeholder={`例：${type.name === '顏色' ? '黑色' : type.name === '尺寸' || type.name === '鞋子尺碼' ? 'S' : '選項名稱'}`}
                          value={newOptValues[type.id] || ''}
                          onChange={e => setNewOptValues(f => ({ ...f, [type.id]: e.target.value }))}
                          onKeyDown={e => e.key === 'Enter' && addOptionValue(type.id)}
                          style={{ width: 140 }}
                        />
                      </div>
                      <button className="btn" onClick={() => addOptionValue(type.id)} style={{ fontSize: 13, padding: '9px 16px', marginBottom: 0 }}>新增</button>
                    </div>
                  )}
                </div>
              )
            })}

            {/* Create new option type */}
            {can('add') && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 8, paddingTop: 8, borderTop: '0.5px solid var(--border)' }}>
                <div>
                  <label className="form-label fs12">新增規格類型</label>
                  <input className="form-input" placeholder="例：顏色" value={newOptTypeName} onChange={e => setNewOptTypeName(e.target.value)} onKeyDown={e => e.key === 'Enter' && addOptionType()} style={{ width: 140 }} />
                </div>
                <button className="btn" onClick={addOptionType} style={{ fontSize: 13, padding: '9px 16px', marginBottom: 0 }}>建立類型</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Collection end prompt */}
      {collectionPrompt && (
        <div className="sheet-overlay" onClick={e => e.target === e.currentTarget && setCollectionPrompt(null)}>
          <div className="sheet" style={{ maxHeight: '50vh' }}>
            <div className="sheet-handle" />
            <div className="sheet-title">設定收單截止時間</div>
            <div className="muted fs13" style={{ marginBottom: 16 }}>此商品目前無庫存，將以「限時收單」模式上架。請設定收單截止時間。</div>
            <div className="form-group">
              <label className="form-label">收單截止時間</label>
              <input
                className="form-input"
                type="datetime-local"
                value={collectionPrompt.collectionEnd}
                onChange={e => setCollectionPrompt(p => ({ ...p, collectionEnd: e.target.value }))}
              />
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" onClick={confirmCollectionPublish} disabled={!collectionPrompt.collectionEnd} style={{ flex: 1 }}>
                確認上架
              </button>
              <button className="btn" onClick={() => setCollectionPrompt(null)} style={{ flex: 1, background: 'var(--surface)', color: 'var(--text-2)' }}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add/Edit listing sheet */}
      {sheet && (
        <ListingSheet
          item={sheet === 'add' ? null : sheet}
          products={products}
          onClose={() => setSheet(null)}
          onSaved={fetchAll}
        />
      )}

      {/* 社群分享面板 */}
      {shareItem && (
        <ShareSheet item={shareItem} store={store} onClose={() => setShareItem(null)} />
      )}
    </div>
  )
}

// ── 社群分享面板 ────────────────────────────────────────
function ShareSheet({ item, store, onClose }) {
  const baseUrl = resolveShopBaseUrl(store)
  const link = buildProductUrl(baseUrl, item.product_id)
  const template = store?.settings?.share_template?.trim() || DEFAULT_SHARE_TEMPLATE
  const initial = renderTemplate(template, {
    name: item.products?.name,
    price: item.shop_price,
    link,
    storeName: store?.name,
  })
  const [text, setText] = useState(initial)
  const [copied, setCopied] = useState('')   // '' | 'text' | 'link'
  const [imgBusy, setImgBusy] = useState(false)
  const [imgError, setImgError] = useState('')

  const imageUrls = [...(item.products?.product_images || [])]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map(i => i.url)
    .filter(Boolean)

  async function copy(value, which) {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(which)
      setTimeout(() => setCopied(''), 2000)
    } catch {
      alert('複製失敗，請手動選取文字複製')
    }
  }

  function openShare(platform) {
    const url = buildShareUrl(platform, text, link)
    if (url) window.open(url, '_blank', 'noopener')
  }

  // 把商品圖拼成一張，手機走原生分享（可直接帶圖進 Line）；桌機則下載＋複製文案
  async function shareImages() {
    setImgError(''); setImgBusy(true)
    try {
      const blob = await buildCollageBlob(imageUrls)
      const file = new File([blob], `product-${item.product_id}.jpg`, { type: 'image/jpeg' })
      // 文案一律先複製當備援（多數 App 帶圖時會忽略文字）
      try { await navigator.clipboard.writeText(text) } catch {}
      if (canShareFile(file)) {
        await navigator.share({ files: [file], text })
      } else {
        downloadBlob(blob, `product-${item.product_id}.jpg`)
        alert('已下載商品拼圖，文案也已複製到剪貼簿，請在 Line 貼上圖片與文字。')
      }
    } catch (e) {
      if (e?.name !== 'AbortError') setImgError('圖片分享失敗：' + (e?.message || e))
    }
    setImgBusy(false)
  }

  const missingBase = !baseUrl

  return (
    <div className="sheet-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="sheet" style={{ maxHeight: '85vh', overflowY: 'auto' }}>
        <div className="sheet-handle" />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div className="sheet-title" style={{ margin: 0 }}>分享商品</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-3)' }}>×</button>
        </div>

        <div className="muted fs13" style={{ marginBottom: 4 }}>{item.products?.name}</div>

        {missingBase && (
          <div className="error-msg" style={{ marginBottom: 12 }}>
            尚未設定商城網域，無法產生商品連結。請先在「平台管理」設定自訂網域或商店代稱。
          </div>
        )}

        <div className="form-group" style={{ marginBottom: 10 }}>
          <label className="form-label">分享文案（可臨時修改）</label>
          <textarea className="form-input" rows={6}
            style={{ resize: 'vertical', lineHeight: 1.6, fontFamily: 'inherit' }}
            value={text} onChange={e => setText(e.target.value)} />
          <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-3)', wordBreak: 'break-all' }}>
            連結：{link || '—'}
          </div>
        </div>

        <div style={{ fontSize: 13, fontWeight: 600, margin: '12px 0 8px' }}>把商品圖分享出去</div>
        <button className="btn" onClick={shareImages} disabled={imgBusy || imageUrls.length === 0}
          style={{ width: '100%' }}>
          {imageUrls.length === 0 ? '此商品沒有圖片'
            : imgBusy ? '處理圖片中…'
            : `分享商品圖（${Math.min(imageUrls.length, 8)} 張拼圖）`}
        </button>
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-3)' }}>
          手機：開啟分享選單選 Line 即可帶圖；電腦：下載拼圖後自行貼上。文案會一併複製到剪貼簿。
        </div>
        {imgError && <div className="error-msg" style={{ marginTop: 8 }}>{imgError}</div>}

        <div style={{ fontSize: 13, fontWeight: 600, margin: '16px 0 8px' }}>分享連結（文字／預覽卡）</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {PLATFORMS.filter(p => p.mode === 'share').map(p => (
            <button key={p.key} className="btn" onClick={() => openShare(p.key)} disabled={missingBase}
              style={{ flex: 1, minWidth: 120 }}>
              {p.label}
            </button>
          ))}
        </div>

        <div style={{ fontSize: 13, fontWeight: 600, margin: '16px 0 8px' }}>複製後自行貼上（FB / IG 無法自動帶入文字）</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn" onClick={() => copy(text, 'text')}
            style={{ flex: 1, minWidth: 120, background: 'var(--surface)', color: 'var(--text)' }}>
            {copied === 'text' ? '✓ 已複製文案' : '複製文案'}
          </button>
          <button className="btn" onClick={() => copy(link, 'link')} disabled={missingBase}
            style={{ flex: 1, minWidth: 120, background: 'var(--surface)', color: 'var(--text)' }}>
            {copied === 'link' ? '✓ 已複製連結' : '複製連結'}
          </button>
          <button className="btn" onClick={() => openShare('facebook')} disabled={missingBase}
            style={{ flex: 1, minWidth: 120, background: 'var(--surface)', color: 'var(--text)' }}>
            開啟 Facebook
          </button>
        </div>
      </div>
    </div>
  )
}

const smallBtn = {
  padding: '5px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600,
  background: 'var(--surface)', border: '0.5px solid var(--border)',
  cursor: 'pointer', transition: 'all .15s',
}

// Convert UTC ISO string to local datetime-local value (YYYY-MM-DDTHH:mm)
function utcToLocal(isoStr) {
  if (!isoStr) return ''
  const d = new Date(isoStr)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// Convert datetime-local value to ISO string with timezone
function localToISO(localStr) {
  if (!localStr) return null
  return new Date(localStr).toISOString()
}

function CopyBtn({ text }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(text.trim())
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }
  return (
    <button
      onClick={copy}
      style={{ background: 'none', border: 'none', cursor: 'pointer', color: copied ? 'var(--green)' : 'var(--text-3)', fontSize: 13, padding: 0, lineHeight: 1 }}
      title="複製名稱"
    >{copied ? '✓' : '📋'}</button>
  )
}

function CopyNameBar({ name }) {
  const [copied, setCopied] = useState(false)
  if (!name) return null
  function copy() {
    navigator.clipboard.writeText(name)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10, padding: '8px 12px', marginBottom: 12 }}>
      <span className="fw600 fs14" style={{ flex: 1 }}>{name}</span>
      <button
        onClick={copy}
        style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '2px 10px', fontSize: 12, color: copied ? 'var(--green)' : 'var(--text-3)', cursor: 'pointer', flexShrink: 0 }}
      >{copied ? '已複製 ✓' : '複製名稱'}</button>
    </div>
  )
}

// ── Add/Edit listing sheet ─────────────────────────────
function ListingSheet({ item, products, onClose, onSaved }) {
  const { storeId } = useAuth()
  const isEdit = !!item
  const [form, setForm] = useState({
    product_id: item?.product_id || '',
    shop_price: item?.shop_price || '',
    name_en: item?.name_en || '',
    desc_zh: item?.desc_zh || '',
    desc_en: item?.desc_en || '',
    published: item?.published ?? false,
    collection_end: utcToLocal(item?.collection_end),
    sold_out: item?.sold_out ?? false,
    skip_stock_check: item?.skip_stock_check ?? false,
  })
  const [variants, setVariants] = useState([])
  const [optionTypes, setOptionTypes] = useState([])
  const [saving, setSaving] = useState(false)
  const [createdItem, setCreatedItem] = useState(null)
  const [showVariants, setShowVariants] = useState(false)
  const [exchangeRates, setExchangeRates] = useState({})
  const [recentEnds, setRecentEnds] = useState([])
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const editingItem = item || createdItem
  const isEditing = !!editingItem

  // The product_id we're working with (from existing listing OR selected in dropdown)
  const activeProductId = editingItem?.product_id || (form.product_id ? Number(form.product_id) : null)

  useEffect(() => {
    if (!storeId) return
    // Load global option types with their values
    supabase.from('variant_option_types')
      .select('*, variant_option_values(id, value, sort_order)')
      .eq('store_id', storeId)
      .order('sort_order')
      .then(({ data }) => setOptionTypes(data || []))
    // Load exchange rates
    supabase.from('exchange_rates').select('*').eq('store_id', storeId)
      .then(({ data }) => {
        const map = {}
        ;(data || []).forEach(r => { map[r.currency] = Number(r.rate) })
        setExchangeRates(map)
      })
    // Load recent collection_end times (future only, deduplicated)
    supabase.from('storefront_products')
      .select('collection_end')
      .eq('store_id', storeId)
      .not('collection_end', 'is', null)
      .gt('collection_end', new Date().toISOString())
      .then(({ data }) => {
        const unique = [...new Set((data || []).map(d => d.collection_end))]
          .sort((a, b) => new Date(a) - new Date(b))
        setRecentEnds(unique.map(utcToLocal))
      })
  }, [storeId])

  // Load variants and base stock whenever activeProductId changes
  useEffect(() => {
    if (activeProductId) {
      supabase.from('product_variants').select('*').eq('product_id', activeProductId)
        .then(({ data }) => {
          setVariants(data || [])
          if ((data || []).length > 0) setShowVariants(true)
        })
      supabase.from('products').select('quantity').eq('id', activeProductId).single()
        .then(({ data }) => { if (data) set('base_stock', String(data.quantity || 0)) })
    } else {
      setVariants([])
      setShowVariants(false)
    }
  }, [activeProductId])

  // Resolve a variant's options object to a human-readable string
  function resolveVariantLabel(options) {
    if (!options || Object.keys(options).length === 0) return '無規格'
    return Object.entries(options).map(([typeId, valueId]) => {
      const type = optionTypes.find(t => t.id === Number(typeId))
      const val = type?.variant_option_values?.find(v => v.id === valueId)
      return val ? `${type.name}: ${val.value}` : ''
    }).filter(Boolean).join(' / ')
  }

  async function save() {
    if (!form.product_id || !form.shop_price) return
    setSaving(true)
    const payload = {
      shop_price: Number(form.shop_price),
      name_en: form.name_en,
      desc_zh: form.desc_zh,
      desc_en: form.desc_en,
      published: form.published,
      collection_end: localToISO(form.collection_end),
      sold_out: form.sold_out,
      skip_stock_check: form.skip_stock_check,
    }

    // 無規格商品：儲存基礎庫存到 products.quantity
    if (variants.length === 0 && form.base_stock !== undefined) {
      await supabase.from('products').update({ quantity: Number(form.base_stock) || 0 }).eq('id', activeProductId)
    }

    if (isEditing) {
      await supabase.from('storefront_products').update(payload).eq('id', editingItem.id)
      revalidateShop({ storeId, productIds: [activeProductId] })
      setSaving(false)
      onSaved()
      onClose()
    } else {
      const { data, error } = await supabase.from('storefront_products').insert({
        ...payload,
        product_id: Number(form.product_id),
        store_id: storeId,
      }).select('*, products(*)').single()
      setSaving(false)
      onSaved()
      if (error) { alert('建立失敗：' + error.message); return }
      revalidateShop({ storeId, productIds: [Number(form.product_id)] })
      // Switch to edit mode so user can set up variants
      setCreatedItem(data)
      // Load variants for this product
      supabase.from('product_variants').select('*').eq('product_id', data.product_id)
        .then(({ data: v }) => setVariants(v || []))
    }
  }

  // Selling mode: 'stock' (現貨) or 'collection' (收單)
  const sellingMode = form.collection_end ? 'collection' : 'stock'

  // Validation helper
  function validate() {
    if (!form.product_id && !editingItem) { alert('請選擇商品'); return false }
    if (!form.shop_price) { alert('請填寫商城售價'); return false }
    if (!form.skip_stock_check) {
      if (variants.length > 0) {
        const totalStock = variants.reduce((sum, v) => sum + (v.stock || 0), 0)
        if (totalStock <= 0) { alert('至少需要一個規格有庫存，或開啟「跳過庫存檢查」'); return false }
      } else if ((Number(form.base_stock) || 0) <= 0) {
        alert('請填寫庫存數量，或開啟「跳過庫存檢查」')
        return false
      }
    }
    return true
  }

  return (
    <div className="sheet-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <div className="sheet-handle" />
        <div className="row-sb" style={{ marginBottom: 20 }}>
          <div className="sheet-title" style={{ margin: 0 }}>
            {isEditing ? '編輯上架設定' : '新增商城商品'}
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-3)' }}>×</button>
        </div>

        {/* ── 1. 選擇商品 ── */}
        {!isEditing && (
          <div className="form-group">
            <label className="form-label">選擇商品</label>
            <CustomSelect
              label="— 選擇商品 —"
              value={form.product_id ? String(form.product_id) : null}
              options={products.map(p => ({ value: String(p.id), label: `${p.name}（${p.sku}）` }))}
              onChange={v => set('product_id', v || '')}
              allowClear={false}
            />
          </div>
        )}
        {/* 商品名稱 + 複製 */}
        <CopyNameBar name={isEditing ? editingItem?.products?.name : products.find(p => p.id === Number(form.product_id))?.name} />

        {/* ── 2. 售價 ── */}
        <div className="form-group">
          <label className="form-label">
            商城售價（NT$）
            {(() => {
              const prod = editingItem?.products || products.find(p => p.id === Number(form.product_id))
              if (prod?.cost == null) return null
              const cur = prod.currency || 'TWD'
              const cost = Number(prod.cost)
              const isTWD = cur === 'TWD'
              const rate = exchangeRates[cur]
              const twdCost = !isTWD && rate ? Math.round(cost * rate * 10) / 10 : null
              return (
                <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
                  成本 {cost.toLocaleString()} {cur}
                  {twdCost != null && ` ≈ ${twdCost.toLocaleString()} TWD`}
                </span>
              )
            })()}
          </label>
          <input className="form-input" type="number" placeholder="0" value={form.shop_price} onChange={e => set('shop_price', e.target.value)} />
        </div>

        {/* ── 3. 商品規格（可選）── */}
        {activeProductId && (
          <>
            <div
              onClick={() => setShowVariants(v => !v)}
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '12px 16px', borderRadius: 10, cursor: 'pointer',
                background: 'var(--surface)', border: '0.5px solid var(--border)',
                marginBottom: showVariants ? 12 : 0,
              }}
            >
              <div>
                <span className="fw600 fs14">商品規格</span>
                <span className="muted fs12" style={{ marginLeft: 8 }}>
                  {variants.length > 0 ? `${variants.length} 種組合` : '無規格（單一品項）'}
                </span>
              </div>
              <span style={{ fontSize: 13, color: 'var(--text-3)' }}>{showVariants ? '收起 ▲' : '展開 ▼'}</span>
            </div>
            {showVariants && (
              <VariantManager
                variants={variants}
                setVariants={setVariants}
                optionTypes={optionTypes}
                productId={activeProductId}
                productName={isEditing ? editingItem?.products?.name : products.find(p => p.id === Number(form.product_id))?.name}
                shopPrice={Number(form.shop_price) || 0}
                resolveVariantLabel={resolveVariantLabel}
              />
            )}

            {/* 無規格 + 需要庫存 → 顯示庫存欄位 */}
            {variants.length === 0 && !showVariants && (sellingMode === 'stock' || !form.skip_stock_check) && (
              <div className="form-group" style={{ marginTop: 12 }}>
                <label className="form-label">庫存數量</label>
                <input
                  className="form-input"
                  type="number"
                  placeholder="0"
                  value={form.base_stock ?? ''}
                  onChange={e => set('base_stock', e.target.value)}
                  style={{ width: 140 }}
                />
              </div>
            )}
          </>
        )}

        {/* ── 4. 銷售模式 ── */}
        <div className="sec" style={{ marginTop: 16 }}>銷售模式</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button
            onClick={() => { set('collection_end', ''); set('skip_stock_check', false) }}
            style={{
              flex: 1, padding: '12px 8px', borderRadius: 10, fontSize: 13, fontWeight: 600,
              cursor: 'pointer', transition: 'all .15s', textAlign: 'center',
              background: sellingMode === 'stock' ? 'var(--text)' : 'var(--surface)',
              color: sellingMode === 'stock' ? '#fff' : 'var(--text-3)',
              border: `0.5px solid ${sellingMode === 'stock' ? 'var(--text)' : 'var(--border)'}`,
            }}
          >
            📦 現貨模式
            <div style={{ fontSize: 11, fontWeight: 400, marginTop: 2, opacity: 0.8 }}>依庫存銷售</div>
          </button>
          <button
            onClick={() => {
              if (sellingMode !== 'collection') {
                const d = new Date(); d.setDate(d.getDate() + 7)
                const pad = n => String(n).padStart(2, '0')
                const val = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
                set('collection_end', val)
                set('skip_stock_check', true)
              }
            }}
            style={{
              flex: 1, padding: '12px 8px', borderRadius: 10, fontSize: 13, fontWeight: 600,
              cursor: 'pointer', transition: 'all .15s', textAlign: 'center',
              background: sellingMode === 'collection' ? 'var(--text)' : 'var(--surface)',
              color: sellingMode === 'collection' ? '#fff' : 'var(--text-3)',
              border: `0.5px solid ${sellingMode === 'collection' ? 'var(--text)' : 'var(--border)'}`,
            }}
          >
            🛒 收單模式
            <div style={{ fontSize: 11, fontWeight: 400, marginTop: 2, opacity: 0.8 }}>限時收單，截止後叫貨</div>
          </button>
        </div>

        {sellingMode === 'collection' && (
          <>
            <div className="form-group">
              <label className="form-label">收單截止時間</label>
              {recentEnds.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                  {recentEnds.map(t => {
                    const d = new Date(t.replace('T', ' '))
                    const label = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
                    const isActive = form.collection_end === t
                    return (
                      <button key={t} onClick={() => set('collection_end', t)} style={{
                        fontSize: 12, padding: '4px 10px', borderRadius: 16, cursor: 'pointer',
                        border: '0.5px solid var(--border)', transition: 'all .15s',
                        background: isActive ? 'var(--text)' : 'var(--surface)',
                        color: isActive ? '#fff' : 'var(--text-2)',
                      }}>{label}</button>
                    )
                  })}
                </div>
              )}
              <input className="form-input" type="datetime-local" value={form.collection_end} onChange={e => set('collection_end', e.target.value)} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <label className="form-label fs13" style={{ margin: 0 }}>跳過庫存檢查</label>
              <div
                onClick={() => set('skip_stock_check', !form.skip_stock_check)}
                style={{
                  width: 44, height: 26, borderRadius: 13, cursor: 'pointer', transition: 'background .2s',
                  background: form.skip_stock_check ? 'var(--blue, #3b82f6)' : 'var(--border)',
                  position: 'relative',
                }}
              >
                <div style={{
                  width: 20, height: 20, borderRadius: '50%', background: '#fff',
                  position: 'absolute', top: 3, transition: 'left .2s',
                  left: form.skip_stock_check ? 21 : 3,
                }} />
              </div>
              <span className="muted fs12">{form.skip_stock_check ? '不檢查庫存，可無限下單' : '需有庫存才能下單'}</span>
            </div>
          </>
        )}

        {/* ── 5. 商品描述 ── */}
        <div className="sec" style={{ marginTop: 8 }}>商品描述</div>
        <div className="form-group">
          <label className="form-label">中文描述</label>
          <input className="form-input" placeholder="商品說明（顯示在商城）" value={form.desc_zh} onChange={e => set('desc_zh', e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">英文商品名稱</label>
          <input className="form-input" placeholder="Product name in English" value={form.name_en} onChange={e => set('name_en', e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">英文描述</label>
          <input className="form-input" placeholder="Product description in English" value={form.desc_en} onChange={e => set('desc_en', e.target.value)} />
        </div>

        {/* ── 6. 上架控制 ── */}
        <div style={{ display: 'flex', gap: 16, marginBottom: 20, marginTop: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label className="form-label fs13" style={{ margin: 0 }}>標記缺貨</label>
            <div
              onClick={() => set('sold_out', !form.sold_out)}
              style={{
                width: 44, height: 26, borderRadius: 13, cursor: 'pointer', transition: 'background .2s',
                background: form.sold_out ? 'var(--red)' : 'var(--border)',
                position: 'relative',
              }}
            >
              <div style={{
                width: 20, height: 20, borderRadius: '50%', background: '#fff',
                position: 'absolute', top: 3, transition: 'left .2s',
                left: form.sold_out ? 21 : 3,
              }} />
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label className="form-label fs13" style={{ margin: 0 }}>立即上架</label>
            <div
              onClick={() => set('published', !form.published)}
              style={{
                width: 44, height: 26, borderRadius: 13, cursor: 'pointer', transition: 'background .2s',
                background: form.published ? 'var(--green)' : 'var(--border)',
                position: 'relative',
              }}
            >
              <div style={{
                width: 20, height: 20, borderRadius: '50%', background: '#fff',
                position: 'absolute', top: 3, transition: 'left .2s',
                left: form.published ? 21 : 3,
              }} />
            </div>
          </div>
        </div>

        {/* ── 儲存 ── */}
        <button className="btn" onClick={() => { if (validate()) save() }} disabled={saving} style={{ marginBottom: 20 }}>
          {saving ? '儲存中…' : isEditing ? '儲存變更' : '新增上架'}
        </button>
      </div>
    </div>
  )
}

function VariantManager({ variants, setVariants, optionTypes, productId, productName, shopPrice, resolveVariantLabel }) {
  // Step 1 state: which types and values are selected for this product
  const [selectedTypes, setSelectedTypes] = useState({})   // { typeId: true/false }
  const [selectedValues, setSelectedValues] = useState({})  // { typeId: Set of valueIds }
  const [generating, setGenerating] = useState(false)
  const [batchStock, setBatchStock] = useState('')
  const [batchPrice, setBatchPrice] = useState('')

  // Initialize selections from existing variants
  useEffect(() => {
    if (variants.length === 0) return
    const types = {}
    const values = {}
    variants.forEach(v => {
      Object.entries(v.options || {}).forEach(([tid, vid]) => {
        types[tid] = true
        if (!values[tid]) values[tid] = new Set()
        values[tid].add(vid)
      })
    })
    setSelectedTypes(types)
    // Convert Sets for state (we'll keep using Sets internally)
    setSelectedValues(values)
  }, []) // only on mount

  function toggleType(typeId) {
    const tid = String(typeId)
    setSelectedTypes(prev => {
      const next = { ...prev }
      if (next[tid]) {
        delete next[tid]
        setSelectedValues(prev2 => {
          const n = { ...prev2 }
          delete n[tid]
          return n
        })
      } else {
        next[tid] = true
      }
      return next
    })
  }

  function toggleValue(typeId, valueId) {
    const tid = String(typeId)
    setSelectedValues(prev => {
      const next = { ...prev }
      if (!next[tid]) next[tid] = new Set()
      else next[tid] = new Set(next[tid]) // clone
      if (next[tid].has(valueId)) next[tid].delete(valueId)
      else next[tid].add(valueId)
      return next
    })
  }

  // Generate cartesian product of selected values
  function cartesian(arrays) {
    if (arrays.length === 0) return [[]]
    return arrays.reduce((acc, arr) =>
      acc.flatMap(combo => arr.map(item => [...combo, item])),
    [[]])
  }

  async function generateCombinations() {
    const activeTypeIds = Object.keys(selectedTypes).filter(tid => selectedTypes[tid] && selectedValues[tid]?.size > 0)
    if (activeTypeIds.length === 0) return

    setGenerating(true)

    // Build arrays for cartesian product: [[{tid, vid}, ...], ...]
    const axes = activeTypeIds.map(tid =>
      [...selectedValues[tid]].map(vid => ({ tid, vid }))
    )
    const combos = cartesian(axes)

    // Check which combos already exist
    const existingKeys = new Set(variants.map(v => {
      return Object.entries(v.options || {}).sort(([a], [b]) => a.localeCompare(b)).map(([t, v2]) => `${t}:${v2}`).join('|')
    }))

    const toInsert = []
    for (const combo of combos) {
      const options = {}
      combo.forEach(({ tid, vid }) => { options[tid] = vid })
      const key = Object.entries(options).sort(([a], [b]) => a.localeCompare(b)).map(([t, v2]) => `${t}:${v2}`).join('|')
      if (!existingKeys.has(key)) {
        toInsert.push({ product_id: productId, options, stock: 0, variant_price: null })
      }
    }

    if (toInsert.length > 0) {
      await supabase.from('product_variants').insert(toInsert)
    }

    // Reload all variants
    const { data } = await supabase.from('product_variants').select('*').eq('product_id', productId)
    setVariants(data || [])
    setGenerating(false)
  }

  async function updateVariantField(id, field, value) {
    const numVal = value === '' || value === null ? null : Number(value)
    await supabase.from('product_variants').update({ [field]: field === 'stock' ? (numVal ?? 0) : numVal }).eq('id', id)
    setVariants(prev => prev.map(v => v.id === id ? { ...v, [field]: field === 'stock' ? (numVal ?? 0) : numVal } : v))
  }

  async function deleteVariant(id) {
    await supabase.from('product_variants').delete().eq('id', id)
    setVariants(prev => prev.filter(v => v.id !== id))
  }

  async function applyBatchStock() {
    if (batchStock === '') return
    const val = Number(batchStock)
    const ids = variants.map(v => v.id)
    await supabase.from('product_variants').update({ stock: val }).in('id', ids)
    setVariants(prev => prev.map(v => ({ ...v, stock: val })))
    setBatchStock('')
  }

  async function applyBatchPrice() {
    if (batchPrice === '') return
    const val = Number(batchPrice)
    const ids = variants.map(v => v.id)
    await supabase.from('product_variants').update({ variant_price: val }).in('id', ids)
    setVariants(prev => prev.map(v => ({ ...v, variant_price: val })))
    setBatchPrice('')
  }

  async function deleteAllVariants() {
    if (!window.confirm('確定刪除此商品的所有規格組合？')) return
    await supabase.from('product_variants').delete().eq('product_id', productId)
    setVariants([])
    setSelectedTypes({})
    setSelectedValues({})
  }

  // Count how many new combos would be generated
  const activeTypeIds = Object.keys(selectedTypes).filter(tid => selectedTypes[tid] && selectedValues[tid]?.size > 0)
  const totalCombos = activeTypeIds.length > 0
    ? activeTypeIds.reduce((acc, tid) => acc * (selectedValues[tid]?.size || 1), 1)
    : 0
  const existingCount = variants.length
  const newCount = Math.max(0, totalCombos - existingCount)

  return (
    <>
      <div className="sec" style={{ marginTop: 8 }}>商品規格</div>

      {optionTypes.length === 0 ? (
        <div className="muted fs13" style={{ marginBottom: 12 }}>
          請先到「分類/標籤/規格」tab 建立規格類型（例：顏色、尺寸）
        </div>
      ) : (
        <>
          {/* Step 1: Select types & values */}
          <div style={{ background: 'var(--bg)', borderRadius: 12, padding: 14, marginBottom: 12 }}>
            <div className="muted fs12 fw600" style={{ marginBottom: 10 }}>1. 選擇此商品的規格</div>
            {optionTypes.map(type => {
              const tid = String(type.id)
              const isActive = !!selectedTypes[tid]
              const vals = [...(type.variant_option_values || [])].sort((a, b) => a.sort_order - b.sort_order)

              return (
                <div key={type.id} style={{ marginBottom: 12 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: isActive ? 8 : 0 }}>
                    <input
                      type="checkbox"
                      checked={isActive}
                      onChange={() => toggleType(type.id)}
                      style={{ width: 16, height: 16, accentColor: 'var(--text)' }}
                    />
                    <span className="fw600 fs14">{type.name}</span>
                    {isActive && selectedValues[tid]?.size > 0 && (
                      <span className="muted fs12">（已選 {selectedValues[tid].size} 個）</span>
                    )}
                  </label>
                  {isActive && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', paddingLeft: 24 }}>
                      {vals.map(val => {
                        const isSelected = selectedValues[tid]?.has(val.id)
                        return (
                          <button
                            key={val.id}
                            onClick={() => toggleValue(type.id, val.id)}
                            style={{
                              fontSize: 13, padding: '4px 14px', borderRadius: 20,
                              background: isSelected ? 'var(--text)' : 'transparent',
                              color: isSelected ? '#fff' : 'var(--text-2)',
                              border: '0.5px solid var(--border)',
                              cursor: 'pointer', transition: 'all .15s',
                            }}
                          >{val.value}</button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}

            {totalCombos > 0 && (
              <button
                className="btn"
                onClick={generateCombinations}
                disabled={generating}
                style={{ fontSize: 13, padding: '10px 0', marginTop: 4 }}
              >
                {generating ? '產生中…' : `產生組合（共 ${totalCombos} 種${newCount > 0 && newCount < totalCombos ? `，新增 ${newCount}` : ''}）`}
              </button>
            )}
          </div>

          {/* Step 2: Variant matrix table */}
          {variants.length > 0 && (
            <div style={{ background: 'var(--bg)', borderRadius: 12, padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div className="muted fs12 fw600">2. 編輯規格（{variants.length} 種）</div>
                <button onClick={deleteAllVariants} style={{ ...smallBtn, color: 'var(--red)', fontSize: 11 }}>清除全部</button>
              </div>

              {/* Batch controls */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <span className="muted fs12">批次庫存:</span>
                  <input
                    type="number"
                    value={batchStock}
                    onChange={e => setBatchStock(e.target.value)}
                    placeholder="0"
                    style={{ width: 60, padding: '4px 8px', borderRadius: 6, border: '0.5px solid var(--border)', fontSize: 13, textAlign: 'center' }}
                  />
                  <button onClick={applyBatchStock} style={{ ...smallBtn, fontSize: 11 }}>套用</button>
                </div>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <span className="muted fs12">批次售價:</span>
                  <input
                    type="number"
                    value={batchPrice}
                    onChange={e => setBatchPrice(e.target.value)}
                    placeholder={String(shopPrice)}
                    style={{ width: 80, padding: '4px 8px', borderRadius: 6, border: '0.5px solid var(--border)', fontSize: 13, textAlign: 'center' }}
                  />
                  <button onClick={applyBatchPrice} style={{ ...smallBtn, fontSize: 11 }}>套用</button>
                </div>
              </div>

              {/* Table */}
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)' }}>
                      <th style={thStyle}>規格</th>
                      <th style={{ ...thStyle, width: 70, textAlign: 'center' }}>庫存</th>
                      <th style={{ ...thStyle, width: 90, textAlign: 'center' }}>售價(NT$)</th>
                      <th style={{ ...thStyle, width: 40 }}></th>
                      <th style={{ ...thStyle, width: 40 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {variants.map(v => (
                      <tr key={`${v.id}-${v.stock}-${v.variant_price}`} style={{ borderBottom: '1px solid var(--border-light, #f0f0f0)' }}>
                        <td style={tdStyle}>
                          <span className="fw600">{resolveVariantLabel(v.options)}</span>
                        </td>
                        <td style={{ ...tdStyle, textAlign: 'center' }}>
                          <input
                            type="number"
                            defaultValue={v.stock}
                            onBlur={e => updateVariantField(v.id, 'stock', e.target.value)}
                            style={cellInput}
                          />
                        </td>
                        <td style={{ ...tdStyle, textAlign: 'center' }}>
                          <input
                            type="number"
                            defaultValue={v.variant_price ?? ''}
                            placeholder={String(shopPrice)}
                            onBlur={e => updateVariantField(v.id, 'variant_price', e.target.value)}
                            style={cellInput}
                          />
                        </td>
                        <td style={{ ...tdStyle, textAlign: 'center' }}>
                          <button
                            onClick={() => deleteVariant(v.id)}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', fontSize: 15, padding: 0, lineHeight: 1 }}
                            title="刪除"
                          >×</button>
                        </td>
                        <td style={{ ...tdStyle, textAlign: 'center' }}>
                          <CopyBtn text={`${productName || ''} ${resolveVariantLabel(v.options)}`} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="muted fs12" style={{ marginTop: 8 }}>
                售價留空 = 使用商城售價 NT${shopPrice.toLocaleString()}
              </div>
            </div>
          )}

          {variants.length === 0 && (
            <div className="muted fs13" style={{ marginBottom: 12 }}>
              勾選規格並產生組合，或消費者將看到無規格商品
            </div>
          )}
        </>
      )}
    </>
  )
}

const thStyle = { padding: '8px 6px', textAlign: 'left', fontSize: 12, color: 'var(--text-3)', fontWeight: 600 }
const tdStyle = { padding: '8px 6px' }
const cellInput = { width: '100%', padding: '5px 8px', borderRadius: 6, border: '0.5px solid var(--border)', fontSize: 13, textAlign: 'center', background: 'var(--surface)' }
