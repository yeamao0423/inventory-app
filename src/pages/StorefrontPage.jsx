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
import { toTwdCost, calcMargin } from '../lib/pricing'
import { cmpNum, cmpStr, cmpDate } from '../lib/sortUtils'
import { Pill } from '../components/MenuPopover'
import ListToolbar from '../components/ListToolbar'

// 商城排序選項（預設＝第一項：上架 新→舊）
const STORE_SORT = [
  { group: '時間', items: [{ value: 'listed_desc', label: '上架 新→舊' }, { value: 'listed_asc', label: '上架 舊→新' }]},
  { group: '庫存', items: [{ value: 'stock_asc', label: '庫存 少→多' }, { value: 'stock_desc', label: '庫存 多→少' }]},
  { group: '獲利', items: [
    { value: 'margin_desc', label: '毛利率 高→低' }, { value: 'margin_asc', label: '毛利率 低→高' },
    { value: 'price_desc', label: '售價 高→低' }, { value: 'price_asc', label: '售價 低→高' },
  ]},
  { group: '名稱', items: [{ value: 'name_asc', label: '名稱 A→Z' }]},
  { group: '其他', items: [{ value: 'manual', label: '手動排序' }]},
]

// listing 毛利率（沒成本/缺匯率 → null，由比較器沉底）
function listingMarginRate(item, rates) {
  if (item.shop_price == null) return null
  const m = calcMargin(item.shop_price, toTwdCost(item.products?.cost, item.products?.currency, rates))
  return m ? m.rate : null
}

function storeSortComparator(sort, rates) {
  switch (sort) {
    case 'listed_asc': return cmpDate(i => i.created_at, 'asc')
    case 'stock_asc': return cmpNum(i => i.products?.quantity, 'asc')
    case 'stock_desc': return cmpNum(i => i.products?.quantity, 'desc')
    case 'margin_desc': return cmpNum(i => listingMarginRate(i, rates), 'desc')
    case 'margin_asc': return cmpNum(i => listingMarginRate(i, rates), 'asc')
    case 'price_desc': return cmpNum(i => i.shop_price, 'desc')
    case 'price_asc': return cmpNum(i => i.shop_price, 'asc')
    case 'name_asc': return cmpStr(i => i.products?.name, 'asc')
    case 'manual': return cmpNum(i => i.sort_order, 'asc')
    case 'listed_desc':
    default: return cmpDate(i => i.created_at, 'desc')
  }
}

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
  const [filterNoCost, setFilterNoCost] = useState(false)
  const [sort, setSort] = useState('listed_desc')
  const [page, setPage] = useState(1)
  const PAGE_SIZE = 15

  useEffect(() => {
    if (!storeId) return
    supabase.from('exchange_rates').select('*')
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
        const hasActiveFilter = filter !== 'all' || filterCat || filterTag || filterSource || filterNoCost
        const activeLabel = statusFilters.find(f => f.key === filter)?.label || '全部'
        return (
          <>
            <ListToolbar
              search={search}
              onSearch={v => { setSearch(v); setPage(1) }}
              placeholder="搜尋商品名稱或 SKU…"
              sort={{ options: STORE_SORT, value: sort, onChange: v => { setSort(v); setPage(1) } }}
              filter={{
                active: hasActiveFilter,
                label: hasActiveFilter ? activeLabel : '篩選',
                width: 270,
                onClear: () => { setFilter('all'); setFilterCat(''); setFilterTag(''); setFilterSource(''); setFilterNoCost(false); setPage(1) },
                children: (
                  <>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-3)', marginBottom: 8 }}>狀態</div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {statusFilters.map(f => {
                          const count = f.key === 'all'
                            ? listings.length
                            : f.key === 'published' ? listings.filter(l => l.published && !l.sold_out).length
                            : f.key === 'unpublished' ? listings.filter(l => !l.published).length
                            : f.key === 'sold_out' ? listings.filter(l => l.sold_out).length
                            : listings.filter(l => l.collection_end && new Date(l.collection_end) < new Date() && !l.sold_out).length
                          return (
                            <Pill key={f.key} active={filter === f.key} onClick={() => { setFilter(f.key); setPage(1) }}>
                              {f.label}（{count}）
                            </Pill>
                          )
                        })}
                      </div>
                    </div>
                    {catsInUse.length > 0 && (
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-3)', marginBottom: 8 }}>分類</div>
                        <CustomSelect compact label="全部分類" value={filterCat || null}
                          options={catsInUse.map(c => ({ value: String(c.id), label: c.name }))}
                          onChange={v => { setFilterCat(v || ''); setPage(1) }} />
                      </div>
                    )}
                    {tagsInUse.length > 0 && (
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-3)', marginBottom: 8 }}>標籤</div>
                        <CustomSelect compact label="全部標籤" value={filterTag || null}
                          options={tagsInUse.map(t => ({ value: String(t.id), label: t.name }))}
                          onChange={v => { setFilterTag(v || ''); setPage(1) }} />
                      </div>
                    )}
                    {sources.length > 0 && (
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-3)', marginBottom: 8 }}>來源</div>
                        <CustomSelect compact label="全部來源" value={filterSource || null}
                          options={sources.map(s => ({ value: s, label: s }))}
                          onChange={v => { setFilterSource(v || ''); setPage(1) }} />
                      </div>
                    )}
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-3)', marginBottom: 8 }}>資料</div>
                      <Pill active={filterNoCost} onClick={() => { setFilterNoCost(v => !v); setPage(1) }}>只看未設成本</Pill>
                    </div>
                  </>
                ),
              }}
            />
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
          // 只看未設成本
          if (filterNoCost && item.products?.cost != null) return false
          return true
        }).sort(storeSortComparator(sort, exchangeRates))
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

            const now = new Date()
            const saleNow = item.on_sale && item.sale_price != null
              && Number(item.sale_price) < Number(item.shop_price)
              && (!item.sale_start || new Date(item.sale_start) <= now)
              && (!item.sale_end || new Date(item.sale_end) >= now)
            const saleScheduled = item.on_sale && item.sale_price != null && !saleNow

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
                      {saleNow && <span className="badge" style={{ fontSize: 11, background: 'var(--red)', color: '#fff' }}>特價中</span>}
                      {saleScheduled && <span className="badge badge-warn" style={{ fontSize: 11 }}>特價已排程</span>}
                    </div>
                    <div className="muted fs12">
                      {item.products?.sku && <span>{item.products.sku} · </span>}
                      {saleNow
                        ? <>售價 <span style={{ textDecoration: 'line-through' }}>NT${Number(item.shop_price).toLocaleString()}</span> <span style={{ color: 'var(--red)', fontWeight: 600 }}>特價 NT${Number(item.sale_price).toLocaleString()}</span></>
                        : <>售價 NT${Number(item.shop_price).toLocaleString()}</>}
                      {item.products?.cost != null && (() => {
                        const cur = item.products.currency || 'TWD'
                        const cost = Number(item.products.cost)
                        const isTWD = cur === 'TWD'
                        const rate = exchangeRates[cur]
                        const twdCost = !isTWD && rate ? Math.round(cost * rate * 10) / 10 : null
                        const margin = calcMargin(item.shop_price, toTwdCost(cost, cur, exchangeRates))
                        return (
                          <span style={{ color: 'var(--text-3)' }}>
                            {' · 成本 '}{cost.toLocaleString()} {cur}
                            {twdCost != null && ` ≈ ${twdCost.toLocaleString()} TWD`}
                            {margin && ` · 毛利率 ${margin.rate}%`}
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

  const images = [...(item.products?.product_images || [])]
    .sort((a, b) => a.sort_order - b.sort_order)
    .filter(i => i.url)

  // 預設全選；includeText 預設帶文案＋連結
  const [selected, setSelected] = useState(() => images.map(() => true))
  const [includeText, setIncludeText] = useState(true)
  const selectedUrls = images.filter((_, i) => selected[i]).map(i => i.url)
  const selCount = selectedUrls.length

  function toggleImg(idx) {
    setSelected(prev => prev.map((v, i) => (i === idx ? !v : v)))
  }
  function setAll(v) { setSelected(images.map(() => v)) }

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

  // 依勾選分享：圖片（拼圖）／文案＋連結，可單獨或一起。
  // 手機走原生分享（可直接帶圖進 Line）；桌機則下載圖片＋複製文案。
  async function shareSelected() {
    if (selCount === 0 && !includeText) {
      setImgError('請至少選擇圖片或勾選帶入文案')
      return
    }
    setImgError(''); setImgBusy(true)
    try {
      let blob = null, file = null
      if (selCount > 0) {
        blob = await buildCollageBlob(selectedUrls, { max: 12 })
        file = new File([blob], `product-${item.product_id}.jpg`, { type: 'image/jpeg' })
      }
      // 帶文案時一律先複製當備援（多數 App 帶圖時會忽略文字）
      if (includeText) { try { await navigator.clipboard.writeText(text) } catch {} }

      const payload = {}
      if (file) payload.files = [file]
      if (includeText) payload.text = text

      const canShare = file
        ? canShareFile(file)
        : (typeof navigator !== 'undefined' && typeof navigator.share === 'function')

      if (canShare) {
        await navigator.share(payload)
      } else if (file) {
        downloadBlob(blob, `product-${item.product_id}.jpg`)
        alert(includeText
          ? '已下載商品拼圖、文案已複製到剪貼簿，請在 Line 貼上圖片與文字。'
          : '已下載商品拼圖，請在 Line 貼上。')
      } else {
        await copy(text, 'text')
        alert('文案＋連結已複製到剪貼簿，請貼到社群。')
      }
    } catch (e) {
      if (e?.name !== 'AbortError') setImgError('分享失敗：' + (e?.message || e))
    }
    setImgBusy(false)
  }

  const missingBase = !baseUrl
  const shareLabel = imgBusy ? '處理中…'
    : selCount > 0
      ? `分享${selCount}張圖${includeText ? '＋文案' : ''}`
      : '分享文案＋連結'

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

        {/* 選擇要分享的圖片 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '12px 0 8px' }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>選擇圖片{images.length > 0 && `（已選 ${selCount}/${images.length}）`}</span>
          {images.length > 0 && (
            <span style={{ fontSize: 12 }}>
              <button type="button" onClick={() => setAll(true)} style={{ background: 'none', border: 'none', color: 'var(--blue)', cursor: 'pointer', padding: 0 }}>全選</button>
              <span style={{ color: 'var(--text-3)', margin: '0 6px' }}>·</span>
              <button type="button" onClick={() => setAll(false)} style={{ background: 'none', border: 'none', color: 'var(--blue)', cursor: 'pointer', padding: 0 }}>全不選</button>
            </span>
          )}
        </div>
        {images.length === 0 ? (
          <div className="muted fs13">此商品沒有圖片</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
            {images.map((im, idx) => {
              const on = selected[idx]
              const order = selected.slice(0, idx + 1).filter(Boolean).length
              return (
                <button key={im.id ?? idx} type="button" onClick={() => toggleImg(idx)}
                  style={{ position: 'relative', padding: 0, border: 'none', background: 'none', cursor: 'pointer', aspectRatio: '1', borderRadius: 8, overflow: 'hidden' }}>
                  <img src={im.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', opacity: on ? 1 : 0.4 }} />
                  <span style={{
                    position: 'absolute', top: 4, right: 4, width: 20, height: 20, borderRadius: '50%',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700,
                    background: on ? 'var(--blue, #2f6bff)' : 'rgba(0,0,0,0.35)', color: '#fff',
                  }}>{on ? order : ''}</span>
                </button>
              )
            })}
          </div>
        )}

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0 8px', fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={includeText} onChange={e => setIncludeText(e.target.checked)} disabled={missingBase} />
          一併帶入文案＋連結{missingBase && '（未設定網域，暫不可用）'}
        </label>

        <button className="btn" onClick={shareSelected} disabled={imgBusy || (selCount === 0 && !includeText)}
          style={{ width: '100%' }}>
          {shareLabel}
        </button>
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-3)' }}>
          手機：開啟分享選單選 Line 即可帶圖；電腦：下載拼圖後自行貼上。帶文案時會一併複製到剪貼簿（Line 收圖時常忽略文字，貼上即可補）。
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
    on_sale: item?.on_sale ?? false,
    sale_price: item?.sale_price ?? '',
    sale_start: utcToLocal(item?.sale_start),
    sale_end: utcToLocal(item?.sale_end),
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
    supabase.from('exchange_rates').select('*')
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
      on_sale: form.on_sale,
      sale_price: form.on_sale && form.sale_price !== '' ? Number(form.sale_price) : null,
      sale_start: form.on_sale ? localToISO(form.sale_start) : null,
      sale_end: form.on_sale ? localToISO(form.sale_end) : null,
    }

    // 無規格商品：僅「新增上架」時寫入基礎庫存；編輯既有上架時庫存由庫存頁管理，不覆寫
    if (!isEditing && variants.length === 0 && form.base_stock !== undefined) {
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
              const margin = calcMargin(form.shop_price, toTwdCost(cost, cur, exchangeRates))
              return (
                <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
                  成本 {cost.toLocaleString()} {cur}
                  {twdCost != null && ` ≈ ${twdCost.toLocaleString()} TWD`}
                  {margin && (
                    <span style={{ color: margin.amount >= 0 ? 'var(--green)' : 'var(--red)', marginLeft: 6 }}>
                      · 毛利率 {margin.rate}%（NT${margin.amount.toLocaleString()}）
                    </span>
                  )}
                </span>
              )
            })()}
          </label>
          <input className="form-input" type="number" placeholder="0" value={form.shop_price} onChange={e => set('shop_price', e.target.value)} />
        </div>

        {/* ── 2.5 特價設定（可選）── */}
        <div className="form-group" style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 12, padding: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="form-label fs13 fw600" style={{ margin: 0, flex: 1 }}>🏷️ 特價</span>
            <div
              onClick={() => set('on_sale', !form.on_sale)}
              style={{
                width: 44, height: 26, borderRadius: 13, cursor: 'pointer', transition: 'background .2s',
                background: form.on_sale ? 'var(--red)' : 'var(--border)', position: 'relative',
              }}
            >
              <div style={{ width: 20, height: 20, borderRadius: '50%', background: '#fff', position: 'absolute', top: 3, transition: 'left .2s', left: form.on_sale ? 21 : 3 }} />
            </div>
          </div>

          {form.on_sale && (
            <div style={{ marginTop: 14 }}>
              <label className="form-label">
                特價金額（NT$）
                {(() => {
                  const reg = Number(form.shop_price) || 0
                  const sale = Number(form.sale_price)
                  if (!form.sale_price || !reg) return null
                  const pct = reg > 0 ? Math.round((sale / reg) * 100) / 10 : null // 幾折
                  const prod = editingItem?.products || products.find(p => p.id === Number(form.product_id))
                  const margin = prod?.cost != null
                    ? calcMargin(sale, toTwdCost(Number(prod.cost), prod.currency || 'TWD', exchangeRates))
                    : null
                  return (
                    <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
                      {sale >= reg
                        ? <span style={{ color: 'var(--red)' }}>需低於原價 {reg.toLocaleString()}</span>
                        : <>約 {pct} 折
                            {margin && (
                              <span style={{ color: margin.amount >= 0 ? 'var(--green)' : 'var(--red)', marginLeft: 6 }}>
                                · 特價毛利率 {margin.rate}%（NT${margin.amount.toLocaleString()}）
                              </span>
                            )}
                          </>}
                    </span>
                  )
                })()}
              </label>
              <input className="form-input" type="number" placeholder="0" value={form.sale_price} onChange={e => set('sale_price', e.target.value)} />

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
                <div>
                  <label className="form-label fs13">開始時間</label>
                  <input className="form-input" type="datetime-local" value={form.sale_start} onChange={e => set('sale_start', e.target.value)} />
                </div>
                <div>
                  <label className="form-label fs13">結束時間</label>
                  <input className="form-input" type="datetime-local" value={form.sale_end} onChange={e => set('sale_end', e.target.value)} />
                </div>
              </div>
              <div className="muted fs12" style={{ marginTop: 8, lineHeight: 1.6 }}>
                兩個時間皆留空＝常駐特價；只填開始＝該日起特價；只填結束＝到該日止；都填＝期間內特價。
                <br/>未在下方規格表單獨設定特價的規格，都套用此「全品特價」金額。
              </div>
            </div>
          )}
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
                readOnlyStock={isEditing}
                onSale={form.on_sale}
                salePrice={form.sale_price}
              />
            )}

            {/* 無規格 + 需要庫存 → 顯示庫存欄位（編輯既有上架時唯讀，請至庫存頁調整）*/}
            {variants.length === 0 && !showVariants && (sellingMode === 'stock' || !form.skip_stock_check) && (
              <div className="form-group" style={{ marginTop: 12 }}>
                <label className="form-label">庫存數量</label>
                {isEditing ? (
                  <>
                    <input className="form-input" type="number" value={form.base_stock ?? ''} disabled style={{ width: 140, opacity: 0.6 }} />
                    <div className="muted fs12" style={{ marginTop: 4 }}>庫存請至「庫存」頁調整</div>
                  </>
                ) : (
                  <input
                    className="form-input"
                    type="number"
                    placeholder="0"
                    value={form.base_stock ?? ''}
                    onChange={e => set('base_stock', e.target.value)}
                    style={{ width: 140 }}
                  />
                )}
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

function VariantManager({ variants, setVariants, optionTypes, productId, productName, shopPrice, resolveVariantLabel, readOnlyStock = false, onSale = false, salePrice = '' }) {
  // Step 1 state: which types and values are selected for this product
  const [selectedTypes, setSelectedTypes] = useState({})   // { typeId: true/false }
  const [selectedValues, setSelectedValues] = useState({})  // { typeId: Set of valueIds }
  const [generating, setGenerating] = useState(false)
  const [batchStock, setBatchStock] = useState('')
  const [batchPrice, setBatchPrice] = useState('')
  const [batchSale, setBatchSale] = useState('')
  // 全品特價（字串）→ 數字，給特價欄 placeholder 用
  const productSale = salePrice !== '' && salePrice != null ? Number(salePrice) : null

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

  async function applyBatchSale() {
    if (batchSale === '') return
    const val = Number(batchSale)
    const ids = variants.map(v => v.id)
    await supabase.from('product_variants').update({ sale_price: val }).in('id', ids)
    setVariants(prev => prev.map(v => ({ ...v, sale_price: val })))
    setBatchSale('')
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
                {!readOnlyStock && (
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
                )}
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
                {onSale && (
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <span className="muted fs12" style={{ color: 'var(--red)' }}>批次特價:</span>
                    <input
                      type="number"
                      value={batchSale}
                      onChange={e => setBatchSale(e.target.value)}
                      placeholder={productSale != null ? String(productSale) : '特價'}
                      style={{ width: 80, padding: '4px 8px', borderRadius: 6, border: '0.5px solid var(--border)', fontSize: 13, textAlign: 'center' }}
                    />
                    <button onClick={applyBatchSale} style={{ ...smallBtn, fontSize: 11 }}>套用</button>
                  </div>
                )}
              </div>

              {/* Table */}
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)' }}>
                      <th style={thStyle}>規格</th>
                      <th style={{ ...thStyle, width: 70, textAlign: 'center' }}>庫存</th>
                      <th style={{ ...thStyle, width: 90, textAlign: 'center' }}>售價(NT$)</th>
                      {onSale && <th style={{ ...thStyle, width: 90, textAlign: 'center', color: 'var(--red)' }}>特價(NT$)</th>}
                      <th style={{ ...thStyle, width: 40 }}></th>
                      <th style={{ ...thStyle, width: 40 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {variants.map(v => (
                      <tr key={`${v.id}-${v.stock}-${v.variant_price}-${v.sale_price}`} style={{ borderBottom: '1px solid var(--border-light, #f0f0f0)' }}>
                        <td style={tdStyle}>
                          <span className="fw600">{resolveVariantLabel(v.options)}</span>
                        </td>
                        <td style={{ ...tdStyle, textAlign: 'center' }}>
                          {readOnlyStock ? (
                            <span className="fw600" style={{ color: (v.stock || 0) === 0 ? 'var(--red)' : 'var(--text)' }} title="庫存請至庫存頁調整">{v.stock || 0}</span>
                          ) : (
                            <input
                              type="number"
                              defaultValue={v.stock}
                              onBlur={e => updateVariantField(v.id, 'stock', e.target.value)}
                              style={cellInput}
                            />
                          )}
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
                        {onSale && (
                          <td style={{ ...tdStyle, textAlign: 'center' }}>
                            <input
                              type="number"
                              defaultValue={v.sale_price ?? ''}
                              placeholder={productSale != null ? String(productSale) : '特價'}
                              onBlur={e => updateVariantField(v.id, 'sale_price', e.target.value)}
                              style={{ ...cellInput, borderColor: 'var(--red)' }}
                            />
                          </td>
                        )}
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
                {onSale && <><br/>特價留空 = 使用全品特價{productSale != null ? ` NT$${productSale.toLocaleString()}` : '（未設定則該規格不特價）'}</>}
                {readOnlyStock && <><br/>庫存為唯讀，請至「庫存」頁調整各規格數量</>}
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
