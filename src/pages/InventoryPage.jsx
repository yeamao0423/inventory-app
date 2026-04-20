import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import CustomSelect from '../components/CustomSelect'
import { compressImage, uploadImages } from '../lib/imageUtils'
import QuickListSheet from '../components/QuickListSheet'

const LOW = 10

export default function InventoryPage() {
  const { profile, signOut, can } = useAuth()
  const [products, setProducts] = useState([])
  const [search, setSearch] = useState('')
  const [filterSource, setFilterSource] = useState('')
  const [sheet, setSheet] = useState(null)   // null | 'add' | product obj
  const [quickList, setQuickList] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => { fetchProducts() }, [])

  async function fetchProducts() {
    const { data } = await supabase
      .from('products')
      .select('*, product_images(id, url, sort_order), categories(id, name), product_tags(tag_id)')
      .order('name')
    setProducts(data || [])
    setLoading(false)
  }

  const filtered = products.filter(p => {
    const matchSearch = p.name.toLowerCase().includes(search.toLowerCase()) ||
      (p.sku && p.sku.toLowerCase().includes(search.toLowerCase()))
    const matchSource = !filterSource || (p.source || '') === filterSource
    return matchSearch && matchSource
  })
  const low = filtered.filter(p => p.quantity <= LOW)
  const normal = filtered.filter(p => p.quantity > LOW)
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
          <div className="stat-val text-red">{products.filter(p => p.quantity <= LOW).length}</div>
          <div className="stat-lbl"><span className="dot" style={{background:'var(--red)'}} />低庫存</div>
        </div>
      </div>

      <div className="search">
        <span style={{fontSize:16}}>🔍</span>
        <input
          placeholder="搜尋商品名稱或 SKU…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {existingSources.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <CustomSelect compact
            label="全部來源"
            value={filterSource || null}
            options={existingSources.map(s => ({ value: s, label: s }))}
            onChange={v => setFilterSource(v || '')}
          />
        </div>
      )}

      {loading && <div className="empty">載入中…</div>}

      {low.length > 0 && (
        <>
          <div className="sec">⚠ 低庫存警示</div>
          {low.map(p => <ProductRow key={p.id} product={p} onTap={() => setSheet(p)} low />)}
        </>
      )}

      {normal.length > 0 && (
        <>
          <div className="sec">所有商品</div>
          {normal.map(p => <ProductRow key={p.id} product={p} onTap={() => setSheet(p)} />)}
        </>
      )}

      {filtered.length === 0 && !loading && (
        <div className="empty">找不到符合的商品</div>
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

function ProductRow({ product: p, onTap, low }) {
  const thumb = p.product_images?.sort((a, b) => a.sort_order - b.sort_order)[0]?.url
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
          <div className="muted fs12 mt8">{[p.sku, `${p.cost} ${p.currency}`].filter(Boolean).join(' · ')}</div>
        </div>
        <div style={{textAlign:'right',flexShrink:0}}>
          <div className="fw600 fs15" style={{color: low ? 'var(--red)' : 'var(--text)'}}>{p.quantity}</div>
          <div className="fs12 mt8">
            <span className={`badge ${low ? 'badge-low' : 'badge-ok'}`}>{low ? '低庫存' : '正常'}</span>
          </div>
        </div>
      </div>
    </div>
  )
}


// ── 新增商品 ────────────────────────────────────────────
function AddProductSheet({ onClose, onSaved, existingSources = [] }) {
  const [form, setForm] = useState({ name:'', sku:'', quantity:'', unit:'個', cost:'', currency:'TWD', source:'' })
  const [saving, setSaving] = useState(false)
  const [imageFiles, setImageFiles] = useState([])
  const [previews, setPreviews] = useState([])
  const [categories, setCategories] = useState([])
  const [selectedCategory, setSelectedCategory] = useState('')
  const set = (k, v) => setForm(f => ({...f, [k]: v}))

  useEffect(() => {
    supabase.from('categories').select('*').order('sort_order')
      .then(({ data }) => setCategories(data || []))
  }, [])

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
            options={['TWD','USD','JPY','EUR','VND'].map(c => ({ value: c, label: c }))}
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

// ── 商品詳情 ────────────────────────────────────────────
function ProductDetailSheet({ product, onClose, onSaved, canEdit, canDelete, existingSources = [] }) {
  const [saving, setSaving] = useState(false)
  const [productName, setProductName] = useState(product.name)
  const [images, setImages] = useState(
    [...(product.product_images || [])].sort((a, b) => a.sort_order - b.sort_order)
  )
  const [uploading, setUploading] = useState(false)
  const [categories, setCategories] = useState([])
  const [allTags, setAllTags] = useState([])
  const [selectedCategory, setSelectedCategory] = useState(product.category_id || '')
  const [selectedTags, setSelectedTags] = useState(
    (product.product_tags || []).map(pt => pt.tag_id)
  )

  useEffect(() => {
    Promise.all([
      supabase.from('categories').select('*').order('sort_order'),
      supabase.from('tags').select('*').order('sort_order'),
    ]).then(([{ data: cats }, { data: tgs }]) => {
      setCategories(cats || [])
      setAllTags(tgs || [])
    })
  }, [product.sku])

  async function saveCategory(catId) {
    await supabase.from('products')
      .update({ category_id: catId ? Number(catId) : null })
      .eq('id', product.id)
    setSelectedCategory(catId)
  }

  async function toggleTag(tagId, checked) {
    if (checked) {
      await supabase.from('product_tags').insert({ product_id: product.id, tag_id: tagId })
      setSelectedTags(prev => [...prev, tagId])
    } else {
      await supabase.from('product_tags').delete().eq('product_id', product.id).eq('tag_id', tagId)
      setSelectedTags(prev => prev.filter(id => id !== tagId))
    }
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
                {canEdit && (
                  <button
                    onClick={() => deleteImage(img.id, idx)}
                    style={{position:'absolute',top:-6,right:-6,width:20,height:20,borderRadius:'50%',background:'var(--red)',color:'#fff',border:'none',cursor:'pointer',fontSize:12,lineHeight:'20px',textAlign:'center',padding:0}}
                  >×</button>
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

      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:12,marginTop:12}}>
        <EditableField
          productId={product.id} field="cost" initialValue={product.cost}
          canEdit={canEdit} onSaved={onSaved}
          label="成本" placeholder="0" type="number"
        />
        <EditableSelectField
          productId={product.id} field="currency" initialValue={product.currency || 'TWD'}
          canEdit={canEdit} onSaved={onSaved}
          label="幣別" options={['TWD','USD','JPY','EUR','VND']}
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
