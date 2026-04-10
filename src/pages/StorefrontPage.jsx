import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'

export default function StorefrontPage() {
  const { can } = useAuth()
  const [tab, setTab] = useState('listings')   // listings | orders | taxonomy
  const [listings, setListings] = useState([])
  const [products, setProducts] = useState([])
  const [orders, setOrders] = useState([])
  const [categories, setCategories] = useState([])
  const [tags, setTags] = useState([])
  const [optionTypes, setOptionTypes] = useState([])
  const [newCat, setNewCat] = useState({ name: '', name_en: '' })
  const [newTag, setNewTag] = useState({ name: '', name_en: '' })
  const [newOptTypeName, setNewOptTypeName] = useState('')
  const [newOptValues, setNewOptValues] = useState({}) // { typeId: inputString }
  const [loading, setLoading] = useState(true)
  const [sheet, setSheet] = useState(null)     // null | 'add' | listing obj

  useEffect(() => { fetchAll() }, [tab])

  async function fetchAll() {
    setLoading(true)
    if (tab === 'listings') {
      const [{ data: sp }, { data: pr }] = await Promise.all([
        supabase.from('storefront_products').select('*, products(*)').order('sort_order'),
        supabase.from('products').select('id, name, sku').order('name'),
      ])
      setListings(sp || [])
      const listed = new Set((sp || []).map(s => s.product_id))
      setProducts((pr || []).filter(p => !listed.has(p.id)))
    } else if (tab === 'orders') {
      const { data } = await supabase
        .from('consumer_orders')
        .select('*')
        .order('created_at', { ascending: false })
      setOrders(data || [])
    } else {
      const [{ data: cats }, { data: tgs }, { data: opts }] = await Promise.all([
        supabase.from('categories').select('*').order('sort_order').order('name'),
        supabase.from('tags').select('*').order('sort_order').order('name'),
        supabase.from('variant_option_types')
          .select('*, variant_option_values(id, value, sort_order)')
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
    await supabase.from('categories').insert({ name: newCat.name.trim(), name_en: newCat.name_en.trim() || null })
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
    await supabase.from('tags').insert({ name: newTag.name.trim(), name_en: newTag.name_en.trim() || null })
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
    const { error } = await supabase.from('variant_option_types').insert({ name: newOptTypeName.trim() })
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

      if (!hasAnyStock && !item.collection_end) {
        // No stock → prompt for collection end time
        setCollectionPrompt({ item, collectionEnd: '' })
        return
      }
    }
    await supabase.from('storefront_products')
      .update({ published: !item.published })
      .eq('id', item.id)
    fetchAll()
  }

  async function confirmCollectionPublish() {
    if (!collectionPrompt?.collectionEnd) return
    await supabase.from('storefront_products')
      .update({ published: true, collection_end: localToISO(collectionPrompt.collectionEnd) })
      .eq('id', collectionPrompt.item.id)
    setCollectionPrompt(null)
    fetchAll()
  }

  async function toggleSoldOut(item) {
    await supabase.from('storefront_products')
      .update({ sold_out: !item.sold_out })
      .eq('id', item.id)
    fetchAll()
  }

  async function deleteListing(id) {
    if (!window.confirm('確定從商城下架並刪除此設定？')) return
    await supabase.from('storefront_products').delete().eq('id', id)
    fetchAll()
  }

  async function updateOrderStatus(id, status) {
    await supabase.from('consumer_orders').update({ status }).eq('id', id)
    fetchAll()
  }

  const unpaidOrders = orders.filter(o => o.status === '待確認' || o.payment_status === '未付')

  return (
    <div className="page">
      <div className="ph">
        <div>
          <div className="ph-title">商城管理</div>
          <div className="ph-sub">前台上架設定 & 消費者訂單</div>
        </div>
        {tab === 'listings' && can('add') && (
          <button className="icon-btn" onClick={() => setSheet('add')} title="上架商品">+</button>
        )}
      </div>

      {/* Stats */}
      <div className="stats">
        <div className="stat">
          <div className="stat-val">{listings.filter(l => l.published).length}</div>
          <div className="stat-lbl">上架中</div>
        </div>
        <div className="stat">
          <div className="stat-val text-amber">{unpaidOrders.length}</div>
          <div className="stat-lbl"><span className="dot" style={{ background: 'var(--amber)' }} />待確認訂單</div>
        </div>
      </div>

      {/* Tab switch */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {[['listings', '商城商品'], ['orders', '消費者訂單'], ['taxonomy', '分類/標籤/規格']].map(([v, label]) => (
          <button key={v} onClick={() => setTab(v)} style={{
            padding: '7px 16px', borderRadius: 20, fontSize: 13, fontWeight: 600,
            cursor: 'pointer', transition: 'all .15s',
            background: tab === v ? 'var(--text)' : 'var(--surface)',
            color: tab === v ? '#fff' : 'var(--text-3)',
            border: `0.5px solid ${tab === v ? 'var(--text)' : 'var(--border)'}`,
          }}>{label}</button>
        ))}
      </div>

      {loading && <div className="empty">載入中…</div>}

      {/* Listings tab */}
      {!loading && tab === 'listings' && (
        <>
          {listings.length === 0 && (
            <div className="empty">尚未上架任何商品，點右上角 + 開始上架</div>
          )}
          {listings.map(item => {
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

            return (
              <div className="card" key={item.id}>
                <div className="card-row" style={{ flexWrap: 'wrap', gap: 8 }}>
                  <div className="item-icon">🛍️</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="fw600 fs15" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      {item.products?.name}
                      <span className={`badge ${item.published ? 'badge-ok' : 'badge-warn'}`}>
                        {item.published ? '上架中' : '已下架'}
                      </span>
                      <span className={`badge ${modeBadge}`}>{modeLabel}</span>
                    </div>
                    <div className="muted fs12 mt8">
                      {item.products?.sku} · 售價 NT${Number(item.shop_price).toLocaleString()}
                    </div>
                    {item.name_en && <div className="muted fs12">{item.name_en}</div>}
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
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
                    {can('delete') && (
                      <button onClick={() => deleteListing(item.id)} style={{ ...smallBtn, color: 'var(--red)' }}>刪除</button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </>
      )}

      {/* Orders tab */}
      {!loading && tab === 'orders' && (
        <>
          {orders.length === 0 && <div className="empty">尚無消費者訂單</div>}
          {orders.map(o => (
            <div className="card" key={o.id}>
              <div className="card-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
                <div className="row-sb" style={{ width: '100%' }}>
                  <span className="fw600 fs15">{o.customer_name}</span>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span className={`badge ${statusBadgeClass(o.status)}`}>{o.status}</span>
                    <span className={`badge ${o.payment_status === '已付清' ? 'badge-ok' : 'badge-low'}`}>{o.payment_status}</span>
                  </div>
                </div>
                <div className="muted fs12">#{String(o.id).slice(-6)} · {o.created_at?.slice(0, 16)}</div>
                <div className="fs13" style={{ color: 'var(--text-2)' }}>{o.items}</div>
                <div className="row-sb" style={{ width: '100%', marginTop: 4 }}>
                  <div>
                    {o.phone && <span className="muted fs12">📞 {o.phone}</span>}
                    {o.email && <span className="muted fs12" style={{ marginLeft: 8 }}>✉️ {o.email}</span>}
                  </div>
                  <div className="fw600 fs15">NT${Number(o.total_amount || 0).toLocaleString()}</div>
                </div>
                {o.note && <div className="fs12 muted">備注：{o.note}</div>}
                {can('pay') && o.status !== '已完成' && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                    {['待確認', '備貨中', '已出貨', '已完成'].map(s => (
                      <button
                        key={s}
                        onClick={() => updateOrderStatus(o.id, s)}
                        style={{
                          ...smallBtn,
                          background: o.status === s ? 'var(--text)' : 'var(--surface)',
                          color: o.status === s ? '#fff' : 'var(--text-3)',
                        }}
                      >{s}</button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </>
      )}

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
    </div>
  )
}

function statusBadgeClass(s) {
  if (s === '已完成') return 'badge-ok'
  if (s === '已出貨') return 'badge-blue'
  if (s === '備貨中') return 'badge-warn'
  return 'badge-low'
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

// ── Add/Edit listing sheet ─────────────────────────────
function ListingSheet({ item, products, onClose, onSaved }) {
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
  })
  const [variants, setVariants] = useState([])
  const [optionTypes, setOptionTypes] = useState([])
  const [saving, setSaving] = useState(false)
  const [createdItem, setCreatedItem] = useState(null)
  const [showVariants, setShowVariants] = useState(false)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const editingItem = item || createdItem
  const isEditing = !!editingItem

  // The product_id we're working with (from existing listing OR selected in dropdown)
  const activeProductId = editingItem?.product_id || (form.product_id ? Number(form.product_id) : null)

  useEffect(() => {
    // Load global option types with their values
    supabase.from('variant_option_types')
      .select('*, variant_option_values(id, value, sort_order)')
      .order('sort_order')
      .then(({ data }) => setOptionTypes(data || []))
  }, [])

  // Load variants whenever activeProductId changes
  useEffect(() => {
    if (activeProductId) {
      supabase.from('product_variants').select('*').eq('product_id', activeProductId)
        .then(({ data }) => {
          setVariants(data || [])
          if ((data || []).length > 0) setShowVariants(true)
        })
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
    }
    if (isEditing) {
      await supabase.from('storefront_products').update(payload).eq('id', editingItem.id)
      setSaving(false)
      onSaved()
      onClose()
    } else {
      const { data, error } = await supabase.from('storefront_products').insert({
        ...payload,
        product_id: Number(form.product_id),
      }).select('*, products(*)').single()
      setSaving(false)
      onSaved()
      if (error) { alert('建立失敗：' + error.message); return }
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
    if (sellingMode === 'stock' && variants.length > 0) {
      const totalStock = variants.reduce((sum, v) => sum + (v.stock || 0), 0)
      if (totalStock <= 0) { alert('現貨模式下至少需要一個規格有庫存，或改用收單模式'); return false }
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
            <select className="form-select" value={form.product_id} onChange={e => set('product_id', e.target.value)}>
              <option value="">— 選擇商品 —</option>
              {products.map(p => <option key={p.id} value={p.id}>{p.name}（{p.sku}）</option>)}
            </select>
          </div>
        )}

        {/* ── 2. 售價 ── */}
        <div className="form-group">
          <label className="form-label">商城售價（NT$）</label>
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
                shopPrice={Number(form.shop_price) || 0}
                resolveVariantLabel={resolveVariantLabel}
              />
            )}
          </>
        )}

        {/* ── 4. 銷售模式 ── */}
        <div className="sec" style={{ marginTop: 16 }}>銷售模式</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button
            onClick={() => set('collection_end', '')}
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
            onClick={() => { if (!form.collection_end) set('collection_end', '') }}
            style={{
              flex: 1, padding: '12px 8px', borderRadius: 10, fontSize: 13, fontWeight: 600,
              cursor: 'pointer', transition: 'all .15s', textAlign: 'center',
              background: sellingMode === 'collection' ? 'var(--text)' : 'var(--surface)',
              color: sellingMode === 'collection' ? '#fff' : 'var(--text-3)',
              border: `0.5px solid ${sellingMode === 'collection' ? 'var(--text)' : 'var(--border)'}`,
            }}
            // clicking this enables collection mode by setting a placeholder date
            onClickCapture={() => {
              if (sellingMode !== 'collection') {
                // Set a default collection_end 7 days from now
                const d = new Date(); d.setDate(d.getDate() + 7)
                const pad = n => String(n).padStart(2, '0')
                const val = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
                set('collection_end', val)
              }
            }}
          >
            🛒 收單模式
            <div style={{ fontSize: 11, fontWeight: 400, marginTop: 2, opacity: 0.8 }}>限時收單，截止後叫貨</div>
          </button>
        </div>

        {sellingMode === 'collection' && (
          <div className="form-group">
            <label className="form-label">收單截止時間</label>
            <input className="form-input" type="datetime-local" value={form.collection_end} onChange={e => set('collection_end', e.target.value)} />
          </div>
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

function VariantManager({ variants, setVariants, optionTypes, productId, shopPrice, resolveVariantLabel }) {
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
