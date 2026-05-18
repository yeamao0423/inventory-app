import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { uploadImages } from '../lib/imageUtils'
import CustomSelect from './CustomSelect'

const STEPS = ['拍照', '基本資訊', '販售設定', '確認上架']

export default function QuickListSheet({ onClose, onSaved, existingSources = [] }) {
  const [step, setStep] = useState(0)
  const [saving, setSaving] = useState(false)

  // Step 0: Images
  const [imageFiles, setImageFiles] = useState([])
  const [previews, setPreviews] = useState([])

  // Step 1: Basic info
  const [name, setName] = useState('')
  const [source, setSource] = useState('')
  const [sourceSelectMode, setSourceSelectMode] = useState(false)
  const [cost, setCost] = useState('')
  const [currency, setCurrency] = useState('TWD')
  const [shopPrice, setShopPrice] = useState('')

  // Step 2: Selling settings
  const [sellingMode, setSellingMode] = useState('stock') // stock | collection
  const [skipStockCheck, setSkipStockCheck] = useState(false)
  const [quantity, setQuantity] = useState('')
  const [collectionEnd, setCollectionEnd] = useState('')
  const [descZh, setDescZh] = useState('')
  const [categories, setCategories] = useState([])
  const [allTags, setAllTags] = useState([])
  const [selectedCategory, setSelectedCategory] = useState('')
  const [selectedTags, setSelectedTags] = useState([])
  const [published, setPublished] = useState(true)
  const [showOptional, setShowOptional] = useState(false)

  // Step 2: Variants
  const [optionTypes, setOptionTypes] = useState([])
  const [hasVariants, setHasVariants] = useState(false)
  const [selectedTypes, setSelectedTypes] = useState({})
  const [selectedValues, setSelectedValues] = useState({})
  const [localVariants, setLocalVariants] = useState([])
  const [batchStock, setBatchStock] = useState('')
  const [batchPrice, setBatchPrice] = useState('')

  useEffect(() => {
    Promise.all([
      supabase.from('categories').select('*').order('sort_order'),
      supabase.from('tags').select('*').order('sort_order'),
      supabase.from('variant_option_types')
        .select('*, variant_option_values(id, value, sort_order)')
        .order('sort_order').order('name'),
    ]).then(([{ data: cats }, { data: tgs }, { data: opts }]) => {
      setCategories(cats || [])
      setAllTags(tgs || [])
      setOptionTypes(opts || [])
    })
  }, [])

  function onImagesChange(e) {
    const files = Array.from(e.target.files)
    if (!files.length) return
    setImageFiles(prev => [...prev, ...files])
    setPreviews(prev => [...prev, ...files.map(f => URL.createObjectURL(f))])
    e.target.value = ''
  }

  function removePreview(idx) {
    setImageFiles(prev => prev.filter((_, i) => i !== idx))
    setPreviews(prev => prev.filter((_, i) => i !== idx))
  }

  // --- Variant helpers ---
  function toggleType(typeId) {
    const tid = String(typeId)
    setSelectedTypes(prev => {
      const next = { ...prev }
      if (next[tid]) {
        delete next[tid]
        setSelectedValues(prev2 => { const n = { ...prev2 }; delete n[tid]; return n })
      } else {
        next[tid] = true
      }
      return next
    })
    setLocalVariants([])
  }

  function toggleValue(typeId, valueId) {
    const tid = String(typeId)
    setSelectedValues(prev => {
      const next = { ...prev }
      if (!next[tid]) next[tid] = new Set()
      else next[tid] = new Set(next[tid])
      if (next[tid].has(valueId)) next[tid].delete(valueId)
      else next[tid].add(valueId)
      return next
    })
    setLocalVariants([])
  }

  function cartesian(arrays) {
    if (arrays.length === 0) return [[]]
    return arrays.reduce((acc, arr) =>
      acc.flatMap(combo => arr.map(item => [...combo, item])),
    [[]])
  }

  function generateCombinations() {
    const activeTypeIds = Object.keys(selectedTypes).filter(tid => selectedTypes[tid] && selectedValues[tid]?.size > 0)
    if (activeTypeIds.length === 0) return
    const axes = activeTypeIds.map(tid =>
      [...selectedValues[tid]].map(vid => ({ tid, vid }))
    )
    const combos = cartesian(axes)
    setLocalVariants(combos.map(combo => {
      const options = {}
      combo.forEach(({ tid, vid }) => { options[tid] = vid })
      return { options, stock: 0, variant_price: null }
    }))
  }

  function updateLocalVariant(idx, field, value) {
    setLocalVariants(prev => prev.map((v, i) => {
      if (i !== idx) return v
      if (field === 'stock') return { ...v, stock: value === '' ? 0 : Number(value) }
      return { ...v, variant_price: value === '' ? null : Number(value) }
    }))
  }

  function removeLocalVariant(idx) {
    setLocalVariants(prev => prev.filter((_, i) => i !== idx))
  }

  function applyBatch(field) {
    const val = field === 'stock' ? batchStock : batchPrice
    if (val === '') return
    setLocalVariants(prev => prev.map(v => ({
      ...v,
      [field]: field === 'stock' ? Number(val) : Number(val),
    })))
    if (field === 'stock') setBatchStock('')
    else setBatchPrice('')
  }

  function resolveVariantLabel(options) {
    if (!options || Object.keys(options).length === 0) return '無規格'
    return Object.entries(options).map(([typeId, valueId]) => {
      const type = optionTypes.find(t => t.id === Number(typeId))
      const val = type?.variant_option_values?.find(v => v.id === valueId)
      return val ? `${type.name}: ${val.value}` : ''
    }).filter(Boolean).join(' / ')
  }

  const activeTypeIds = Object.keys(selectedTypes).filter(tid => selectedTypes[tid] && selectedValues[tid]?.size > 0)
  const totalCombos = activeTypeIds.length > 0
    ? activeTypeIds.reduce((acc, tid) => acc * (selectedValues[tid]?.size || 1), 1)
    : 0

  // --- Validation ---
  function canNext() {
    if (step === 0) return imageFiles.length > 0
    if (step === 1) return name.trim() && shopPrice
    if (step === 2) {
      if (sellingMode === 'collection' && !collectionEnd) return false
      if (!skipStockCheck) {
        if (hasVariants && localVariants.length > 0) {
          return localVariants.some(v => v.stock > 0)
        }
        if (!hasVariants && (!quantity || Number(quantity) <= 0)) return false
      }
      return true
    }
    return true
  }

  async function submit() {
    setSaving(true)
    try {
      // 1. Create product
      const baseQty = hasVariants && localVariants.length > 0
        ? localVariants.reduce((sum, v) => sum + (v.stock || 0), 0)
        : sellingMode === 'stock' ? (Number(quantity) || 0) : 0

      const { data: inserted, error: prodErr } = await supabase.from('products').insert({
        name: name.trim(),
        quantity: baseQty,
        unit: '個',
        cost: cost ? Number(cost) : 0,
        currency,
        category_id: selectedCategory ? Number(selectedCategory) : null,
        source: source.trim() || null,
      }).select('id').single()

      if (prodErr || !inserted) {
        alert('建立商品失敗：' + (prodErr?.message || '未知錯誤'))
        setSaving(false)
        return
      }

      const productId = inserted.id

      // 2. Upload images
      if (imageFiles.length > 0) {
        await uploadImages(imageFiles, productId)
      }

      // 3. History record
      if (baseQty > 0) {
        await supabase.from('history').insert({
          product_id: productId,
          change: baseQty,
          reason: '初始建立',
        })
      }

      // 4. Tags
      if (selectedTags.length > 0) {
        await supabase.from('product_tags').insert(
          selectedTags.map(tagId => ({ product_id: productId, tag_id: tagId }))
        )
      }

      // 5. Variants
      if (hasVariants && localVariants.length > 0) {
        await supabase.from('product_variants').insert(
          localVariants.map(v => ({
            product_id: productId,
            options: v.options,
            stock: v.stock || 0,
            variant_price: v.variant_price,
          }))
        )
      }

      // 6. Storefront listing
      const { error: sfErr } = await supabase.from('storefront_products').insert({
        product_id: productId,
        shop_price: Number(shopPrice),
        desc_zh: descZh.trim() || null,
        published,
        collection_end: sellingMode === 'collection' ? new Date(collectionEnd).toISOString() : null,
        sold_out: false,
        skip_stock_check: skipStockCheck,
      })

      if (sfErr) {
        alert('商城上架失敗：' + sfErr.message)
        setSaving(false)
        return
      }

      onSaved()
      onClose()
    } catch (err) {
      alert('發生錯誤：' + err.message)
      setSaving(false)
    }
  }

  return (
    <div className="sheet-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <div className="sheet-handle" />

        {/* Header */}
        <div className="row-sb" style={{ marginBottom: 16 }}>
          <div className="sheet-title" style={{ margin: 0 }}>快速上架</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-3)' }}>×</button>
        </div>

        {/* Step indicator */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
          {STEPS.map((label, i) => (
            <div key={i} style={{ flex: 1, textAlign: 'center' }}>
              <div style={{
                height: 3, borderRadius: 2, marginBottom: 6,
                background: i <= step ? 'var(--text)' : 'var(--border)',
                transition: 'background .2s',
              }} />
              <span style={{
                fontSize: 11, fontWeight: i === step ? 600 : 400,
                color: i <= step ? 'var(--text)' : 'var(--text-3)',
              }}>{label}</span>
            </div>
          ))}
        </div>

        {/* Step 0: Photos */}
        {step === 0 && (
          <div>
            <div className="muted fs13" style={{ marginBottom: 12 }}>拍攝或選擇商品照片（至少 1 張）</div>
            {previews.length > 0 && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                {previews.map((src, i) => (
                  <div key={i} style={{ position: 'relative' }}>
                    <img src={src} style={{ width: 80, height: 80, objectFit: 'cover', borderRadius: 10, display: 'block' }} />
                    <button
                      onClick={() => removePreview(i)}
                      style={{ position: 'absolute', top: -6, right: -6, width: 22, height: 22, borderRadius: '50%', background: 'var(--red)', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 13, lineHeight: '22px', textAlign: 'center', padding: 0 }}
                    >×</button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <label style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                padding: '28px 16px', border: '1.5px dashed var(--border)', borderRadius: 12,
                cursor: 'pointer', fontSize: 14, color: 'var(--text-3)', background: 'var(--surface)',
              }}>
                📷 拍照
                <input type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={onImagesChange} />
              </label>
              <label style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                padding: '28px 16px', border: '1.5px dashed var(--border)', borderRadius: 12,
                cursor: 'pointer', fontSize: 14, color: 'var(--text-3)', background: 'var(--surface)',
              }}>
                🖼️ 從相簿選擇
                <input type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={onImagesChange} />
              </label>
            </div>
          </div>
        )}

        {/* Step 1: Basic info */}
        {step === 1 && (
          <div>
            <div className="form-group">
              <label className="form-label">商品名稱 *</label>
              <input className="form-input" placeholder="例：防水噴霧 500ml" value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">採購來源</label>
              {sourceSelectMode ? (
                <CustomSelect
                  label="— 選擇來源 —"
                  value={source || null}
                  options={[
                    ...existingSources.map(s => ({ value: s, label: s })),
                    { value: '__custom__', label: '＋ 自訂來源' },
                  ]}
                  onChange={v => {
                    if (v === '__custom__') { setSourceSelectMode(false); setSource('') }
                    else { setSource(v || ''); setSourceSelectMode(false) }
                  }}
                  allowClear={false}
                />
              ) : (
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="form-input" style={{ flex: 1 }} placeholder="例：UNIQLO、GU" value={source} onChange={e => setSource(e.target.value)} />
                  {existingSources.length > 0 && (
                    <button type="button" className="btn btn-outline" style={{ width: 'auto', padding: '0 14px', fontSize: 13 }}
                      onClick={() => setSourceSelectMode(true)}>選擇</button>
                  )}
                </div>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div className="form-group">
                <label className="form-label">進貨成本</label>
                <input className="form-input" type="number" placeholder="0" value={cost} onChange={e => setCost(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">幣別</label>
                <CustomSelect
                  label="TWD"
                  value={currency}
                  options={['TWD', 'USD', 'JPY', 'EUR', 'VND'].map(c => ({ value: c, label: c }))}
                  onChange={v => setCurrency(v || 'TWD')}
                  allowClear={false}
                />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">商城售價（NT$） *</label>
              <input className="form-input" type="number" placeholder="0" value={shopPrice} onChange={e => setShopPrice(e.target.value)} />
            </div>
          </div>
        )}

        {/* Step 2: Selling settings */}
        {step === 2 && (
          <div>
            {/* Selling mode */}
            <div className="form-label" style={{ marginBottom: 8 }}>販售模式 *</div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <button
                onClick={() => { setSellingMode('stock'); setSkipStockCheck(false) }}
                style={{
                  flex: 1, padding: '14px 8px', borderRadius: 12, fontSize: 14, fontWeight: 600,
                  cursor: 'pointer', transition: 'all .15s', textAlign: 'center',
                  background: sellingMode === 'stock' ? 'var(--text)' : 'var(--surface)',
                  color: sellingMode === 'stock' ? '#fff' : 'var(--text-3)',
                  border: `0.5px solid ${sellingMode === 'stock' ? 'var(--text)' : 'var(--border)'}`,
                }}
              >
                📦 現貨單
                <div style={{ fontSize: 11, fontWeight: 400, marginTop: 2, opacity: 0.8 }}>有庫存，直接銷售</div>
              </button>
              <button
                onClick={() => {
                  setSellingMode('collection')
                  setSkipStockCheck(true)
                  if (!collectionEnd) {
                    const d = new Date(); d.setDate(d.getDate() + 7)
                    const pad = n => String(n).padStart(2, '0')
                    setCollectionEnd(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`)
                  }
                }}
                style={{
                  flex: 1, padding: '14px 8px', borderRadius: 12, fontSize: 14, fontWeight: 600,
                  cursor: 'pointer', transition: 'all .15s', textAlign: 'center',
                  background: sellingMode === 'collection' ? 'var(--text)' : 'var(--surface)',
                  color: sellingMode === 'collection' ? '#fff' : 'var(--text-3)',
                  border: `0.5px solid ${sellingMode === 'collection' ? 'var(--text)' : 'var(--border)'}`,
                }}
              >
                🛒 限時單
                <div style={{ fontSize: 11, fontWeight: 400, marginTop: 2, opacity: 0.8 }}>限時收單，截止後叫貨</div>
              </button>
            </div>

            {sellingMode === 'stock' && !hasVariants && (
              <div className="form-group">
                <label className="form-label">庫存數量 *</label>
                <input className="form-input" type="number" placeholder="0" value={quantity} onChange={e => setQuantity(e.target.value)} style={{ width: 140 }} />
              </div>
            )}

            {sellingMode === 'collection' && (
              <>
                <div className="form-group">
                  <label className="form-label">結單時間 *</label>
                  <input className="form-input" type="datetime-local" value={collectionEnd} onChange={e => setCollectionEnd(e.target.value)} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <label className="form-label fs13" style={{ margin: 0 }}>跳過庫存檢查</label>
                  <div
                    onClick={() => setSkipStockCheck(v => !v)}
                    style={{
                      width: 44, height: 26, borderRadius: 13, cursor: 'pointer', transition: 'background .2s',
                      background: skipStockCheck ? 'var(--blue, #3b82f6)' : 'var(--border)',
                      position: 'relative',
                    }}
                  >
                    <div style={{
                      width: 20, height: 20, borderRadius: '50%', background: '#fff',
                      position: 'absolute', top: 3, transition: 'left .2s',
                      left: skipStockCheck ? 21 : 3,
                    }} />
                  </div>
                  <span className="muted fs12">{skipStockCheck ? '不檢查庫存，可無限下單' : '需有庫存才能下單'}</span>
                </div>
                {!skipStockCheck && !hasVariants && (
                  <div className="form-group">
                    <label className="form-label">庫存數量 *</label>
                    <input className="form-input" type="number" placeholder="0" value={quantity} onChange={e => setQuantity(e.target.value)} style={{ width: 140 }} />
                  </div>
                )}
              </>
            )}

            {/* Variant section */}
            {optionTypes.length > 0 && (
              <>
                <div
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '12px 0', borderTop: '0.5px solid var(--border)', marginTop: 8,
                  }}
                >
                  <span className="fs13 fw600" style={{ color: 'var(--text-2)' }}>商品規格</span>
                  <div
                    onClick={() => {
                      setHasVariants(v => !v)
                      if (hasVariants) {
                        setSelectedTypes({})
                        setSelectedValues({})
                        setLocalVariants([])
                      }
                    }}
                    style={{
                      width: 44, height: 26, borderRadius: 13, cursor: 'pointer', transition: 'background .2s',
                      background: hasVariants ? 'var(--green)' : 'var(--border)',
                      position: 'relative',
                    }}
                  >
                    <div style={{
                      width: 20, height: 20, borderRadius: '50%', background: '#fff',
                      position: 'absolute', top: 3, transition: 'left .2s',
                      left: hasVariants ? 21 : 3,
                    }} />
                  </div>
                </div>

                {hasVariants && (
                  <div style={{ paddingTop: 4 }}>
                    {/* Select types & values */}
                    <div style={{ background: 'var(--surface)', borderRadius: 12, padding: 14, marginBottom: 12, border: '0.5px solid var(--border)' }}>
                      <div className="muted fs12 fw600" style={{ marginBottom: 10 }}>1. 選擇規格</div>
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
                              <span className="fw600" style={{ fontSize: 14 }}>{type.name}</span>
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
                          style={{ fontSize: 13, padding: '10px 0', marginTop: 4 }}
                        >
                          產生組合（共 {totalCombos} 種）
                        </button>
                      )}
                    </div>

                    {/* Variant matrix */}
                    {localVariants.length > 0 && (
                      <div style={{ background: 'var(--surface)', borderRadius: 12, padding: 14, border: '0.5px solid var(--border)' }}>
                        <div className="muted fs12 fw600" style={{ marginBottom: 10 }}>
                          2. 編輯規格（{localVariants.length} 種）
                        </div>

                        {/* Batch controls */}
                        {!skipStockCheck && (
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
                              <button onClick={() => applyBatch('stock')} style={{ padding: '4px 10px', borderRadius: 6, border: '0.5px solid var(--border)', background: 'var(--bg)', fontSize: 11, cursor: 'pointer' }}>套用</button>
                            </div>
                            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                              <span className="muted fs12">批次售價:</span>
                              <input
                                type="number"
                                value={batchPrice}
                                onChange={e => setBatchPrice(e.target.value)}
                                placeholder={String(shopPrice || 0)}
                                style={{ width: 80, padding: '4px 8px', borderRadius: 6, border: '0.5px solid var(--border)', fontSize: 13, textAlign: 'center' }}
                              />
                              <button onClick={() => applyBatch('variant_price')} style={{ padding: '4px 10px', borderRadius: 6, border: '0.5px solid var(--border)', background: 'var(--bg)', fontSize: 11, cursor: 'pointer' }}>套用</button>
                            </div>
                          </div>
                        )}

                        {/* Table */}
                        <div style={{ overflowX: 'auto' }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                            <thead>
                              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                                <th style={{ padding: '8px 6px', textAlign: 'left', fontSize: 12, color: 'var(--text-3)', fontWeight: 600 }}>規格</th>
                                {!skipStockCheck && (
                                  <th style={{ padding: '8px 6px', width: 70, textAlign: 'center', fontSize: 12, color: 'var(--text-3)', fontWeight: 600 }}>庫存</th>
                                )}
                                <th style={{ padding: '8px 6px', width: 90, textAlign: 'center', fontSize: 12, color: 'var(--text-3)', fontWeight: 600 }}>售價(NT$)</th>
                                <th style={{ padding: '8px 6px', width: 36 }}></th>
                              </tr>
                            </thead>
                            <tbody>
                              {localVariants.map((v, idx) => (
                                <tr key={idx} style={{ borderBottom: '1px solid var(--border-light)' }}>
                                  <td style={{ padding: '8px 6px' }}>
                                    <span className="fw600">{resolveVariantLabel(v.options)}</span>
                                  </td>
                                  {!skipStockCheck && (
                                    <td style={{ padding: '8px 6px', textAlign: 'center' }}>
                                      <input
                                        type="number"
                                        value={v.stock || ''}
                                        onChange={e => updateLocalVariant(idx, 'stock', e.target.value)}
                                        placeholder="0"
                                        style={{ width: '100%', padding: '5px 8px', borderRadius: 6, border: '0.5px solid var(--border)', fontSize: 13, textAlign: 'center', background: 'var(--bg)' }}
                                      />
                                    </td>
                                  )}
                                  <td style={{ padding: '8px 6px', textAlign: 'center' }}>
                                    <input
                                      type="number"
                                      value={v.variant_price ?? ''}
                                      onChange={e => updateLocalVariant(idx, 'variant_price', e.target.value)}
                                      placeholder={String(shopPrice || 0)}
                                      style={{ width: '100%', padding: '5px 8px', borderRadius: 6, border: '0.5px solid var(--border)', fontSize: 13, textAlign: 'center', background: 'var(--bg)' }}
                                    />
                                  </td>
                                  <td style={{ padding: '8px 6px', textAlign: 'center' }}>
                                    <button
                                      onClick={() => removeLocalVariant(idx)}
                                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', fontSize: 15, padding: 0 }}
                                    >×</button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <div className="muted fs12" style={{ marginTop: 8 }}>
                          售價留空 = 使用商城售價 NT${Number(shopPrice || 0).toLocaleString()}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {/* Optional fields toggle */}
            <div
              onClick={() => setShowOptional(v => !v)}
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '12px 0', cursor: 'pointer', borderTop: '0.5px solid var(--border)', marginTop: 8,
              }}
            >
              <span className="fs13 fw600" style={{ color: 'var(--text-2)' }}>其他可選資訊</span>
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{showOptional ? '收起 ▲' : '展開 ▼'}</span>
            </div>

            {showOptional && (
              <div style={{ paddingTop: 4 }}>
                <div className="form-group">
                  <label className="form-label">中文描述</label>
                  <input className="form-input" placeholder="商品說明" value={descZh} onChange={e => setDescZh(e.target.value)} />
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
                {allTags.length > 0 && (
                  <div className="form-group">
                    <label className="form-label">標籤</label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {allTags.map(tag => {
                        const checked = selectedTags.includes(tag.id)
                        return (
                          <button
                            key={tag.id}
                            onClick={() => setSelectedTags(prev => checked ? prev.filter(id => id !== tag.id) : [...prev, tag.id])}
                            style={{
                              padding: '5px 14px', borderRadius: 20, fontSize: 13, fontWeight: 500,
                              border: `0.5px solid ${checked ? 'var(--text)' : 'var(--border)'}`,
                              background: checked ? 'var(--text)' : 'transparent',
                              color: checked ? '#fff' : 'var(--text-2)',
                              cursor: 'pointer', transition: 'all .15s',
                            }}
                          >{tag.name}</button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Publish toggle */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, paddingTop: 12, borderTop: '0.5px solid var(--border)' }}>
              <label className="form-label fs13" style={{ margin: 0 }}>立即上架</label>
              <div
                onClick={() => setPublished(v => !v)}
                style={{
                  width: 44, height: 26, borderRadius: 13, cursor: 'pointer', transition: 'background .2s',
                  background: published ? 'var(--green)' : 'var(--border)',
                  position: 'relative',
                }}
              >
                <div style={{
                  width: 20, height: 20, borderRadius: '50%', background: '#fff',
                  position: 'absolute', top: 3, transition: 'left .2s',
                  left: published ? 21 : 3,
                }} />
              </div>
              <span className="fs12 muted">{published ? '上架後立即顯示在商城' : '先建立，稍後手動上架'}</span>
            </div>
          </div>
        )}

        {/* Step 3: Confirm */}
        {step === 3 && (
          <div>
            <div className="muted fs13" style={{ marginBottom: 16 }}>請確認以下資訊，按下「確認上架」即完成</div>

            {/* Image preview */}
            {previews.length > 0 && (
              <div style={{ display: 'flex', gap: 6, marginBottom: 16, overflowX: 'auto' }}>
                {previews.map((src, i) => (
                  <img key={i} src={src} style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8, flexShrink: 0 }} />
                ))}
              </div>
            )}

            <ConfirmRow label="商品名稱" value={name} />
            <ConfirmRow label="採購來源" value={source || '未設定'} muted={!source} />
            <ConfirmRow label="進貨成本" value={cost ? `${cost} ${currency}` : '未設定'} muted={!cost} />
            <ConfirmRow label="商城售價" value={`NT$ ${Number(shopPrice).toLocaleString()}`} />
            <ConfirmRow label="販售模式" value={
              sellingMode === 'stock'
                ? hasVariants && localVariants.length > 0
                  ? `現貨（${localVariants.length} 種規格）`
                  : `現貨（庫存 ${quantity}）`
                : `限時單（截止 ${formatDateTime(collectionEnd)}）`
            } />
            {sellingMode === 'collection' && (
              <ConfirmRow label="庫存檢查" value={skipStockCheck ? '跳過（不檢查庫存）' : '啟用'} />
            )}

            {/* Variant summary in confirm */}
            {hasVariants && localVariants.length > 0 && (
              <div style={{ margin: '12px 0', background: 'var(--surface)', borderRadius: 10, border: '0.5px solid var(--border)', overflow: 'hidden' }}>
                <div style={{ padding: '8px 12px', borderBottom: '0.5px solid var(--border)', background: 'var(--bg)' }}>
                  <span className="fs12 fw600 muted">規格明細</span>
                </div>
                {localVariants.map((v, idx) => (
                  <div key={idx} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '8px 12px', borderBottom: idx < localVariants.length - 1 ? '0.5px solid var(--border-light)' : 'none',
                  }}>
                    <span className="fs13">{resolveVariantLabel(v.options)}</span>
                    <span className="fs12 muted">
                      {!skipStockCheck && `庫存 ${v.stock}`}
                      {!skipStockCheck && v.variant_price != null && ' · '}
                      {v.variant_price != null ? `NT$${v.variant_price.toLocaleString()}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {descZh && <ConfirmRow label="描述" value={descZh} />}
            {selectedCategory && <ConfirmRow label="分類" value={categories.find(c => String(c.id) === selectedCategory)?.name || ''} />}
            {selectedTags.length > 0 && <ConfirmRow label="標籤" value={allTags.filter(t => selectedTags.includes(t.id)).map(t => t.name).join('、')} />}
            <ConfirmRow label="上架狀態" value={published ? '立即上架' : '暫不上架'} highlight={published} />
          </div>
        )}

        {/* Navigation buttons */}
        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          {step > 0 && (
            <button
              className="btn btn-outline"
              onClick={() => setStep(s => s - 1)}
              style={{ flex: 1 }}
            >上一步</button>
          )}
          {step < 3 ? (
            <button
              className="btn"
              onClick={() => setStep(s => s + 1)}
              disabled={!canNext()}
              style={{ flex: 1, opacity: canNext() ? 1 : 0.4 }}
            >下一步</button>
          ) : (
            <button
              className="btn"
              onClick={submit}
              disabled={saving}
              style={{ flex: 1 }}
            >{saving ? '上架中…' : '確認上架'}</button>
          )}
        </div>
      </div>
    </div>
  )
}

function ConfirmRow({ label, value, muted, highlight }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '10px 0', borderBottom: '0.5px solid var(--border-light)',
    }}>
      <span className="fs13 muted">{label}</span>
      <span className="fs13 fw600" style={{
        color: muted ? 'var(--text-3)' : highlight ? 'var(--green)' : 'var(--text)',
        maxWidth: '60%', textAlign: 'right',
      }}>{value}</span>
    </div>
  )
}

function formatDateTime(str) {
  if (!str) return ''
  const d = new Date(str)
  return d.toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
