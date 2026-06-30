import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { SUPPORTED_CURRENCIES } from '../constants/currency'
import { useAuth } from '../hooks/useAuth'
import CustomSelect from '../components/CustomSelect'
import { compressImage, uploadImages } from '../lib/imageUtils'
import { toTwdCost, calcMargin } from '../lib/pricing'
import { cmpNum, cmpStr, cmpDate } from '../lib/sortUtils'
import { Pill } from '../components/MenuPopover'
import ListToolbar from '../components/ListToolbar'
import QuickListSheet from '../components/QuickListSheet'

const LOW = 5

const PAGE_SIZE = 20

// 排序選項（預設＝第一項：建立 新→舊）
const SORT_OPTIONS = [
  { group: '時間', items: [
    { value: 'created_desc', label: '建立 新→舊' }, { value: 'created_asc', label: '建立 舊→新' },
    { value: 'listed_desc', label: '上架 新→舊' }, { value: 'listed_asc', label: '上架 舊→新' },
  ]},
  { group: '庫存', items: [{ value: 'stock_asc', label: '庫存 少→多' }, { value: 'stock_desc', label: '庫存 多→少' }]},
  { group: '獲利', items: [
    { value: 'margin_desc', label: '毛利率 高→低' }, { value: 'margin_asc', label: '毛利率 低→高' },
    { value: 'price_desc', label: '售價 高→低' }, { value: 'price_asc', label: '售價 低→高' },
    { value: 'cost_desc', label: '成本 高→低' }, { value: 'cost_asc', label: '成本 低→高' },
  ]},
  { group: '名稱', items: [{ value: 'name_asc', label: '名稱 A→Z' }]},
]

// 毛利率（沒成本/沒上架/缺匯率 → null，由比較器沉底）
function marginRate(p, rates) {
  const sf = storefrontOf(p)
  if (!sf || sf.shop_price == null) return null
  const m = calcMargin(sf.shop_price, toTwdCost(p.cost, p.currency, rates))
  return m ? m.rate : null
}

function sortComparator(sort, rates) {
  switch (sort) {
    case 'created_asc': return cmpDate(p => p.created_at, 'asc')
    case 'listed_desc': return cmpDate(p => storefrontOf(p)?.created_at, 'desc')
    case 'listed_asc': return cmpDate(p => storefrontOf(p)?.created_at, 'asc')
    case 'stock_asc': return cmpNum(totalStock, 'asc')
    case 'stock_desc': return cmpNum(totalStock, 'desc')
    case 'margin_desc': return cmpNum(p => marginRate(p, rates), 'desc')
    case 'margin_asc': return cmpNum(p => marginRate(p, rates), 'asc')
    case 'price_desc': return cmpNum(p => storefrontOf(p)?.shop_price, 'desc')
    case 'price_asc': return cmpNum(p => storefrontOf(p)?.shop_price, 'asc')
    case 'cost_desc': return cmpNum(p => toTwdCost(p.cost, p.currency, rates), 'desc')
    case 'cost_asc': return cmpNum(p => toTwdCost(p.cost, p.currency, rates), 'asc')
    case 'name_asc': return cmpStr(p => p.name, 'asc')
    case 'created_desc':
    default: return cmpDate(p => p.created_at, 'desc')
  }
}

// ── 庫存判定 helper（單一來源）──────────────────────────
// 商城 listing（一個商品最多一筆）
function storefrontOf(p) { return p.storefront_products?.[0] || null }
// 是否追蹤庫存：限時單(collection_end)或勾選略過(skip_stock_check)不列入低庫存
function isStockTracked(p) {
  const sf = storefrontOf(p)
  if (!sf) return true
  if (sf.skip_stock_check) return false
  if (sf.collection_end) return false
  return true
}
// 各庫存單位：有規格→每個規格 stock；無規格→總量
function stockUnits(p) {
  const vs = p.product_variants || []
  return vs.length > 0 ? vs.map(v => v.stock || 0) : [p.quantity || 0]
}
function totalStock(p) {
  const vs = p.product_variants || []
  return vs.length > 0 ? vs.reduce((s, v) => s + (v.stock || 0), 0) : (p.quantity || 0)
}
// 低庫存：任一庫存單位 < LOW（含 0=缺貨）；不追蹤者永不低庫存
function isLowStock(p) {
  if (!isStockTracked(p)) return false
  return stockUnits(p).some(s => s < LOW)
}
function isOutOfStock(p) {
  if (!isStockTracked(p)) return false
  return stockUnits(p).some(s => s === 0)
}
// 把 variant.options 解析成可讀字串，需要 optionTypes（含 values）
function resolveVariantLabel(options, optionTypes) {
  if (!options || Object.keys(options).length === 0) return '無規格'
  return Object.entries(options).map(([typeId, valueId]) => {
    const type = optionTypes.find(t => t.id === Number(typeId))
    const val = type?.variant_option_values?.find(v => v.id === valueId)
    return val ? `${type.name}: ${val.value}` : ''
  }).filter(Boolean).join(' / ')
}

export default function InventoryPage() {
  const { profile, signOut, can, storeId } = useAuth()
  const [products, setProducts] = useState([])
  const [search, setSearch] = useState('')
  const [filterSource, setFilterSource] = useState('')
  const [filterCategory, setFilterCategory] = useState('')
  const [filterNoCost, setFilterNoCost] = useState(false)
  const [sort, setSort] = useState('created_desc')
  const [categories, setCategories] = useState([])
  const [optionTypes, setOptionTypes] = useState([])
  const [exchangeRates, setExchangeRates] = useState({})
  const [sheet, setSheet] = useState(null)   // null | 'add' | product obj
  const [quickList, setQuickList] = useState(false)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)

  useEffect(() => { if (!storeId) return; fetchProducts(); fetchCategories(); fetchOptionTypes(); fetchRates() }, [storeId])

  async function fetchProducts() {
    const { data } = await supabase
      .from('products')
      .select('*, product_images(id, url, sort_order), categories(id, name), product_tags(tag_id), product_variants(id, options, stock, variant_price), storefront_products(id, shop_price, published, sold_out, collection_end, skip_stock_check, created_at)')
      .eq('store_id', storeId)
      .order('name')
    setProducts(data || [])
    setLoading(false)
  }

  async function fetchCategories() {
    const { data } = await supabase.from('categories').select('*').eq('store_id', storeId).order('sort_order')
    setCategories(data || [])
  }

  async function fetchOptionTypes() {
    const { data } = await supabase.from('variant_option_types')
      .select('*, variant_option_values(id, value, sort_order)')
      .eq('store_id', storeId).order('sort_order')
    setOptionTypes(data || [])
  }

  async function fetchRates() {
    const { data } = await supabase.from('exchange_rates').select('*')
    const map = {}
    ;(data || []).forEach(r => { map[r.currency] = Number(r.rate) })
    setExchangeRates(map)
  }

  const filtered = products.filter(p => {
    const matchSearch = p.name.toLowerCase().includes(search.toLowerCase()) ||
      (p.sku && p.sku.toLowerCase().includes(search.toLowerCase()))
    const matchSource = !filterSource || (p.source || '') === filterSource
    const matchCategory = !filterCategory || String(p.category_id || '') === filterCategory
    const matchNoCost = !filterNoCost || p.cost == null
    return matchSearch && matchSource && matchCategory && matchNoCost
  })
  // 低庫存警示永遠釘最上、依庫存少→多（最急的在前）；其餘依使用者選的排序
  const low = filtered.filter(isLowStock).sort(cmpNum(totalStock, 'asc'))
  const normal = filtered.filter(p => !isLowStock(p)).sort(sortComparator(sort, exchangeRates))
  const allFiltered = [...low, ...normal]
  const totalPages = Math.max(1, Math.ceil(allFiltered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pagedProducts = allFiltered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
  const pagedLow = pagedProducts.filter(isLowStock)
  const pagedNormal = pagedProducts.filter(p => !isLowStock(p))
  const existingSources = [...new Set(products.map(p => p.source).filter(Boolean))].sort()

  return (
    <div className="page">
      <div className="ph">
        <div>
          <div className="ph-title">庫存總覽</div>
          <div className="ph-sub">
            {profile?.name || '成員'}
          </div>
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          {can('add') && (
            <>
              <button
                onClick={() => setQuickList(true)}
                style={{
                  padding:'6px 12px',borderRadius:20,fontSize:12,fontWeight:600,
                  background:'var(--text)',color:'#fff',border:'none',cursor:'pointer',
                  whiteSpace:'nowrap',
                }}
              >快速上架</button>
              <button className="icon-btn" onClick={() => setSheet('add')}>+</button>
            </>
          )}
          <button
            onClick={signOut}
            style={{background:'none',border:'none',fontSize:13,color:'var(--text-3)',cursor:'pointer',padding:'6px 0'}}
          >登出</button>
        </div>
      </div>

      <div className="stats">
        <div className="stat">
          <div className="stat-val">{products.length}</div>
          <div className="stat-lbl">商品種類</div>
        </div>
        <div className="stat">
          <div className="stat-val text-red">{products.filter(isLowStock).length}</div>
          <div className="stat-lbl"><span className="dot" style={{background:'var(--red)'}} />低庫存</div>
        </div>
      </div>

      <ListToolbar
        search={search}
        onSearch={v => { setSearch(v); setPage(1) }}
        placeholder="搜尋商品名稱或 SKU…"
        sort={{ options: SORT_OPTIONS, value: sort, onChange: v => { setSort(v); setPage(1) } }}
        filter={{
          active: !!(filterCategory || filterSource || filterNoCost),
          onClear: () => { setFilterCategory(''); setFilterSource(''); setFilterNoCost(false); setPage(1) },
          children: (
            <>
              {categories.length > 0 && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-3)', marginBottom: 8 }}>分類</div>
                  <CustomSelect compact label="全部分類" value={filterCategory || null}
                    options={categories.map(c => ({ value: String(c.id), label: c.name }))}
                    onChange={v => { setFilterCategory(v || ''); setPage(1) }} />
                </div>
              )}
              {existingSources.length > 0 && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-3)', marginBottom: 8 }}>採購來源</div>
                  <CustomSelect compact label="全部來源" value={filterSource || null}
                    options={existingSources.map(s => ({ value: s, label: s }))}
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

      {loading && <div className="empty">載入中…</div>}

      {pagedLow.length > 0 && (
        <>
          <div className="sec">⚠ 低庫存警示</div>
          <div className="card-grid">
            {pagedLow.map(p => <ProductRow key={p.id} product={p} onTap={() => setSheet(p)} exchangeRates={exchangeRates} />)}
          </div>
        </>
      )}

      {pagedNormal.length > 0 && (
        <>
          <div className="sec">所有商品</div>
          <div className="card-grid">
            {pagedNormal.map(p => <ProductRow key={p.id} product={p} onTap={() => setSheet(p)} exchangeRates={exchangeRates} />)}
          </div>
        </>
      )}

      {allFiltered.length === 0 && !loading && (
        <div className="empty">找不到符合的商品</div>
      )}

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

      {sheet === 'add' && (
        <AddProductSheet onClose={() => setSheet(null)} onSaved={fetchProducts} existingSources={existingSources} />
      )}
      {sheet && sheet !== 'add' && (
        <ProductDetailSheet
          product={sheet}
          onClose={() => setSheet(null)}
          onSaved={fetchProducts}
          canEdit={can('edit')}
          canDelete={can('delete')}
          existingSources={existingSources}
          optionTypes={optionTypes}
          exchangeRates={exchangeRates}
        />
      )}
      {quickList && (
        <QuickListSheet
          onClose={() => setQuickList(false)}
          onSaved={fetchProducts}
          existingSources={existingSources}
        />
      )}
    </div>
  )
}

function ProductRow({ product: p, onTap, exchangeRates = {} }) {
  const thumb = p.product_images?.sort((a, b) => a.sort_order - b.sort_order)[0]?.url
  const vs = p.product_variants || []
  const hasVar = vs.length > 0
  const total = totalStock(p)
  const tracked = isStockTracked(p)
  const low = isLowStock(p)
  const out = isOutOfStock(p)
  const sf = storefrontOf(p)

  // 毛利率（成本換 TWD 後與售價比）
  const twdCost = toTwdCost(p.cost, p.currency, exchangeRates)
  const margin = sf?.shop_price != null ? calcMargin(sf.shop_price, twdCost) : null

  // 左側資訊：SKU · 成本 · 售價 · 毛利率
  const infoParts = []
  if (p.sku) infoParts.push(p.sku)
  if (p.cost != null) infoParts.push(`成本 ${Number(p.cost).toLocaleString()} ${p.currency || 'TWD'}`)
  if (sf?.shop_price != null) infoParts.push(`售價 NT$${Number(sf.shop_price).toLocaleString()}`)
  if (margin) infoParts.push(`毛利率 ${margin.rate}%`)

  // 右側徽章
  let badge
  if (!tracked) badge = <span className="badge badge-warn">{sf?.collection_end ? '限時單' : '不追蹤'}</span>
  else if (out) badge = <span className="badge badge-low">缺貨</span>
  else if (low) badge = <span className="badge badge-low">低庫存</span>
  else badge = <span className="badge badge-ok">正常</span>

  return (
    <div className="card" onClick={onTap} style={{cursor:'pointer'}}>
      <div className="card-row">
        <div className="item-icon" style={{overflow:'hidden',borderRadius:8,flexShrink:0}}>
          {thumb
            ? <img src={thumb} style={{width:40,height:40,objectFit:'cover',borderRadius:8,display:'block'}} />
            : '📦'}
        </div>
        <div style={{flex:1,minWidth:0}}>
          <div className="fw600 fs15" style={{whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{p.name}</div>
          <div className="muted fs12 mt8" style={{whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{infoParts.join(' · ')}</div>
        </div>
        <div style={{textAlign:'right',flexShrink:0}}>
          <div className="fw600 fs15" style={{color: (low || out) ? 'var(--red)' : 'var(--text)'}}>{total}</div>
          {hasVar && <div className="muted fs11">{vs.length} 規格</div>}
          <div className="fs12 mt8">{badge}</div>
        </div>
      </div>
    </div>
  )
}


// ── 新增商品 ────────────────────────────────────────────
function AddProductSheet({ onClose, onSaved, existingSources = [] }) {
  const { storeId } = useAuth()
  const [form, setForm] = useState({ name:'', sku:'', quantity:'', unit:'個', cost:'', currency:'TWD', source:'' })
  const [saving, setSaving] = useState(false)
  const [imageFiles, setImageFiles] = useState([])
  const [previews, setPreviews] = useState([])
  const [categories, setCategories] = useState([])
  const [selectedCategory, setSelectedCategory] = useState('')
  const set = (k, v) => setForm(f => ({...f, [k]: v}))

  useEffect(() => {
    if (!storeId) return
    supabase.from('categories').select('*').eq('store_id', storeId).order('sort_order')
      .then(({ data }) => setCategories(data || []))
  }, [storeId])

  function onImagesChange(e) {
    const files = Array.from(e.target.files)
    if (!files.length) return
    setImageFiles(prev => [...prev, ...files])
    setPreviews(prev => [...prev, ...files.map(f => URL.createObjectURL(f))])
    e.target.value = ''   // allow re-selecting same file
  }

  function removePreview(idx) {
    setImageFiles(prev => prev.filter((_, i) => i !== idx))
    setPreviews(prev => prev.filter((_, i) => i !== idx))
  }

  async function save() {
    if (!form.name) return
    setSaving(true)
    const qty = Number(form.quantity) || 0
    const { data: inserted } = await supabase.from('products').insert({
      store_id: storeId,
      name: form.name,
      sku: form.sku.trim() ? form.sku.toUpperCase() : null,
      quantity: qty,
      unit: form.unit,
      cost: Number(form.cost),
      currency: form.currency,
      category_id: selectedCategory ? Number(selectedCategory) : null,
      source: form.source.trim() || null,
    }).select('id').single()

    if (imageFiles.length > 0 && inserted) {
      await uploadImages(imageFiles, inserted.id)
    }

    if (qty > 0 && inserted) {
      await supabase.from('history').insert({
        store_id: storeId,
        sku: form.sku.toUpperCase() || null,
        product_id: inserted.id,
        change: qty,
        reason: '初始建立',
      })
    }
    setSaving(false)
    onSaved()
    onClose()
  }

  return (
    <Sheet title="新增商品" onClose={onClose}>
      {/* 圖片區 */}
      <div className="form-group">
        <label className="form-label">商品圖片</label>
        {previews.length > 0 && (
          <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:10}}>
            {previews.map((src, i) => (
              <div key={i} style={{position:'relative'}}>
                <img src={src} style={{width:72,height:72,objectFit:'cover',borderRadius:8,display:'block'}} />
                <button
                  onClick={() => removePreview(i)}
                  style={{position:'absolute',top:-6,right:-6,width:20,height:20,borderRadius:'50%',background:'var(--red)',color:'#fff',border:'none',cursor:'pointer',fontSize:12,lineHeight:'20px',textAlign:'center',padding:0}}
                >×</button>
              </div>
            ))}
          </div>
        )}
        <label style={{display:'flex',alignItems:'center',justifyContent:'center',gap:6,padding:'11px',border:'1.5px dashed var(--border)',borderRadius:10,cursor:'pointer',fontSize:13,color:'var(--text-3)'}}>
          📷 新增圖片
          <input type="file" accept="image/*" multiple style={{display:'none'}} onChange={onImagesChange} />
        </label>
      </div>

      <div className="form-group">
        <label className="form-label">商品名稱</label>
        <input className="form-input" placeholder="例：防水噴霧 500ml" value={form.name} onChange={e => set('name', e.target.value)} />
      </div>
      {categories.length > 0 && (
        <div className="form-group">
          <label className="form-label">分類</label>
          <CustomSelect
            label="— 無分類 —"
            value={selectedCategory || null}
            options={categories.map(c => ({ value: String(c.id), label: c.name }))}
            onChange={v => setSelectedCategory(v || '')}
          />
        </div>
      )}
      <div className="form-group">
        <label className="form-label">採購來源（品牌/店家）</label>
        {form._selectMode ? (
          <CustomSelect
            label="— 選擇來源 —"
            value={form.source || null}
            options={[
              ...existingSources.map(s => ({ value: s, label: s })),
              { value: '__custom__', label: '＋ 自訂來源' },
            ]}
            onChange={v => {
              if (v === '__custom__') { set('_selectMode', false); set('source', '') }
              else { set('source', v || ''); set('_selectMode', false) }
            }}
            allowClear={false}
          />
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="form-input" style={{ flex: 1 }} placeholder="例：UNIQLO、GU、ABC-MART" value={form.source} onChange={e => set('source', e.target.value)} />
            {existingSources.length > 0 && (
              <button type="button" className="btn btn-outline" style={{ width: 'auto', padding: '0 14px', fontSize: 13 }}
                onClick={() => set('_selectMode', true)}>選擇</button>
            )}
          </div>
        )}
      </div>
      <div className="form-group">
        <label className="form-label">SKU 代碼</label>
        <input className="form-input" placeholder="例：SPRAY-001" value={form.sku} onChange={e => set('sku', e.target.value)} style={{textTransform:'uppercase'}} />
      </div>
      <div className="form-group">
        <label className="form-label">單位</label>
        <input className="form-input" placeholder="個" value={form.unit} onChange={e => set('unit', e.target.value)} style={{ width: 120 }} />
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
        <div className="form-group">
          <label className="form-label">進貨成本</label>
          <input className="form-input" type="number" placeholder="0" value={form.cost} onChange={e => set('cost', e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">幣別</label>
          <CustomSelect
            label="TWD"
            value={form.currency}
            options={SUPPORTED_CURRENCIES.map(c => ({ value: c, label: c }))}
            onChange={v => set('currency', v || 'TWD')}
            allowClear={false}
          />
        </div>
      </div>
      <button className="btn" onClick={save} disabled={saving}>{saving ? '儲存中…' : '新增商品'}</button>
    </Sheet>
  )
}

// ── 可編輯欄位（inline edit，blur/Enter 存檔）─────────────
function EditableField({ productId, field, initialValue, canEdit, onSaved, onValueSaved, label, placeholder, type = 'text', inputStyle }) {
  const [value, setValue] = useState(initialValue ?? '')
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)
  function onChange(e) { setValue(e.target.value); setDirty(true); setSaved(false) }
  async function save() {
    if (!dirty) return
    const updateVal = type === 'number' ? (Number(value) || 0) : (value.trim() || null)
    await supabase.from('products').update({ [field]: updateVal }).eq('id', productId)
    setDirty(false); setSaved(true)
    if (onValueSaved) onValueSaved(type === 'number' ? (Number(value) || 0) : value.trim())
    if (onSaved) onSaved()
    setTimeout(() => setSaved(false), 1500)
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10, padding: '8px 12px' }}>
      <span className="fs12 muted" style={{ flexShrink: 0 }}>{label}</span>
      {canEdit ? (
        <>
          <input
            value={value}
            onChange={onChange}
            onBlur={save}
            onKeyDown={e => e.key === 'Enter' && save()}
            placeholder={placeholder}
            type={type}
            style={{ flex: 1, border: 'none', background: 'transparent', outline: 'none', fontSize: 14, fontWeight: 600, color: 'var(--text)', minWidth: 0, ...inputStyle }}
          />
          {saved && <span className="fs12" style={{ color: 'var(--green)', flexShrink: 0 }}>✓</span>}
        </>
      ) : (
        <span className="fs14 fw600" style={{ color: value ? 'var(--text)' : 'var(--text-3)' }}>{value || '未設定'}</span>
      )}
    </div>
  )
}

// ── 可編輯下拉選單欄位 ─────────────────────────────────
function EditableSelectField({ productId, field, initialValue, canEdit, onSaved, label, options }) {
  const [value, setValue] = useState(initialValue)
  const [saved, setSaved] = useState(false)
  async function onSelect(newVal) {
    setValue(newVal)
    await supabase.from('products').update({ [field]: newVal }).eq('id', productId)
    setSaved(true)
    if (onSaved) onSaved()
    setTimeout(() => setSaved(false), 1500)
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10, padding: '8px 12px' }}>
      <span className="fs12 muted" style={{ flexShrink: 0 }}>{label}</span>
      {canEdit ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
          <CustomSelect
            label={value || '選擇'}
            value={value}
            options={options.map(o => ({ value: o, label: o }))}
            onChange={v => v && onSelect(v)}
            allowClear={false}
            compact
            style={{ flex: 1 }}
          />
          {saved && <span className="fs12" style={{ color: 'var(--green)', flexShrink: 0 }}>✓</span>}
        </div>
      ) : (
        <span className="fs14 fw600">{value}</span>
      )}
    </div>
  )
}

// ── 規格庫存編輯器（庫存頁是 stock 的唯一編輯入口）─────────
function VariantStockEditor({ variants, optionTypes, canEdit, onSaved }) {
  const [rows, setRows] = useState(variants || [])
  const total = rows.reduce((s, v) => s + (v.stock || 0), 0)

  async function saveStock(id, value) {
    const v = Math.max(0, Math.round(Number(value) || 0))
    await supabase.from('product_variants').update({ stock: v }).eq('id', id)
    setRows(prev => prev.map(r => r.id === id ? { ...r, stock: v } : r))
    if (onSaved) onSaved()
  }

  const sorted = [...rows].sort((a, b) =>
    resolveVariantLabel(a.options, optionTypes).localeCompare(resolveVariantLabel(b.options, optionTypes)))

  return (
    <div style={{ marginBottom: 12 }}>
      <div className="muted fs12" style={{ marginBottom: 8 }}>
        合計 {total} 件 · {rows.length} 規格（總量由各規格自動加總）
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {sorted.map(v => {
          const s = v.stock || 0
          const out = s === 0
          const low = s > 0 && s < LOW
          return (
            <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10, padding: '8px 12px' }}>
              <span className="fs13 fw600" style={{ flex: 1, minWidth: 0 }}>{resolveVariantLabel(v.options, optionTypes)}</span>
              {(out || low) && <span className="badge badge-low" style={{ fontSize: 11 }}>{out ? '缺貨' : '低'}</span>}
              {canEdit ? (
                <input
                  type="number"
                  defaultValue={s}
                  onBlur={e => saveStock(v.id, e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()}
                  style={{ width: 64, textAlign: 'center', border: '0.5px solid var(--border)', borderRadius: 8, padding: '6px 8px', fontSize: 14, fontWeight: 600, background: 'var(--bg)', color: 'var(--text)' }}
                />
              ) : (
                <span className="fs14 fw600">{s}</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── 商城上架資訊（唯讀；售價/毛利於商城頁調整）────────────
function StorefrontInfo({ product, exchangeRates }) {
  const sf = product.storefront_products?.[0]
  if (!sf) return <div className="muted fs12" style={{ marginBottom: 12 }}>尚未上架商城</div>
  const twdCost = toTwdCost(product.cost, product.currency, exchangeRates)
  const margin = sf.shop_price != null ? calcMargin(sf.shop_price, twdCost) : null
  const parts = []
  if (sf.shop_price != null) parts.push(`售價 NT$${Number(sf.shop_price).toLocaleString()}`)
  if (margin) parts.push(`毛利 NT$${margin.amount.toLocaleString()}（${margin.rate}%）`)
  parts.push(sf.collection_end ? '限時收單' : (sf.skip_stock_check ? '不追蹤庫存' : '現貨'))
  parts.push(sf.published ? '上架中' : '已下架')
  return (
    <div style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10, padding: '8px 12px', marginBottom: 12 }}>
      <div className="fs13" style={{ color: 'var(--text)' }}>{parts.join(' · ')}</div>
      <div className="muted fs11" style={{ marginTop: 4 }}>售價／毛利請於「商城」頁調整</div>
    </div>
  )
}

// ── 商品詳情 ────────────────────────────────────────────
function ProductDetailSheet({ product, onClose, onSaved, canEdit, canDelete, existingSources = [], optionTypes = [], exchangeRates = {} }) {
  const { storeId } = useAuth()
  const [saving, setSaving] = useState(false)
  const [productName, setProductName] = useState(product.name)
  const [images, setImages] = useState(
    [...(product.product_images || [])].sort((a, b) => a.sort_order - b.sort_order)
  )
  const [uploading, setUploading] = useState(false)
  const [categories, setCategories] = useState([])
  const [allTags, setAllTags] = useState([])
  const [selectedCategory, setSelectedCategory] = useState(product.category_id ? String(product.category_id) : '')
  const [selectedTags, setSelectedTags] = useState(
    (product.product_tags || []).map(pt => pt.tag_id)
  )

  useEffect(() => {
    if (!storeId) return
    Promise.all([
      supabase.from('categories').select('*').eq('store_id', storeId).order('sort_order'),
      supabase.from('tags').select('*').eq('store_id', storeId).order('sort_order'),
    ]).then(([{ data: cats }, { data: tgs }]) => {
      setCategories(cats || [])
      setAllTags(tgs || [])
    })
  }, [product.sku, storeId])

  async function saveCategory(catId) {
    await supabase.from('products')
      .update({ category_id: catId ? Number(catId) : null })
      .eq('id', product.id)
    setSelectedCategory(catId)
    if (onSaved) onSaved()
  }

  async function toggleTag(tagId, checked) {
    if (checked) {
      await supabase.from('product_tags').insert({ product_id: product.id, tag_id: tagId })
      setSelectedTags(prev => [...prev, tagId])
    } else {
      await supabase.from('product_tags').delete().eq('product_id', product.id).eq('tag_id', tagId)
      setSelectedTags(prev => prev.filter(id => id !== tagId))
    }
    if (onSaved) onSaved()
  }

  async function onImagesChange(e) {
    const files = Array.from(e.target.files)
    if (!files.length) return
    setUploading(true)
    e.target.value = ''
    const startOrder = images.length
    const newUrls = []
    for (let i = 0; i < files.length; i++) {
      const compressed = await compressImage(files[i])
      const ext = compressed.name.split('.').pop().toLowerCase()
      const path = `${product.id}/${Date.now()}-${i}.${ext}`
      const { error } = await supabase.storage.from('product-images').upload(path, compressed)
      if (!error) {
        const { data: { publicUrl } } = supabase.storage.from('product-images').getPublicUrl(path)
        newUrls.push({ url: publicUrl, sort_order: startOrder + i })
      }
    }
    if (newUrls.length > 0) {
      const { data: inserted } = await supabase.from('product_images')
        .insert(newUrls.map(r => ({ ...r, product_id: product.id })))
        .select('id, url, sort_order')
      setImages(prev => [...prev, ...(inserted || [])])
    }
    setUploading(false)
  }

  async function deleteImage(imgId, idx) {
    await supabase.from('product_images').delete().eq('id', imgId)
    setImages(prev => prev.filter((_, i) => i !== idx))
  }

  // 重排圖片：第一張即列表縮圖/封面。交換相鄰兩張後整體重新編號並存回。
  async function moveImage(idx, dir) {
    const j = idx + dir
    if (j < 0 || j >= images.length) return
    const next = [...images]
    ;[next[idx], next[j]] = [next[j], next[idx]]
    const renumbered = next.map((img, i) => ({ ...img, sort_order: i }))
    setImages(renumbered)
    await Promise.all(
      renumbered.filter(img => img.id != null).map(img =>
        supabase.from('product_images').update({ sort_order: img.sort_order }).eq('id', img.id)
      )
    )
    if (onSaved) onSaved()
  }

  async function deleteProduct() {
    if (!window.confirm(`確定刪除「${product.name}」？`)) return
    await supabase.from('products').delete().eq('id', product.id)
    onSaved()
    onClose()
  }

  return (
    <Sheet title={productName} onClose={onClose}>

      {/* 商品名稱 */}
      <EditableField
        productId={product.id} field="name" initialValue={product.name}
        canEdit={canEdit} onSaved={onSaved} onValueSaved={v => setProductName(v)}
        label="商品名稱" placeholder="商品名稱"
      />

      {/* 圖片管理 */}
      <div className="form-group">
        <label className="form-label">商品圖片 ({images.length} 張)</label>
        {images.length > 0 && (
          <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:10}}>
            {images.map((img, idx) => (
              <div key={img.id ?? idx} style={{position:'relative'}}>
                <img src={img.url} style={{width:72,height:72,objectFit:'cover',borderRadius:8,display:'block'}} />
                {idx === 0 && (
                  <span style={{position:'absolute',top:4,left:4,background:'rgba(0,0,0,0.65)',color:'#fff',fontSize:10,fontWeight:600,padding:'1px 6px',borderRadius:6}}>封面</span>
                )}
                {canEdit && (
                  <>
                    <button
                      onClick={() => deleteImage(img.id, idx)}
                      style={{position:'absolute',top:-6,right:-6,width:20,height:20,borderRadius:'50%',background:'var(--red)',color:'#fff',border:'none',cursor:'pointer',fontSize:12,lineHeight:'20px',textAlign:'center',padding:0}}
                    >×</button>
                    {images.length > 1 && (
                      <div style={{position:'absolute',bottom:0,left:0,right:0,display:'flex',borderBottomLeftRadius:8,borderBottomRightRadius:8,overflow:'hidden'}}>
                        <button onClick={() => moveImage(idx, -1)} disabled={idx === 0}
                          style={{flex:1,border:'none',background:'rgba(0,0,0,0.55)',color:'#fff',cursor:idx===0?'default':'pointer',opacity:idx===0?0.35:1,fontSize:13,padding:'2px 0'}}
                          aria-label="往前移">◀</button>
                        <button onClick={() => moveImage(idx, 1)} disabled={idx === images.length - 1}
                          style={{flex:1,border:'none',borderLeft:'1px solid rgba(255,255,255,0.25)',background:'rgba(0,0,0,0.55)',color:'#fff',cursor:idx===images.length-1?'default':'pointer',opacity:idx===images.length-1?0.35:1,fontSize:13,padding:'2px 0'}}
                          aria-label="往後移">▶</button>
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
        )}
        {canEdit && (
          <label style={{display:'flex',alignItems:'center',justifyContent:'center',gap:6,padding:'11px',border:'1.5px dashed var(--border)',borderRadius:10,cursor:'pointer',fontSize:13,color:'var(--text-3)'}}>
            {uploading ? '上傳中…' : '📷 新增圖片'}
            <input type="file" accept="image/*" multiple style={{display:'none'}} onChange={onImagesChange} disabled={uploading} />
          </label>
        )}
      </div>

      {/* 庫存 */}
      <div className="sec" style={{ marginTop: 12 }}>庫存</div>
      {(product.product_variants || []).length > 0 ? (
        <VariantStockEditor
          variants={product.product_variants}
          optionTypes={optionTypes}
          canEdit={canEdit}
          onSaved={onSaved}
        />
      ) : (
        <div style={{ marginBottom: 12 }}>
          <EditableField
            productId={product.id} field="quantity" initialValue={product.quantity}
            canEdit={canEdit} onSaved={onSaved}
            label="庫存數量" placeholder="0" type="number"
          />
        </div>
      )}

      {/* 商城（唯讀，售價/毛利於商城頁調整）*/}
      <div className="sec">商城</div>
      <StorefrontInfo product={product} exchangeRates={exchangeRates} />

      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:12,marginTop:12}}>
        <EditableField
          productId={product.id} field="cost" initialValue={product.cost}
          canEdit={canEdit} onSaved={onSaved}
          label="成本" placeholder="0" type="number"
        />
        <EditableSelectField
          productId={product.id} field="currency" initialValue={product.currency || 'TWD'}
          canEdit={canEdit} onSaved={onSaved}
          label="幣別" options={SUPPORTED_CURRENCIES}
        />
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1fr',gap:8,marginBottom:12}}>
        <EditableField
          productId={product.id} field="sku" initialValue={product.sku}
          canEdit={canEdit} onSaved={onSaved}
          label="SKU" placeholder="SKU" inputStyle={{textTransform:'uppercase'}}
        />
      </div>

      {/* 採購來源 */}
      <SourceField productId={product.id} initialSource={product.source || ''} canEdit={canEdit} onSaved={onSaved} existingSources={existingSources} />

      {/* 分類 & 標籤 */}
      {(categories.length > 0 || allTags.length > 0) && (
        <>
          <div className="sec">分類 & 標籤</div>
          {categories.length > 0 && (
            <div className="form-group">
              <label className="form-label">分類</label>
              {canEdit ? (
                <CustomSelect
                  label="— 無分類 —"
                  value={selectedCategory || null}
                  options={categories.map(c => ({ value: String(c.id), label: c.name }))}
                  onChange={v => saveCategory(v || '')}
                />
              ) : (
                <div className="form-input" style={{ background: 'var(--bg)', color: 'var(--text-3)' }}>
                  {categories.find(c => String(c.id) === String(selectedCategory))?.name || '— 無分類 —'}
                </div>
              )}
            </div>
          )}
          {allTags.length > 0 && (
            <div className="form-group">
              <label className="form-label">標籤（可複選）</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                {allTags.map(tag => {
                  const checked = selectedTags.includes(tag.id)
                  return (
                    <button
                      key={tag.id}
                      onClick={() => canEdit && toggleTag(tag.id, !checked)}
                      style={{
                        padding: '5px 14px', borderRadius: 20, fontSize: 13, fontWeight: 500,
                        border: `0.5px solid ${checked ? 'var(--text)' : 'var(--border)'}`,
                        background: checked ? 'var(--text)' : 'transparent',
                        color: checked ? '#fff' : 'var(--text-2)',
                        cursor: canEdit ? 'pointer' : 'default',
                        transition: 'all .15s',
                      }}
                    >{tag.name}</button>
                  )
                })}
              </div>
            </div>
          )}
        </>
      )}

      {canDelete && (
        <button className="btn btn-danger" onClick={deleteProduct} style={{marginTop:8}}>刪除商品</button>
      )}
    </Sheet>
  )
}

function SourceField({ productId, initialSource, canEdit, onSaved, existingSources = [] }) {
  const [source, setSource] = useState(initialSource || '')
  const [customMode, setCustomMode] = useState(false)
  const [saved, setSaved] = useState(false)
  const isKnown = existingSources.includes(source)

  async function save(val) {
    const trimmed = (val ?? source).trim()
    await supabase.from('products').update({ source: trimmed || null }).eq('id', productId)
    setSaved(true)
    if (onSaved) onSaved()
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span className="fs12 muted">採購來源</span>
        {saved && <span className="fs12" style={{ color: 'var(--green)' }}>✓</span>}
      </div>
      {canEdit ? (
        <>
          {existingSources.length > 0 && !customMode ? (
            <CustomSelect
              label="— 未設定 —"
              value={isKnown ? source : null}
              options={[
                ...existingSources.map(s => ({ value: s, label: s })),
                ...(!isKnown && source ? [{ value: '__current__', label: source }] : []),
                { value: '__custom__', label: '＋ 自訂來源' },
              ]}
              onChange={v => {
                if (v === '__custom__') { setCustomMode(true) }
                else { setSource(v || ''); save(v || '') }
              }}
              compact
            />
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="form-input"
                value={source}
                onChange={e => setSource(e.target.value)}
                onBlur={() => save()}
                onKeyDown={e => e.key === 'Enter' && save()}
                placeholder="例：UNIQLO"
                style={{ flex: 1 }}
              />
              {existingSources.length > 0 && (
                <button type="button" className="btn btn-outline" style={{ width: 'auto', padding: '0 14px', fontSize: 13 }}
                  onClick={() => setCustomMode(false)}>選擇</button>
              )}
            </div>
          )}
        </>
      ) : (
        <div style={{ padding: '8px 12px', background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 10 }}>
          <span className="fs14 fw600" style={{ color: source ? 'var(--text)' : 'var(--text-3)' }}>{source || '未設定'}</span>
        </div>
      )}
    </div>
  )
}

// ── Shared Sheet wrapper ───────────────────────────
function Sheet({ title, onClose, children }) {
  return (
    <div className="sheet-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <div className="sheet-handle" />
        <div className="row-sb" style={{marginBottom:20}}>
          <div className="sheet-title" style={{margin:0}}>{title}</div>
          <button onClick={onClose} style={{background:'none',border:'none',fontSize:22,cursor:'pointer',color:'var(--text-3)'}}>×</button>
        </div>
        {children}
      </div>
    </div>
  )
}
