import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { SUPPORTED_CURRENCIES } from '../constants/currency'
import { useAuth } from '../hooks/useAuth'
import { uploadImages, compressImage, reencodeImage } from '../lib/imageUtils'
import CustomSelect from './CustomSelect'

const STEPS = ['拍照', '商品資料', '確認上架']

// Claude API 支援的圖片格式；不在清單內（如 HEIC）就要先轉檔
const AI_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const [head, data] = reader.result.split(',')
      resolve({ data, media_type: head.match(/data:(.*?);/)?.[1] || file.type })
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// 照片 → 送 AI 的 base64。
// 一般照片走既有壓縮（1200px）；「僅供辨識」照片保留高解析（小字價標讀得清），
// 僅在格式不支援或超過 API 上限（5MB）時轉檔。
// 「零食、日本、團購」→ ['零食','日本','團購']（頓號/逗號分隔、去重）
function parseTagNames(str) {
  return [...new Set(str.split(/[、,，]+/).map(s => s.trim()).filter(Boolean))]
}

async function toAiImage(file, fullRes) {
  let f = file
  if (fullRes) {
    if (!AI_MEDIA_TYPES.includes(f.type) || f.size > 4 * 1024 * 1024) {
      f = await reencodeImage(f, 2016, 0.9)
    }
  } else {
    f = await compressImage(f)
    if (!AI_MEDIA_TYPES.includes(f.type)) f = await reencodeImage(f, 1200, 0.75)
  }
  return fileToBase64(f)
}

export default function QuickListSheet({ onClose, onSaved, existingSources = [] }) {
  const { storeId } = useAuth()
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
  const [onSale, setOnSale] = useState(false)
  const [salePrice, setSalePrice] = useState('')
  const [saleStart, setSaleStart] = useState('')
  const [saleEnd, setSaleEnd] = useState('')

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
  const [batchSale, setBatchSale] = useState('')
  const [batchCost, setBatchCost] = useState('')
  const [recentEnds, setRecentEnds] = useState([])

  // AI 補齊
  const [aiSelected, setAiSelected] = useState([0])   // 要送 AI 的照片 index（最多 3 張）
  const [aiOnly, setAiOnly] = useState([])            // 「僅供辨識，不上架」的照片 index
  const [aiLoading, setAiLoading] = useState(false)
  const [aiResult, setAiResult] = useState(null)      // 消毒後的 AI 建議（原始值）
  const [aiDraft, setAiDraft] = useState(null)        // 建議的可編輯草稿：店家可先改再套用/建立
  const [aiLogId, setAiLogId] = useState(null)        // 最後一次 AI 呼叫的 log id，寫入 products.ai_log_id

  useEffect(() => {
    if (!storeId) return
    Promise.all([
      supabase.from('categories').select('*').eq('store_id', storeId).order('sort_order'),
      supabase.from('tags').select('*').eq('store_id', storeId).order('sort_order'),
      supabase.from('variant_option_types')
        .select('*, variant_option_values(id, value, sort_order)')
        .eq('store_id', storeId)
        .order('sort_order').order('name'),
      supabase.from('storefront_products')
        .select('collection_end')
        .eq('store_id', storeId)
        .not('collection_end', 'is', null)
        .gt('collection_end', new Date().toISOString()),
    ]).then(([{ data: cats }, { data: tgs }, { data: opts }, { data: ends }]) => {
      setCategories(cats || [])
      setAllTags(tgs || [])
      setOptionTypes(opts || [])
      const unique = [...new Set((ends || []).map(d => d.collection_end))]
        .sort((a, b) => new Date(a) - new Date(b))
      const pad = n => String(n).padStart(2, '0')
      setRecentEnds(unique.map(iso => {
        const d = new Date(iso)
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
      }))
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
    // 刪照片後 index 位移，AI 選取/標記要跟著重排
    const shift = arr => arr.filter(i => i !== idx).map(i => (i > idx ? i - 1 : i))
    setAiSelected(shift)
    setAiOnly(shift)
  }

  // --- AI 補齊 ---
  function toggleAiSelect(idx) {
    setAiSelected(prev => {
      if (prev.includes(idx)) return prev.filter(i => i !== idx)
      if (prev.length >= 3) return prev
      return [...prev, idx]
    })
  }

  function toggleAiOnly(idx) {
    setAiOnly(prev => {
      const on = !prev.includes(idx)
      // 標「僅供辨識」的照片就是要給 AI 看的（典型：近拍價標照），順手選進送 AI 清單
      if (on) setAiSelected(sel => (sel.includes(idx) || sel.length >= 3 ? sel : [...sel, idx]))
      return on ? [...prev, idx] : prev.filter(i => i !== idx)
    })
  }

  async function runAiFill() {
    if (aiLoading) return
    const picks = aiSelected.filter(i => i < imageFiles.length)
    const targets = picks.length > 0 ? picks : [0]
    setAiLoading(true)
    try {
      const images = []
      for (const i of targets) {
        images.push(await toAiImage(imageFiles[i], aiOnly.includes(i)))
      }
      const { data, error } = await supabase.functions.invoke('smart-listing', {
        body: {
          images,
          categories: categories.map(c => c.name),
          tags: allTags.map(t => t.name),
          sources: existingSources,  // 品牌白名單：命中就不花搜尋驗證
        },
      })
      // 非 2xx 時 supabase-js 把回應放在 error.context（前例：ContactPage）
      let payload = data
      if (error) {
        try { payload = await error.context.json() } catch { payload = null }
        if (error.context?.status === 429) {
          alert(payload?.error || '本月 AI 額度已用完')
          return
        }
      }
      if (!payload?.ok) {
        alert(payload?.error || 'AI 補齊失敗，請手動填寫')
        return
      }
      setAiLogId(payload.log_id ?? null)
      const s = payload.suggestion || {}
      // 空欄位直接回填（同頁看得到、隨時能改）；已有使用者輸入的欄位不覆蓋，
      // 改列在「AI 建議」區由店家點套用。標價一律不自動填——由店家選擇進成本或售價。
      if (s.name && !name.trim()) setName(s.name)
      if (s.source && !source.trim()) setSource(s.source)
      let openOptional = false
      if (s.desc_zh && !descZh.trim()) { setDescZh(s.desc_zh); openOptional = true }
      const catHit = categories.find(c => c.name === s.category_suggestion)
      if (catHit && !selectedCategory) { setSelectedCategory(String(catHit.id)); openOptional = true }
      const tagHitIds = allTags.filter(t => (s.tag_suggestions || []).includes(t.name)).map(t => t.id)
      if (tagHitIds.length > 0) {
        setSelectedTags(prev => [...new Set([...prev, ...tagHitIds])])
        openOptional = true
      }
      if (openOptional) setShowOptional(true)  // 摺疊區被填了值就自動展開，店家才看得到
      setAiResult(s)
      setAiDraft({
        name: s.name || '',
        source: s.source || '',
        desc: s.desc_zh || '',
        price: s.cost != null ? String(s.cost) : '',
        catNew: s.category_new || '',
        tagsNew: (s.tag_new_suggestions || []).join('、'),
      })
    } catch {
      alert('AI 補齊失敗，請手動填寫')
    } finally {
      setAiLoading(false)
    }
  }

  function applyAiCategory() {
    const match = categories.find(c => c.name === aiResult?.category_suggestion)
    if (match) setSelectedCategory(String(match.id))
  }

  // AI 提議的新分類/新標籤：店家可先編輯草稿，點「建立並套用」才真的建立（AI 只提議，不落地）
  async function applyAiNewCategory() {
    const nm = aiDraft?.catNew?.trim()
    if (!nm) return
    // 改名改到跟現有分類同名 → 直接選用，不重複建立
    const existing = categories.find(c => c.name === nm)
    if (existing) { setSelectedCategory(String(existing.id)); return }
    const { data, error } = await supabase.from('categories')
      .insert({ name: nm, store_id: storeId })
      .select('*').single()
    if (error || !data) { alert('建立分類失敗：' + (error?.message || '未知錯誤')); return }
    setCategories(prev => [...prev, data])
    setSelectedCategory(String(data.id))
  }

  async function applyAiNewTags() {
    const names = parseTagNames(aiDraft?.tagsNew || '')
    if (names.length === 0) return
    const existingIds = allTags.filter(t => names.includes(t.name)).map(t => t.id)
    const toCreate = names.filter(n => !allTags.some(t => t.name === n))
    let created = []
    if (toCreate.length > 0) {
      const { data, error } = await supabase.from('tags')
        .insert(toCreate.map(n => ({ name: n, store_id: storeId })))
        .select('*')
      if (error || !data) { alert('建立標籤失敗：' + (error?.message || '未知錯誤')); return }
      created = data
      setAllTags(prev => [...prev, ...created])
    }
    setSelectedTags(prev => [...new Set([...prev, ...existingIds, ...created.map(t => t.id)])])
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
      return { options, stock: 0, variant_price: null, sale_price: null, variant_cost: null }
    }))
  }

  function updateLocalVariant(idx, field, value) {
    setLocalVariants(prev => prev.map((v, i) => {
      if (i !== idx) return v
      if (field === 'stock') return { ...v, stock: value === '' ? 0 : Number(value) }
      if (field === 'sale_price') return { ...v, sale_price: value === '' ? null : Number(value) }
      if (field === 'variant_cost') return { ...v, variant_cost: value === '' ? null : Number(value) }
      return { ...v, variant_price: value === '' ? null : Number(value) }
    }))
  }

  function removeLocalVariant(idx) {
    setLocalVariants(prev => prev.filter((_, i) => i !== idx))
  }

  function applyBatch(field) {
    const val = field === 'stock' ? batchStock : field === 'sale_price' ? batchSale : field === 'variant_cost' ? batchCost : batchPrice
    if (val === '') return
    setLocalVariants(prev => prev.map(v => ({ ...v, [field]: Number(val) })))
    if (field === 'stock') setBatchStock('')
    else if (field === 'sale_price') setBatchSale('')
    else if (field === 'variant_cost') setBatchCost('')
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
    if (step === 1) {
      if (!name.trim() || !shopPrice) return false
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
        store_id: storeId,
        ai_log_id: aiLogId,
      }).select('id').single()

      if (prodErr || !inserted) {
        alert('建立商品失敗：' + (prodErr?.message || '未知錯誤'))
        setSaving(false)
        return
      }

      const productId = inserted.id

      // 2. Upload images（排除「僅供辨識」照片——近拍價標不能曝光在商城）
      const uploadable = imageFiles.filter((_, i) => !aiOnly.includes(i))
      if (uploadable.length > 0) {
        await uploadImages(uploadable, productId)
      }

      // 3. History record
      if (baseQty > 0) {
        await supabase.from('history').insert({
          product_id: productId,
          change: baseQty,
          reason: '初始建立',
          store_id: storeId,
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
            sale_price: onSale ? v.sale_price : null,
            variant_cost: v.variant_cost ?? null,
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
        on_sale: onSale,
        sale_price: onSale && salePrice !== '' ? Number(salePrice) : null,
        sale_start: onSale && saleStart ? new Date(saleStart).toISOString() : null,
        sale_end: onSale && saleEnd ? new Date(saleEnd).toISOString() : null,
        store_id: storeId,
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
            {/* AI 補齊 */}
            <div className="form-group" style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 12, padding: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <button
                  type="button"
                  className="btn"
                  disabled={aiLoading}
                  onClick={runAiFill}
                  style={{ width: 'auto', padding: '8px 16px', fontSize: 13, opacity: aiLoading ? 0.5 : 1 }}
                >{aiLoading ? 'AI 辨識中…' : '✨ AI 補齊'}</button>
                <span className="muted fs12" style={{ flex: 1, lineHeight: 1.5 }}>
                  點選要送 AI 的照片（最多 3 張），自動填入商品資料
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {previews.map((src, i) => {
                  const selected = aiSelected.includes(i)
                  const only = aiOnly.includes(i)
                  return (
                    <div key={i} style={{ width: 64 }}>
                      <img
                        src={src}
                        onClick={() => toggleAiSelect(i)}
                        style={{
                          width: 64, height: 64, objectFit: 'cover', borderRadius: 8, display: 'block',
                          cursor: 'pointer', boxSizing: 'border-box',
                          border: selected ? '2px solid var(--text)' : '2px solid transparent',
                          opacity: selected ? 1 : 0.55,
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => toggleAiOnly(i)}
                        title="標記後：這張照片送 AI 用高解析原圖，上架時不會出現在商品圖"
                        style={{
                          width: '100%', marginTop: 4, padding: '2px 0', fontSize: 10, borderRadius: 6,
                          cursor: 'pointer', transition: 'all .15s',
                          border: `0.5px solid ${only ? 'var(--red)' : 'var(--border)'}`,
                          background: only ? 'var(--red)' : 'transparent',
                          color: only ? '#fff' : 'var(--text-3)',
                        }}
                      >{only ? '僅辨識 不上架' : '僅供辨識'}</button>
                    </div>
                  )
                })}
              </div>

              {/* AI 建議區：值可直接編輯，點「套用/建立並套用」才寫入，不覆蓋已填欄位 */}
              {aiResult && aiDraft && (() => {
                const catMatch = categories.find(c => c.name === aiResult.category_suggestion)
                const newTagNames = parseTagNames(aiDraft.tagsNew).filter(n => !allTags.some(t => t.name === n))
                const rows = [
                  aiDraft.name.trim() && name.trim() !== aiDraft.name.trim() && (
                    <EditableSuggestRow key="name" label="商品名" value={aiDraft.name}
                      onChange={v => setAiDraft(d => ({ ...d, name: v }))}
                      onApply={() => setName(aiDraft.name.trim())} />
                  ),
                  aiDraft.source.trim() && source.trim() !== aiDraft.source.trim() && (
                    <EditableSuggestRow key="source" label="來源" value={aiDraft.source}
                      onChange={v => setAiDraft(d => ({ ...d, source: v }))}
                      onApply={() => setSource(aiDraft.source.trim())} />
                  ),
                  aiDraft.price !== '' && cost !== aiDraft.price && shopPrice !== aiDraft.price && (
                    <div key="price" style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 0' }}>
                      <span className="fs12 muted" style={{ flexShrink: 0, width: 44, paddingTop: 10 }}>標價</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <input className="form-input" type="number" value={aiDraft.price}
                            onChange={e => setAiDraft(d => ({ ...d, price: e.target.value }))}
                            style={{ fontSize: 13, padding: '8px 10px', width: 110 }} />
                          <span className="fs13 muted">{aiResult.currency || ''}</span>
                        </div>
                        {aiResult.currency && aiResult.currency !== 'TWD' && (
                          <div className="muted fs12" style={{ marginTop: 2 }}>售價欄為 NT$，非台幣標價請自行換算</div>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: 6, marginTop: 7, flexShrink: 0 }}>
                        <button type="button"
                          onClick={() => { setCost(aiDraft.price); if (aiResult.currency) setCurrency(aiResult.currency) }}
                          style={{ padding: '3px 12px', borderRadius: 14, fontSize: 12, cursor: 'pointer', border: '0.5px solid var(--text)', background: 'var(--text)', color: '#fff' }}
                        >→ 成本</button>
                        <button type="button"
                          onClick={() => setShopPrice(aiDraft.price)}
                          style={{ padding: '3px 12px', borderRadius: 14, fontSize: 12, cursor: 'pointer', border: '0.5px solid var(--border)', background: 'transparent', color: 'var(--text-2)' }}
                        >→ 售價</button>
                      </div>
                    </div>
                  ),
                  aiDraft.desc.trim() && descZh !== aiDraft.desc.trim() && (
                    <EditableSuggestRow key="desc" label="描述" multiline value={aiDraft.desc}
                      onChange={v => setAiDraft(d => ({ ...d, desc: v }))}
                      onApply={() => setDescZh(aiDraft.desc.trim())} />
                  ),
                  catMatch && selectedCategory !== String(catMatch.id) && (
                    <SuggestRow key="cat" label="分類" value={catMatch.name} onApply={applyAiCategory} />
                  ),
                  aiDraft.catNew.trim() && !categories.some(c => c.name === aiDraft.catNew.trim()) && (
                    <EditableSuggestRow key="catnew" label="新分類" value={aiDraft.catNew}
                      onChange={v => setAiDraft(d => ({ ...d, catNew: v }))}
                      applyLabel="建立並套用" onApply={applyAiNewCategory} />
                  ),
                  newTagNames.length > 0 && (
                    <EditableSuggestRow key="tagnew" label="新標籤" value={aiDraft.tagsNew} hint="多個標籤用「、」分隔"
                      onChange={v => setAiDraft(d => ({ ...d, tagsNew: v }))}
                      applyLabel="建立並套用" onApply={applyAiNewTags} />
                  ),
                ].filter(Boolean)
                if (rows.length === 0 && !aiResult.notes) return null
                return (
                  <div style={{ marginTop: 12, borderTop: '0.5px solid var(--border)', paddingTop: 10 }}>
                    {rows.length > 0 && (
                      <div className="muted fs12 fw600" style={{ marginBottom: 4 }}>AI 建議（可直接編輯，點「套用」寫入欄位）</div>
                    )}
                    {rows}
                    {aiResult.notes && (
                      <div className="muted fs12" style={{ marginTop: 6, lineHeight: 1.5 }}>💡 {aiResult.notes}</div>
                    )}
                  </div>
                )
              })()}
            </div>

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
                  options={SUPPORTED_CURRENCIES.map(c => ({ value: c, label: c }))}
                  onChange={v => setCurrency(v || 'TWD')}
                  allowClear={false}
                />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">商城售價（NT$） *</label>
              <input className="form-input" type="number" placeholder="0" value={shopPrice} onChange={e => setShopPrice(e.target.value)} />
            </div>

            {/* 特價（可選）*/}
            <div className="form-group" style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 12, padding: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="form-label fs13 fw600" style={{ margin: 0, flex: 1 }}>🏷️ 特價</span>
                <div
                  onClick={() => setOnSale(v => !v)}
                  style={{ width: 44, height: 26, borderRadius: 13, cursor: 'pointer', transition: 'background .2s', background: onSale ? 'var(--red)' : 'var(--border)', position: 'relative' }}
                >
                  <div style={{ width: 20, height: 20, borderRadius: '50%', background: '#fff', position: 'absolute', top: 3, transition: 'left .2s', left: onSale ? 21 : 3 }} />
                </div>
              </div>
              {onSale && (
                <div style={{ marginTop: 14 }}>
                  <label className="form-label">
                    特價金額（NT$）
                    {(() => {
                      const reg = Number(shopPrice) || 0
                      const sale = Number(salePrice)
                      if (!salePrice || !reg) return null
                      if (sale >= reg) return <span className="muted" style={{ fontWeight: 400, marginLeft: 8, color: 'var(--red)' }}>需低於原價 {reg.toLocaleString()}</span>
                      const pct = Math.round((sale / reg) * 100) / 10
                      return <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>約 {pct} 折</span>
                    })()}
                  </label>
                  <input className="form-input" type="number" placeholder="0" value={salePrice} onChange={e => setSalePrice(e.target.value)} />
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
                    <div>
                      <label className="form-label fs13">開始時間</label>
                      <input className="form-input" type="datetime-local" value={saleStart} onChange={e => setSaleStart(e.target.value)} />
                    </div>
                    <div>
                      <label className="form-label fs13">結束時間</label>
                      <input className="form-input" type="datetime-local" value={saleEnd} onChange={e => setSaleEnd(e.target.value)} />
                    </div>
                  </div>
                  <div className="muted fs12" style={{ marginTop: 8, lineHeight: 1.6 }}>
                    兩個皆留空＝常駐特價；只填開始＝該日起；只填結束＝到該日止；都填＝期間內。
                  </div>
                </div>
              )}
            </div>
            {/* ── 販售設定 ── */}
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
                  {recentEnds.length > 0 && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                      {recentEnds.map(t => {
                        const d = new Date(t.replace('T', ' '))
                        const label = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
                        const isActive = collectionEnd === t
                        return (
                          <button key={t} onClick={() => setCollectionEnd(t)} style={{
                            fontSize: 12, padding: '4px 10px', borderRadius: 16, cursor: 'pointer',
                            border: '0.5px solid var(--border)', transition: 'all .15s',
                            background: isActive ? 'var(--text)' : 'var(--surface)',
                            color: isActive ? '#fff' : 'var(--text-2)',
                          }}>{label}</button>
                        )
                      })}
                    </div>
                  )}
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
                            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                              <span className="muted fs12">批次成本:</span>
                              <input
                                type="number"
                                value={batchCost}
                                onChange={e => setBatchCost(e.target.value)}
                                placeholder={cost !== '' ? String(cost) : '成本'}
                                style={{ width: 80, padding: '4px 8px', borderRadius: 6, border: '0.5px solid var(--border)', fontSize: 13, textAlign: 'center' }}
                              />
                              <button onClick={() => applyBatch('variant_cost')} style={{ padding: '4px 10px', borderRadius: 6, border: '0.5px solid var(--border)', background: 'var(--bg)', fontSize: 11, cursor: 'pointer' }}>套用</button>
                            </div>
                            {onSale && (
                              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                                <span className="muted fs12" style={{ color: 'var(--red)' }}>批次特價:</span>
                                <input
                                  type="number"
                                  value={batchSale}
                                  onChange={e => setBatchSale(e.target.value)}
                                  placeholder={salePrice !== '' ? String(salePrice) : '特價'}
                                  style={{ width: 80, padding: '4px 8px', borderRadius: 6, border: '0.5px solid var(--border)', fontSize: 13, textAlign: 'center' }}
                                />
                                <button onClick={() => applyBatch('sale_price')} style={{ padding: '4px 10px', borderRadius: 6, border: '0.5px solid var(--border)', background: 'var(--bg)', fontSize: 11, cursor: 'pointer' }}>套用</button>
                              </div>
                            )}
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
                                <th style={{ padding: '8px 6px', width: 90, textAlign: 'center', fontSize: 12, color: 'var(--text-3)', fontWeight: 600 }}>成本({currency})</th>
                                {onSale && (
                                  <th style={{ padding: '8px 6px', width: 90, textAlign: 'center', fontSize: 12, color: 'var(--red)', fontWeight: 600 }}>特價(NT$)</th>
                                )}
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
                                    <input
                                      type="number"
                                      value={v.variant_cost ?? ''}
                                      onChange={e => updateLocalVariant(idx, 'variant_cost', e.target.value)}
                                      placeholder={cost !== '' ? String(cost) : '成本'}
                                      style={{ width: '100%', padding: '5px 8px', borderRadius: 6, border: '0.5px solid var(--border)', fontSize: 13, textAlign: 'center', background: 'var(--bg)' }}
                                    />
                                  </td>
                                  {onSale && (
                                    <td style={{ padding: '8px 6px', textAlign: 'center' }}>
                                      <input
                                        type="number"
                                        value={v.sale_price ?? ''}
                                        onChange={e => updateLocalVariant(idx, 'sale_price', e.target.value)}
                                        placeholder={salePrice !== '' ? String(salePrice) : '特價'}
                                        style={{ width: '100%', padding: '5px 8px', borderRadius: 6, border: '0.5px solid var(--red)', fontSize: 13, textAlign: 'center', background: 'var(--bg)' }}
                                      />
                                    </td>
                                  )}
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
                          <br/>成本留空 = 使用進貨成本{cost !== '' ? ` ${Number(cost).toLocaleString()} ${currency}` : ''}
                          {onSale && <><br/>特價留空 = 使用全品特價{salePrice !== '' ? ` NT$${Number(salePrice).toLocaleString()}` : '（未設定則該規格不特價）'}</>}
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
                  <textarea className="form-input" placeholder="商品說明" rows={3} value={descZh} onChange={e => setDescZh(e.target.value)}
                    style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6 }} />
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

        {/* Confirm */}
        {step === 2 && (
          <div>
            <div className="muted fs13" style={{ marginBottom: 16 }}>請確認以下資訊，按下「確認上架」即完成</div>

            {/* Image preview */}
            {previews.length > 0 && (
              <div style={{ display: 'flex', gap: 6, marginBottom: 16, overflowX: 'auto' }}>
                {previews.map((src, i) => (
                  <div key={i} style={{ position: 'relative', flexShrink: 0 }}>
                    <img src={src} style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8, display: 'block', opacity: aiOnly.includes(i) ? 0.5 : 1 }} />
                    {aiOnly.includes(i) && (
                      <span style={{ position: 'absolute', bottom: 2, left: 2, fontSize: 9, background: 'rgba(0,0,0,.65)', color: '#fff', borderRadius: 4, padding: '1px 4px' }}>不上架</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            <ConfirmRow label="商品名稱" value={name} />
            <ConfirmRow label="採購來源" value={source || '未設定'} muted={!source} />
            <ConfirmRow label="進貨成本" value={cost ? `${cost} ${currency}` : '未設定'} muted={!cost} />
            <ConfirmRow label="商城售價" value={`NT$ ${Number(shopPrice).toLocaleString()}`} />
            {onSale && salePrice !== '' && (
              <ConfirmRow label="特價" value={`NT$ ${Number(salePrice).toLocaleString()}${
                !saleStart && !saleEnd ? '（常駐）'
                  : `（${saleStart ? formatDateTime(saleStart) : ''}${saleStart && saleEnd ? ' ~ ' : ''}${saleEnd ? formatDateTime(saleEnd) : ''}）`
              }`} highlight />
            )}
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
                      {onSale && v.sale_price != null && (
                        <span style={{ color: 'var(--red)' }}>
                          {(!skipStockCheck || v.variant_price != null) ? ' · ' : ''}特價 NT${v.sale_price.toLocaleString()}
                        </span>
                      )}
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
          {step < 2 ? (
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

function EditableSuggestRow({ label, value, onChange, onApply, applyLabel = '套用', multiline, hint }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 0' }}>
      <span className="fs12 muted" style={{ flexShrink: 0, width: 44, paddingTop: 10 }}>{label}</span>
      <div style={{ flex: 1 }}>
        {multiline ? (
          <textarea className="form-input" rows={4} value={value} onChange={e => onChange(e.target.value)}
            style={{ fontSize: 13, padding: '8px 10px', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }} />
        ) : (
          <input className="form-input" value={value} onChange={e => onChange(e.target.value)}
            style={{ fontSize: 13, padding: '8px 10px' }} />
        )}
        {hint && <div className="muted fs12" style={{ marginTop: 2 }}>{hint}</div>}
      </div>
      <button
        type="button"
        onClick={onApply}
        style={{
          flexShrink: 0, padding: '3px 12px', borderRadius: 14, fontSize: 12, cursor: 'pointer', marginTop: 7,
          border: '0.5px solid var(--text)', background: 'var(--text)', color: '#fff',
        }}
      >{applyLabel}</button>
    </div>
  )
}

function SuggestRow({ label, value, onApply, applyLabel = '套用' }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 0' }}>
      <span className="fs12 muted" style={{ flexShrink: 0, width: 44, paddingTop: 2 }}>{label}</span>
      <span className="fs13" style={{ flex: 1, whiteSpace: 'pre-line', lineHeight: 1.5 }}>{value}</span>
      <button
        type="button"
        onClick={onApply}
        style={{
          flexShrink: 0, padding: '3px 12px', borderRadius: 14, fontSize: 12, cursor: 'pointer',
          border: '0.5px solid var(--text)', background: 'var(--text)', color: '#fff',
        }}
      >{applyLabel}</button>
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
