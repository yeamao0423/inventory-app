import { useState, useEffect, useMemo, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import { uploadImages, compressImage, reencodeImage } from '../lib/imageUtils'
import { SUPPORTED_CURRENCIES } from '../constants/currency'
import CustomSelect from './CustomSelect'
import VariantEditor from './VariantEditor'

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

async function toAiImage(file, fullRes) {
  let f = file
  if (fullRes) {
    if (!AI_MEDIA_TYPES.includes(f.type) || f.size > 4 * 1024 * 1024)
      f = await reencodeImage(f, 2016, 0.9)
  } else {
    f = await compressImage(f)
    if (!AI_MEDIA_TYPES.includes(f.type)) f = await reencodeImage(f, 1200, 0.75)
  }
  return fileToBase64(f)
}

function range(start, end) {
  const arr = []
  for (let i = start; i <= end; i++) arr.push(i)
  return arr
}

function blankDraft(groupSize) {
  const defaultSelected = range(0, Math.min(2, groupSize - 1))
  return {
    aiStatus: 'idle',
    aiError: null,
    aiWanted: true,          // 是否勾選要 AI 補齊（進入確認頁後由使用者決定）
    aiSelected: defaultSelected,
    aiOnly: [],
    name: '',
    source: '',
    sourceSelectMode: false,
    shopPrice: '',
    cost: '',
    currency: 'TWD',
    aiSuggestedPrice: null,    // AI 辨識出的金額，null 代表尚未補齊或已分配
    aiSuggestedCurrency: 'TWD',
    descZh: '',
    categoryId: '',
    tagIds: [],
    quantity: '',
    hasVariants: false,
    selectedTypes: {},
    selectedValues: {},
    variants: [],
    confirmed: false,
    logId: null,
    expanded: false,
  }
}

export default function BulkListSheet({ onClose, onSaved, existingSources = [] }) {
  const { storeId } = useAuth()

  const [photos, setPhotos] = useState([])
  const [previews, setPreviews] = useState([])
  const [dividers, setDividers] = useState(new Set())
  const [step, setStep] = useState('upload')

  const [sellingMode, setSellingMode] = useState('stock')
  const [collectionEnd, setCollectionEnd] = useState('')
  const [recentEnds, setRecentEnds] = useState([])

  const [reviewGroups, setReviewGroups] = useState([])
  const [drafts, setDrafts] = useState([])

  const [categories, setCategories] = useState([])
  const [allTags, setAllTags] = useState([])
  const [optionTypes, setOptionTypes] = useState([])
  const [saving, setSaving] = useState(false)
  const [autoGrouping, setAutoGrouping] = useState(false)

  const [lightboxUrl, setLightboxUrl] = useState(null)
  const [hoverInfo, setHoverInfo] = useState(null)
  const pressTimer = useRef(null)

  // 拖曳排序（桌機滑鼠 + 手機觸控共用 pointer events）
  const [dragIdx, setDragIdx] = useState(null) // 正在被拖曳的縮圖目前索引
  const [ghost, setGhost] = useState(null)      // 跟隨指標的浮動縮圖 { url, x, y }
  const dragRef = useRef(null)                  // 進行中的 pointer session
  const stripRef = useRef(null)                 // 縮圖列容器（供自動捲動用）
  const autoScrollRef = useRef(null)            // requestAnimationFrame id
  const scrollDirRef = useRef(0)                // -1 左 / 0 停 / 1 右

  useEffect(() => {
    if (!storeId) return
    Promise.all([
      supabase.from('categories').select('*').eq('store_id', storeId).order('sort_order'),
      supabase.from('tags').select('*').eq('store_id', storeId).order('sort_order'),
      supabase.from('variant_option_types')
        .select('*, variant_option_values(id, value, sort_order)')
        .eq('store_id', storeId)
        .order('sort_order').order('name'),
      supabase
        .from('storefront_products')
        .select('collection_end')
        .eq('store_id', storeId)
        .not('collection_end', 'is', null)
        .gt('collection_end', new Date().toISOString())
        .order('collection_end', { ascending: false })
        .limit(5),
    ]).then(([{ data: cats }, { data: tgs }, { data: opts }, { data: ends }]) => {
      setCategories(cats || [])
      setAllTags(tgs || [])
      setOptionTypes(opts || [])
      if (ends) {
        const pad = n => String(n).padStart(2, '0')
        const unique = [...new Set(ends.map(r => {
          const d = new Date(r.collection_end)
          return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
        }))]
        setRecentEnds(unique.slice(0, 5))
      }
    })
  }, [storeId])

  const liveGroups = useMemo(() => {
    if (!photos.length) return []
    const result = []
    let start = 0
    const sorted = [...dividers].sort((a, b) => a - b)
    for (const d of sorted) {
      if (d >= 0 && d < photos.length - 1) {
        result.push(range(start, d))
        start = d + 1
      }
    }
    result.push(range(start, photos.length - 1))
    return result
  }, [photos.length, dividers])

  function onPhotosChange(e) {
    const files = Array.from(e.target.files)
    if (!files.length) return
    setPhotos(prev => [...prev, ...files])
    setPreviews(prev => [...prev, ...files.map(f => URL.createObjectURL(f))])
    e.target.value = ''
  }

  function removePhoto(idx) {
    URL.revokeObjectURL(previews[idx])
    setPhotos(prev => prev.filter((_, i) => i !== idx))
    setPreviews(prev => prev.filter((_, i) => i !== idx))
    setDividers(prev => {
      const next = new Set()
      for (const d of prev) {
        if (d === idx) continue
        next.add(d > idx ? d - 1 : d)
      }
      return next
    })
  }

  function toggleDivider(afterIdx) {
    if (afterIdx >= photos.length - 1) return
    setDividers(prev => {
      const next = new Set(prev)
      if (next.has(afterIdx)) next.delete(afterIdx)
      else next.add(afterIdx)
      return next
    })
  }

  async function runAutoGroup() {
    if (autoGrouping || photos.length === 0) return
    setAutoGrouping(true)
    try {
      const images = []
      for (const file of photos) images.push(await toAiImage(file, false))
      const { data, error } = await supabase.functions.invoke('smart-listing', {
        body: { mode: 'group', images },
      })
      let payload = data
      if (error) {
        try { payload = await error.context.json() } catch { payload = null }
        if (error.context?.status === 429) { alert(payload?.error || '本月 AI 額度已用完'); return }
      }
      if (!payload?.ok || !Array.isArray(payload.groups)) {
        alert(payload?.error || 'AI 分組失敗，請手動分組')
        return
      }
      const newDividers = new Set()
      for (let i = 0; i < payload.groups.length - 1; i++) {
        const lastInGroup = Math.max(...payload.groups[i])
        if (lastInGroup < photos.length - 1) newDividers.add(lastInGroup)
      }
      setDividers(newDividers)
    } catch {
      alert('AI 分組失敗，請手動分組')
    } finally {
      setAutoGrouping(false)
    }
  }

  function updateDraft(i, updates) {
    setDrafts(prev => {
      const next = [...prev]
      next[i] = { ...next[i], ...updates }
      return next
    })
  }

  // 批量將 AI 建議金額套用為售價或成本
  function applyAllSuggestedAs(field) {
    setDrafts(prev => prev.map(d => {
      if (!d.aiSuggestedPrice) return d
      if (field === 'shopPrice') {
        return { ...d, shopPrice: d.shopPrice || d.aiSuggestedPrice, aiSuggestedPrice: null }
      }
      return { ...d, cost: d.aiSuggestedPrice, currency: d.aiSuggestedCurrency, aiSuggestedPrice: null }
    }))
  }

  async function runAiForGroup(groupIdx, groupIndices, aiSelected, aiOnly, cats, tgs) {
    updateDraft(groupIdx, { aiStatus: 'loading', aiError: null })
    try {
      const picks = aiSelected.length > 0 ? aiSelected : [0]
      const images = []
      for (const localIdx of picks.slice(0, 3)) {
        const globalIdx = groupIndices[localIdx]
        if (globalIdx != null)
          images.push(await toAiImage(photos[globalIdx], aiOnly.includes(localIdx)))
      }
      if (!images.length) { updateDraft(groupIdx, { aiStatus: 'error', aiError: '無可用照片' }); return }

      const { data, error } = await supabase.functions.invoke('smart-listing', {
        body: {
          images,
          categories: cats.map(c => c.name),
          tags: tgs.map(t => t.name),
          sources: existingSources,
        },
      })
      let payload = data
      if (error) {
        try { payload = await error.context.json() } catch { payload = null }
      }
      if (!payload?.ok) {
        updateDraft(groupIdx, { aiStatus: 'error', aiError: payload?.error || 'AI 補齊失敗，請手動填寫' })
        return
      }
      const s = payload.suggestion || {}
      const catHit = cats.find(c => c.name === s.category_suggestion)
      const tagHitIds = tgs.filter(t => (s.tag_suggestions || []).includes(t.name)).map(t => t.id)
      updateDraft(groupIdx, {
        aiStatus: 'done',
        name: s.name || '',
        source: s.source || '',
        descZh: s.desc_zh || '',
        // AI 辨識到金額時暫存，等使用者選擇要作為「售價」還是「成本」
        aiSuggestedPrice: s.cost != null ? String(s.cost) : null,
        aiSuggestedCurrency: s.currency || 'TWD',
        categoryId: catHit ? String(catHit.id) : '',
        tagIds: tagHitIds,
        logId: payload.log_id ?? null,
      })
    } catch {
      updateDraft(groupIdx, { aiStatus: 'error', aiError: 'AI 補齊失敗，請手動填寫' })
    }
  }

  function goToReview() {
    const snapshot = liveGroups
    setReviewGroups(snapshot)
    setDrafts(snapshot.map(g => blankDraft(g.length)))
    setStep('review')
  }

  // 只跑「有勾選且尚未跑過」的組；沒勾的保留 idle，可事後單獨補齊
  function startAiForSelected() {
    drafts.forEach((d, i) => {
      if (d.aiStatus === 'idle' && d.aiWanted)
        runAiForGroup(i, reviewGroups[i], d.aiSelected, d.aiOnly, categories, allTags)
    })
  }

  function setAllAiWanted(on) {
    setDrafts(prev => prev.map(d => (d.aiStatus === 'idle' ? { ...d, aiWanted: on } : d)))
  }

  function goBackToUpload() {
    setStep('upload')
  }

  async function submitAll() {
    const toSubmit = drafts
      .map((d, i) => ({ draft: d, groupIdx: i }))
      .filter(({ draft }) => draft.confirmed && draft.name.trim() && draft.shopPrice)
    if (!toSubmit.length) { alert('請先確認至少一件商品（需填寫名稱和售價）'); return }
    if (sellingMode === 'collection' && !collectionEnd) { alert('請設定限時收單的結單時間'); return }
    setSaving(true)
    let ok = 0, fail = 0
    for (const { draft, groupIdx } of toSubmit) {
      try {
        const hasVariants = draft.hasVariants && draft.variants.length > 0
        // 有規格時 quantity = 各規格庫存加總（與快速上架一致）
        const baseQty = hasVariants
          ? (sellingMode === 'stock' ? draft.variants.reduce((s, v) => s + (v.stock || 0), 0) : 0)
          : (sellingMode === 'stock' && draft.quantity ? Number(draft.quantity) : 0)
        const { data: inserted, error: prodErr } = await supabase.from('products').insert({
          name: draft.name.trim(),
          quantity: baseQty,
          unit: '個',
          cost: draft.cost ? Number(draft.cost) : 0,
          currency: draft.currency || 'TWD',
          category_id: draft.categoryId ? Number(draft.categoryId) : null,
          source: draft.source.trim() || null,
          store_id: storeId,
          ai_log_id: draft.logId,
        }).select('id').single()
        if (prodErr || !inserted) { fail++; continue }
        const productId = inserted.id

        const groupIndices = reviewGroups[groupIdx] || []
        const uploadable = groupIndices
          .filter((_, localIdx) => !draft.aiOnly.includes(localIdx))
          .map(globalIdx => photos[globalIdx])
        if (uploadable.length) await uploadImages(uploadable, productId)

        if (draft.tagIds.length) {
          await supabase.from('product_tags').insert(
            draft.tagIds.map(tagId => ({ product_id: productId, tag_id: tagId }))
          )
        }
        if (hasVariants) {
          await supabase.from('product_variants').insert(
            draft.variants.map(v => ({
              product_id: productId,
              options: v.options,
              stock: sellingMode === 'stock' ? (v.stock || 0) : 0,
              variant_price: v.variant_price,
              sale_price: null,
              variant_cost: v.variant_cost ?? null,
            }))
          )
        }
        const { error: sfErr } = await supabase.from('storefront_products').insert({
          product_id: productId,
          shop_price: Number(draft.shopPrice),
          desc_zh: draft.descZh.trim() || null,
          published: true,
          sold_out: false,
          skip_stock_check: sellingMode === 'collection',
          collection_end: sellingMode === 'collection' ? collectionEnd || null : null,
          store_id: storeId,
        })
        if (sfErr) { fail++; continue }
        ok++
      } catch { fail++ }
    }
    setSaving(false)
    if (ok > 0) {
      onSaved()
      if (fail > 0) alert(`成功上架 ${ok} 件，${fail} 件發布失敗`)
      else onClose()
    } else {
      alert('上架失敗，請再試一次')
    }
  }

  function handleTouchStart(url) {
    pressTimer.current = setTimeout(() => setLightboxUrl(url), 500)
  }
  function handleTouchEnd() { clearTimeout(pressTimer.current) }
  function handleMouseEnter(e, url) {
    if (dragRef.current?.active) return // 拖曳中不顯示 hover 預覽
    const rect = e.currentTarget.getBoundingClientRect()
    setHoverInfo({ url, x: rect.right + 8, y: Math.max(8, rect.top - 80) })
  }

  // ── 拖曳排序 ──────────────────────────────────────────────
  function movePhoto(from, to) {
    if (from === to) return
    const reorder = arr => {
      const next = arr.slice()
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      return next
    }
    setPhotos(prev => reorder(prev))
    setPreviews(prev => reorder(prev))
    // dividers 是「位置邊界」語義，重排照片時維持不動
  }

  function photoIdxAtPoint(x, y) {
    const holder = document.elementFromPoint(x, y)?.closest?.('[data-photoidx]')
    if (!holder) return null
    const n = Number(holder.getAttribute('data-photoidx'))
    return Number.isNaN(n) ? null : n
  }

  function maybeAutoScroll(x) {
    const el = stripRef.current
    if (!el) { scrollDirRef.current = 0; return }
    const rect = el.getBoundingClientRect()
    const edge = 48
    scrollDirRef.current = x < rect.left + edge ? -1 : x > rect.right - edge ? 1 : 0
    if (scrollDirRef.current !== 0 && !autoScrollRef.current) {
      const step = () => {
        if (scrollDirRef.current === 0 || !stripRef.current) { autoScrollRef.current = null; return }
        stripRef.current.scrollLeft += scrollDirRef.current * 10
        autoScrollRef.current = requestAnimationFrame(step)
      }
      autoScrollRef.current = requestAnimationFrame(step)
    }
  }
  function stopAutoScroll() {
    scrollDirRef.current = 0
    if (autoScrollRef.current) { cancelAnimationFrame(autoScrollRef.current); autoScrollRef.current = null }
  }

  function beginDrag(s, x, y) {
    if (s.active) return
    s.active = true
    clearTimeout(s.timer)
    setHoverInfo(null)
    setDragIdx(s.idx)
    setGhost({ url: previews[s.idx], x, y })
  }

  function onPhotoPointerDown(e, idx) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const s = {
      pointerId: e.pointerId, pointerType: e.pointerType,
      startX: e.clientX, startY: e.clientY,
      lastX: e.clientX, lastY: e.clientY,
      idx, active: false, timer: null, move: null, up: null,
    }
    dragRef.current = s
    const move = ev => handlePointerMove(ev, s)
    const up = ev => handlePointerUp(ev, s)
    s.move = move; s.up = up
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    // 手機：長按啟動拖曳；桌機：移動超過閾值才啟動（見 handlePointerMove）
    if (e.pointerType === 'touch') {
      s.timer = setTimeout(() => beginDrag(s, s.lastX, s.lastY), 200)
    }
  }

  function handlePointerMove(ev, s) {
    if (ev.pointerId !== s.pointerId) return
    s.lastX = ev.clientX; s.lastY = ev.clientY
    if (!s.active) {
      const dist = Math.hypot(ev.clientX - s.startX, ev.clientY - s.startY)
      if (s.pointerType === 'mouse') {
        if (dist > 6) beginDrag(s, ev.clientX, ev.clientY)
      } else if (dist > 12) {
        clearTimeout(s.timer); s.timer = null // 長按前滑動 → 視為捲動，不啟動拖曳
      }
      if (!s.active) return
    }
    ev.preventDefault()
    setGhost(g => (g ? { ...g, x: ev.clientX, y: ev.clientY } : g))
    maybeAutoScroll(ev.clientX)
    const t = photoIdxAtPoint(ev.clientX, ev.clientY)
    if (t != null && t !== s.idx) {
      movePhoto(s.idx, t)
      s.idx = t
      setDragIdx(t)
    }
  }

  function handlePointerUp(ev, s) {
    if (ev.pointerId !== s.pointerId) return
    clearTimeout(s.timer)
    stopAutoScroll()
    window.removeEventListener('pointermove', s.move)
    window.removeEventListener('pointerup', s.up)
    window.removeEventListener('pointercancel', s.up)
    const wasActive = s.active
    const dist = Math.hypot(s.lastX - s.startX, s.lastY - s.startY)
    dragRef.current = null
    setDragIdx(null)
    setGhost(null)
    // 沒進入拖曳且幾乎沒移動 → 視為單擊，開大圖
    if (!wasActive && dist < 6 && ev.type === 'pointerup') setLightboxUrl(previews[s.idx])
  }

  // 卸載時清理進行中的拖曳
  useEffect(() => () => {
    const s = dragRef.current
    if (s) {
      window.removeEventListener('pointermove', s.move)
      window.removeEventListener('pointerup', s.up)
      window.removeEventListener('pointercancel', s.up)
    }
    if (autoScrollRef.current) cancelAnimationFrame(autoScrollRef.current)
  }, [])

  const confirmedCount = drafts.filter(d => d.confirmed).length
  const suggestedCount = drafts.filter(d => d.aiSuggestedPrice).length
  const aiIdleCount = drafts.filter(d => d.aiStatus === 'idle').length
  const aiIdleWanted = drafts.filter(d => d.aiStatus === 'idle' && d.aiWanted).length

  // review mode: .sheet 轉 flex column，底部列脫離捲軸
  // overflow: 'hidden' 讓 sheet 本身不捲（由內部 scrollable div 負責），
  // 不設 height 以保留 CSS 的 max-height（mobile: 92dvh / desktop: 86dvh）不被覆蓋
  const sheetStyle = step === 'review'
    ? { display: 'flex', flexDirection: 'column', overflowY: 'hidden' }
    : {}

  // 點背景不關閉（誤觸會丟掉整批草稿），只能按 ×
  return (
    <div className="sheet-overlay">
      <div className="sheet" style={sheetStyle}>
        <div className="sheet-handle" style={{ flexShrink: 0 }} />

        <div className="row-sb" style={{ marginBottom: 16, flexShrink: 0 }}>
          <div className="sheet-title" style={{ margin: 0 }}>批量上架</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-3)' }}>×</button>
        </div>

        {/* Step indicator */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 20, flexShrink: 0 }}>
          {['上傳分組', '確認發布'].map((label, i) => {
            const active = (i === 0 && step === 'upload') || (i === 1 && step === 'review')
            const done = i === 0 && step === 'review'
            return (
              <div key={i} style={{ flex: 1, textAlign: 'center' }}>
                <div style={{ height: 3, borderRadius: 2, marginBottom: 6, background: (active || done) ? 'var(--text)' : 'var(--border)' }} />
                <span style={{ fontSize: 11, fontWeight: active ? 600 : 400, color: (active || done) ? 'var(--text)' : 'var(--text-3)' }}>{label}</span>
              </div>
            )
          })}
        </div>

        {/* ── Step 1：上傳分組 ── */}
        {step === 'upload' && (
          <div>
            {/* 販售模式 */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 8 }}>販售模式（批量套用）</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => setSellingMode('stock')}
                  style={{
                    flex: 1, padding: '12px 8px', borderRadius: 12, fontSize: 13, fontWeight: 600,
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
                    if (!collectionEnd) {
                      const d = new Date(); d.setDate(d.getDate() + 7)
                      const pad = n => String(n).padStart(2, '0')
                      setCollectionEnd(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`)
                    }
                  }}
                  style={{
                    flex: 1, padding: '12px 8px', borderRadius: 12, fontSize: 13, fontWeight: 600,
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

              {sellingMode === 'collection' && (
                <div style={{ marginTop: 10 }}>
                  {recentEnds.length > 0 && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                      {recentEnds.map(t => {
                        const d = new Date(t.replace('T', ' '))
                        const label = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
                        return (
                          <button key={t} onClick={() => setCollectionEnd(t)} style={{
                            fontSize: 12, padding: '4px 10px', borderRadius: 16, cursor: 'pointer',
                            border: '0.5px solid var(--border)', transition: 'all .15s',
                            background: collectionEnd === t ? 'var(--text)' : 'var(--surface)',
                            color: collectionEnd === t ? '#fff' : 'var(--text-2)',
                          }}>{label}</button>
                        )
                      })}
                    </div>
                  )}
                  <input
                    className="form-input"
                    type="datetime-local"
                    value={collectionEnd}
                    onChange={e => setCollectionEnd(e.target.value)}
                  />
                </div>
              )}
            </div>

            <label style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              border: '1.5px dashed var(--border)', borderRadius: 12, padding: '20px 16px',
              cursor: 'pointer', marginBottom: 16, background: 'var(--surface)',
            }}>
              <div style={{ fontSize: 28, marginBottom: 6 }}>📷</div>
              <div style={{ fontSize: 14, color: 'var(--text)' }}>點此選擇照片</div>
              <div className="muted fs12" style={{ marginTop: 4 }}>可一次選取多張</div>
              <input type="file" accept="image/*" multiple onChange={onPhotosChange} style={{ display: 'none' }} />
            </label>

            {photos.length > 0 && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <span className="muted fs12">點圓點 ＋ 新增分隔線 → 劃分不同商品</span>
                  <button
                    onClick={runAutoGroup}
                    disabled={autoGrouping}
                    style={{
                      padding: '5px 12px', borderRadius: 16, fontSize: 12, fontWeight: 600,
                      border: '1px solid var(--border)', background: 'var(--surface)',
                      color: 'var(--text)', cursor: autoGrouping ? 'default' : 'pointer',
                      whiteSpace: 'nowrap', flexShrink: 0, opacity: autoGrouping ? 0.6 : 1,
                    }}
                  >
                    {autoGrouping ? 'AI 分析中…' : '✦ AI 自動分組'}
                  </button>
                </div>

                <div
                  ref={stripRef}
                  style={{ display: 'flex', overflowX: 'auto', alignItems: 'center', paddingBottom: 12, WebkitOverflowScrolling: 'touch', gap: 0, touchAction: dragIdx != null ? 'none' : 'pan-x' }}
                >
                  {photos.map((_, idx) => (
                    <div key={idx} data-photoidx={idx} style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                      <div style={{ position: 'relative' }}>
                        <img
                          src={previews[idx]}
                          draggable={false}
                          style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 8, display: 'block', cursor: dragIdx != null ? 'grabbing' : 'grab', opacity: dragIdx === idx ? 0.35 : 1, touchAction: 'none', userSelect: 'none' }}
                          onPointerDown={e => onPhotoPointerDown(e, idx)}
                          onMouseEnter={e => handleMouseEnter(e, previews[idx])}
                          onMouseLeave={() => setHoverInfo(null)}
                        />
                        <button
                          onClick={() => removePhoto(idx)}
                          style={{
                            position: 'absolute', top: -5, right: -5,
                            width: 18, height: 18, borderRadius: '50%',
                            background: 'var(--red)', color: '#fff', border: 'none',
                            fontSize: 11, cursor: 'pointer', lineHeight: '18px', textAlign: 'center', padding: 0,
                          }}
                        >×</button>
                        <div style={{
                          position: 'absolute', bottom: 3, left: 3,
                          background: 'rgba(0,0,0,0.6)', color: '#fff',
                          borderRadius: 4, fontSize: 10, padding: '1px 4px', lineHeight: 1.4, fontWeight: 600,
                        }}>
                          {liveGroups.findIndex(g => g.includes(idx)) + 1}
                        </div>
                      </div>

                      {idx < photos.length - 1 && (
                        <div
                          onClick={() => toggleDivider(idx)}
                          title={dividers.has(idx) ? '點擊移除分隔' : '點擊新增分隔'}
                          style={{ width: 28, height: 64, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}
                        >
                          {dividers.has(idx) ? (
                            <div style={{ width: 2, height: 48, background: 'var(--text)', borderRadius: 2 }} />
                          ) : (
                            <div style={{
                              width: 16, height: 16, borderRadius: '50%',
                              border: '1.5px dashed var(--border)',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              color: 'var(--text-3)', fontSize: 12, lineHeight: 1,
                            }}>＋</div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                <div className="muted fs12" style={{ marginBottom: 16 }}>
                  共 {photos.length} 張照片 · {liveGroups.length} 件商品
                </div>
              </>
            )}

            <button
              className="btn"
              onClick={goToReview}
              disabled={photos.length === 0}
              style={{ width: '100%', opacity: photos.length === 0 ? 0.4 : 1 }}
            >
              確認分組（{liveGroups.length} 件）
            </button>
          </div>
        )}

        {/* ── Step 2：草稿審核（scrollable + fixed bottom） ── */}
        {step === 'review' && <>
          {/* Scrollable content area */}
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <button
                onClick={goBackToUpload}
                style={{ background: 'none', border: 'none', color: 'var(--text-3)', fontSize: 13, cursor: 'pointer', padding: 0 }}
              >← 返回調整分組</button>
              <span style={{
                fontSize: 12, padding: '3px 10px', borderRadius: 12,
                background: 'var(--surface)', border: '0.5px solid var(--border)', color: 'var(--text-2)',
              }}>
                {sellingMode === 'collection' ? '🛒 限時單' : '📦 現貨單'}
              </span>
            </div>

            {/* AI 補齊選擇列 — 還有未跑過 AI 的商品時顯示 */}
            {aiIdleCount > 0 && (
              <div style={{
                marginBottom: 12, padding: '8px 12px', borderRadius: 10,
                background: 'var(--surface)', border: '0.5px solid var(--border)',
              }}>
                <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 8 }}>
                  ✦ 勾選要 AI 補齊的商品（已勾 {aiIdleWanted} / {aiIdleCount} 件）
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => setAllAiWanted(aiIdleWanted < aiIdleCount)}
                    style={{
                      fontSize: 12, padding: '5px 12px', borderRadius: 8, cursor: 'pointer',
                      border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)',
                    }}
                  >{aiIdleWanted < aiIdleCount ? '全選' : '全不選'}</button>
                  <button
                    onClick={startAiForSelected}
                    disabled={aiIdleWanted === 0}
                    style={{
                      flex: 1, fontSize: 12, fontWeight: 600, padding: '5px 0', borderRadius: 8,
                      border: 'none', background: 'var(--text)', color: '#fff',
                      cursor: aiIdleWanted === 0 ? 'default' : 'pointer',
                      opacity: aiIdleWanted === 0 ? 0.4 : 1,
                    }}
                  >✦ 開始 AI 補齊（{aiIdleWanted} 件）</button>
                </div>
              </div>
            )}

            {sellingMode === 'collection' && collectionEnd && (
              <div style={{
                marginBottom: 12, padding: '8px 12px', borderRadius: 10,
                background: 'var(--surface)', border: '0.5px solid var(--border)',
                fontSize: 12, color: 'var(--text-2)',
              }}>
                📅 結單：{(() => {
                  const d = new Date(collectionEnd.replace('T', ' '))
                  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
                })()}
              </div>
            )}

            {/* 批量金額分配提示 — 有待決定的 AI 建議金額時顯示 */}
            {suggestedCount > 0 && (
              <div style={{
                marginBottom: 12, padding: '8px 12px', borderRadius: 10,
                background: 'var(--surface)', border: '0.5px solid var(--border)',
              }}>
                <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 8 }}>
                  💡 AI 辨識出 {suggestedCount} 件商品的金額，請選擇用途
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => applyAllSuggestedAs('shopPrice')}
                    style={{
                      flex: 1, fontSize: 12, padding: '5px 0', borderRadius: 8, cursor: 'pointer',
                      border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)',
                    }}
                  >全部→ 售價</button>
                  <button
                    onClick={() => applyAllSuggestedAs('cost')}
                    style={{
                      flex: 1, fontSize: 12, padding: '5px 0', borderRadius: 8, cursor: 'pointer',
                      border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)',
                    }}
                  >全部→ 進貨成本</button>
                </div>
              </div>
            )}

            {drafts.map((draft, i) => (
              <DraftRow
                key={i}
                index={i}
                draft={draft}
                groupIndices={reviewGroups[i] || []}
                previews={previews}
                photos={photos}
                categories={categories}
                allTags={allTags}
                optionTypes={optionTypes}
                onOptionTypesChange={setOptionTypes}
                sellingMode={sellingMode}
                existingSources={existingSources}
                onUpdate={updates => updateDraft(i, updates)}
                onRerunAi={() => runAiForGroup(i, reviewGroups[i], draft.aiSelected, draft.aiOnly, categories, allTags)}
                onApplySuggestedAs={field => {
                  const d = draft
                  if (!d.aiSuggestedPrice) return
                  if (field === 'shopPrice') updateDraft(i, { shopPrice: d.shopPrice || d.aiSuggestedPrice, aiSuggestedPrice: null })
                  else updateDraft(i, { cost: d.aiSuggestedPrice, currency: d.aiSuggestedCurrency, aiSuggestedPrice: null })
                }}
                onApplyAllSuggestedAs={applyAllSuggestedAs}
                onLightbox={setLightboxUrl}
                onHoverEnter={handleMouseEnter}
                onHoverLeave={() => setHoverInfo(null)}
                onTouchStart={handleTouchStart}
                onTouchEnd={handleTouchEnd}
              />
            ))}
          </div>

          {/* Fixed bottom bar — flex-shrink: 0 讓它永遠固定在底部 */}
          <div style={{
            flexShrink: 0,
            borderTop: '1px solid var(--border)',
            padding: '12px 0',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <span className="muted fs13" style={{ whiteSpace: 'nowrap' }}>
                已確認 {confirmedCount} / {drafts.length} 件
              </span>
              <button
                className="btn"
                onClick={submitAll}
                disabled={saving || confirmedCount === 0}
                style={{ width: 'auto', padding: '10px 24px', flexShrink: 0, opacity: confirmedCount === 0 ? 0.4 : 1 }}
              >
                {saving ? '發布中…' : `發布 ${confirmedCount} 件`}
              </button>
            </div>
          </div>
        </>}
      </div>

      {/* 拖曳中跟隨指標的浮動縮圖 */}
      {ghost && (
        <div style={{ position: 'fixed', left: ghost.x, top: ghost.y, zIndex: 10001, pointerEvents: 'none', transform: 'translate(-50%, -50%) scale(1.08)', opacity: 0.92 }}>
          <img src={ghost.url} style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 8, boxShadow: '0 6px 22px rgba(0,0,0,0.4)', display: 'block' }} />
        </div>
      )}

      {/* Hover 大圖（桌面） */}
      {hoverInfo && (
        <div style={{ position: 'fixed', left: hoverInfo.x, top: hoverInfo.y, zIndex: 9999, pointerEvents: 'none' }}>
          <img src={hoverInfo.url} style={{ width: 200, height: 200, objectFit: 'cover', borderRadius: 10, boxShadow: '0 4px 20px rgba(0,0,0,0.3)', display: 'block' }} />
        </div>
      )}

      {/* Lightbox */}
      {lightboxUrl && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.88)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setLightboxUrl(null)}
        >
          <img src={lightboxUrl} style={{ maxWidth: '92vw', maxHeight: '88vh', objectFit: 'contain', borderRadius: 8 }} />
        </div>
      )}
    </div>
  )
}

// ── 草稿列 ─────────────────────────────────────────────────────────────
function DraftRow({ index, draft, groupIndices, previews, photos, categories, allTags, optionTypes, onOptionTypesChange, sellingMode, existingSources, onUpdate, onRerunAi, onApplySuggestedAs, onApplyAllSuggestedAs, onLightbox, onHoverEnter, onHoverLeave, onTouchStart, onTouchEnd }) {
  const catOptions = categories.map(c => ({ value: String(c.id), label: c.name }))
  const canConfirm = draft.name.trim() && draft.shopPrice
  const selectionChanged = useRef(false)

  function toggleAiSelect(localIdx) {
    const cur = draft.aiSelected
    let next
    if (cur.includes(localIdx)) {
      next = cur.filter(i => i !== localIdx)
    } else {
      if (cur.length >= 3) return
      next = [...cur, localIdx]
    }
    onUpdate({ aiSelected: next })
    selectionChanged.current = true
  }

  function toggleAiOnly(localIdx) {
    const on = !draft.aiOnly.includes(localIdx)
    const nextOnly = on ? [...draft.aiOnly, localIdx] : draft.aiOnly.filter(i => i !== localIdx)
    let nextSelected = draft.aiSelected
    if (on && !nextSelected.includes(localIdx) && nextSelected.length < 3)
      nextSelected = [...nextSelected, localIdx]
    onUpdate({ aiOnly: nextOnly, aiSelected: nextSelected })
    selectionChanged.current = true
  }

  const statusChip = (() => {
    if (draft.aiStatus === 'loading') return { label: 'AI 補齊中…', color: 'var(--text-3)' }
    if (draft.aiStatus === 'error') return { label: 'AI 失敗', color: 'var(--red)' }
    if (draft.aiStatus === 'done') return { label: 'AI 已補齊', color: 'var(--green, #27ae60)' }
    return null
  })()

  return (
    <div className="card" style={{ marginBottom: 12, padding: 14 }}>

      {/* ── 標題列 ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>商品 {index + 1}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {draft.aiStatus === 'idle' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text-2)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={draft.aiWanted}
                onChange={e => onUpdate({ aiWanted: e.target.checked })}
                style={{ width: 14, height: 14, accentColor: 'var(--text)' }}
              />
              AI 補齊
            </label>
          )}
          {statusChip && (
            <span style={{ fontSize: 12, color: statusChip.color }}>{statusChip.label}</span>
          )}
          {(draft.aiStatus === 'done' || draft.aiStatus === 'error') && (
            <button
              onClick={() => { selectionChanged.current = false; onRerunAi() }}
              style={{
                fontSize: 11, padding: '2px 8px', borderRadius: 10,
                border: '1px solid var(--border)', background: 'transparent',
                color: 'var(--text-3)', cursor: 'pointer',
              }}
            >重新補齊</button>
          )}
          {draft.confirmed && <span className="badge badge-ok">✓</span>}
        </div>
      </div>

      {/* ── 照片列 ── */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 6 }}>
          點選照片送 AI 推論（最多 3 張）；長按預覽
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {groupIndices.map((globalIdx, localIdx) => {
            const isAiSelected = draft.aiSelected.includes(localIdx)
            const isAiOnly = draft.aiOnly.includes(localIdx)
            return (
              <div key={localIdx} style={{ position: 'relative', cursor: 'pointer' }}>
                <img
                  src={previews[globalIdx]}
                  style={{
                    width: 64, height: 64, objectFit: 'cover', borderRadius: 8, display: 'block',
                    border: isAiSelected ? '2.5px solid var(--text)' : '2.5px solid transparent',
                    opacity: isAiOnly ? 0.65 : 1,
                    boxSizing: 'border-box',
                  }}
                  onClick={() => toggleAiSelect(localIdx)}
                  onMouseEnter={e => onHoverEnter(e, previews[globalIdx])}
                  onMouseLeave={onHoverLeave}
                  onTouchStart={() => onTouchStart(previews[globalIdx])}
                  onTouchEnd={onTouchEnd}
                  onTouchMove={onTouchEnd}
                />
                {isAiSelected && (
                  <div style={{
                    position: 'absolute', top: 3, left: 3,
                    background: 'var(--text)', color: '#fff',
                    borderRadius: 4, fontSize: 9, padding: '1px 4px', lineHeight: 1.4, fontWeight: 700,
                  }}>AI</div>
                )}
                <button
                  onClick={e => { e.stopPropagation(); onLightbox(previews[globalIdx]) }}
                  style={{
                    position: 'absolute', bottom: 3, right: 3,
                    width: 18, height: 18, borderRadius: 4,
                    background: 'rgba(0,0,0,0.55)', color: '#fff', border: 'none',
                    fontSize: 10, cursor: 'pointer', lineHeight: '18px', textAlign: 'center', padding: 0,
                  }}
                >⤢</button>
                <button
                  onClick={e => { e.stopPropagation(); toggleAiOnly(localIdx) }}
                  title={isAiOnly ? '取消僅辨識（恢復上架）' : '標記僅辨識（不上架此張）'}
                  style={{
                    position: 'absolute', top: 3, right: 3,
                    width: 18, height: 18, borderRadius: 4,
                    background: isAiOnly ? 'var(--amber, #e67e22)' : 'rgba(0,0,0,0.45)',
                    color: '#fff', border: 'none',
                    fontSize: 9, cursor: 'pointer', lineHeight: '18px', textAlign: 'center', padding: 0,
                  }}
                >標</button>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── 名稱 ── */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>商品名稱（必填）</div>
        <input
          className="form-input"
          placeholder="AI 補齊中，或手動填寫…"
          value={draft.name}
          onChange={e => onUpdate({ name: e.target.value })}
        />
      </div>

      {/* ── 售價 + 進貨成本 + 幣別（同一 row）── */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'flex-end' }}>
        <div style={{ flex: '0 0 36%', minWidth: 0 }}>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>售價 NT$（必填）</div>
          <input
            className="form-input"
            type="number"
            placeholder="0"
            value={draft.shopPrice}
            onChange={e => onUpdate({ shopPrice: e.target.value })}
          />
        </div>
        <div style={{ flex: '0 0 36%', minWidth: 0 }}>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>進貨成本</div>
          <input
            className="form-input"
            type="number"
            placeholder="0"
            value={draft.cost}
            onChange={e => onUpdate({ cost: e.target.value })}
          />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>幣別</div>
          <select
            className="form-select"
            value={draft.currency}
            onChange={e => onUpdate({ currency: e.target.value })}
          >
            {SUPPORTED_CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>

      {/* AI 辨識金額歸屬選擇 */}
      {draft.aiSuggestedPrice && (
        <div style={{
          marginBottom: 10, padding: '8px 10px', borderRadius: 8,
          background: 'var(--surface)', border: '0.5px solid var(--border)',
        }}>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>
            AI 辨識金額：{Number(draft.aiSuggestedPrice).toLocaleString()} {draft.aiSuggestedCurrency}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={() => onApplySuggestedAs('shopPrice')}
              style={{
                flex: 1, fontSize: 11, padding: '4px 0', borderRadius: 6, cursor: 'pointer',
                border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)',
              }}
            >→ 此商品售價</button>
            <button
              onClick={() => onApplySuggestedAs('cost')}
              style={{
                flex: 1, fontSize: 11, padding: '4px 0', borderRadius: 6, cursor: 'pointer',
                border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)',
              }}
            >→ 此商品成本</button>
            <button
              onClick={() => onApplyAllSuggestedAs('shopPrice')}
              style={{
                fontSize: 11, padding: '4px 8px', borderRadius: 6, cursor: 'pointer',
                border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-3)',
                whiteSpace: 'nowrap',
              }}
            >全部→售價</button>
          </div>
        </div>
      )}

      {/* ── 現貨庫存（有規格時由規格加總，於「更多欄位」編輯）── */}
      {sellingMode === 'stock' && (
        draft.hasVariants && draft.variants.length > 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 10 }}>
            庫存由規格加總：{draft.variants.reduce((s, v) => s + (v.stock || 0), 0)} 個（{draft.variants.length} 種規格）
          </div>
        ) : (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>庫存數量</div>
            <input
              className="form-input"
              type="number"
              placeholder="0"
              value={draft.quantity}
              onChange={e => onUpdate({ quantity: e.target.value })}
              style={{ width: 120 }}
            />
          </div>
        )
      )}

      {/* ── 展開的進階欄位（規格 / 品牌來源 / 分類 / 描述 / 標籤）── */}
      {draft.expanded && (
        <div style={{ borderTop: '0.5px solid var(--border)', paddingTop: 12, marginBottom: 10 }}>

          {/* 商品規格 */}
          {optionTypes.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: draft.hasVariants ? 10 : 0 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)' }}>商品規格</span>
                <div
                  onClick={() => {
                    if (draft.hasVariants) onUpdate({ hasVariants: false, selectedTypes: {}, selectedValues: {}, variants: [] })
                    else onUpdate({ hasVariants: true })
                  }}
                  style={{
                    width: 44, height: 26, borderRadius: 13, cursor: 'pointer', transition: 'background .2s',
                    background: draft.hasVariants ? 'var(--green, #27ae60)' : 'var(--border)',
                    position: 'relative',
                  }}
                >
                  <div style={{
                    width: 20, height: 20, borderRadius: '50%', background: '#fff',
                    position: 'absolute', top: 3, transition: 'left .2s',
                    left: draft.hasVariants ? 21 : 3,
                  }} />
                </div>
              </div>
              {draft.hasVariants && (
                <VariantEditor
                  optionTypes={optionTypes}
                  onOptionTypesChange={onOptionTypesChange}
                  selectedTypes={draft.selectedTypes}
                  selectedValues={draft.selectedValues}
                  variants={draft.variants}
                  onChange={onUpdate}
                  showStock={sellingMode === 'stock'}
                  basePrice={draft.shopPrice}
                  baseCost={draft.cost}
                  currency={draft.currency}
                />
              )}
            </div>
          )}

          {/* 品牌來源 */}
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>品牌來源</div>
            {draft.sourceSelectMode ? (
              <CustomSelect
                label="— 選擇來源 —"
                value={draft.source || null}
                options={[
                  ...existingSources.map(s => ({ value: s, label: s })),
                  { value: '__custom__', label: '＋ 自訂來源' },
                ]}
                onChange={v => {
                  if (v === '__custom__') { onUpdate({ sourceSelectMode: false, source: '' }) }
                  else { onUpdate({ source: v || '', sourceSelectMode: false }) }
                }}
                allowClear={false}
              />
            ) : (
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="form-input"
                  style={{ flex: 1 }}
                  placeholder="例：UNIQLO、GU"
                  value={draft.source}
                  onChange={e => onUpdate({ source: e.target.value })}
                />
                {existingSources.length > 0 && (
                  <button
                    type="button"
                    className="btn btn-outline"
                    style={{ width: 'auto', padding: '0 14px', fontSize: 13 }}
                    onClick={() => onUpdate({ sourceSelectMode: true })}
                  >選擇</button>
                )}
              </div>
            )}
          </div>

          {/* 分類 */}
          {catOptions.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>分類</div>
              <CustomSelect
                options={catOptions}
                value={draft.categoryId}
                onChange={v => onUpdate({ categoryId: v })}
                placeholder="— 無分類 —"
              />
            </div>
          )}

          {/* 描述 */}
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>商品描述</div>
            <textarea
              className="form-input"
              placeholder="AI 補齊的描述，可直接修改"
              value={draft.descZh}
              onChange={e => onUpdate({ descZh: e.target.value })}
              rows={3}
              style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
            />
          </div>

          {/* 標籤 */}
          {allTags.length > 0 && (
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 6 }}>標籤</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {allTags.map(tag => {
                  const on = draft.tagIds.includes(tag.id)
                  return (
                    <button
                      key={tag.id}
                      onClick={() => onUpdate({ tagIds: on ? draft.tagIds.filter(id => id !== tag.id) : [...draft.tagIds, tag.id] })}
                      style={{
                        padding: '4px 12px', borderRadius: 16, fontSize: 12,
                        border: '1px solid var(--border)',
                        background: on ? 'var(--text)' : 'transparent',
                        color: on ? '#fff' : 'var(--text)',
                        cursor: 'pointer',
                      }}
                    >{tag.name}</button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── 操作按鈕 ── */}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={() => onUpdate({ expanded: !draft.expanded })}
          className="btn btn-outline"
          style={{ flex: 1, fontSize: 13, padding: '8px 0' }}
        >
          {draft.expanded ? '收起 ▲' : '規格／更多欄位 ▼'}
        </button>
        <button
          onClick={() => canConfirm && onUpdate({ confirmed: !draft.confirmed })}
          className="btn"
          style={{
            flex: 1, fontSize: 13, padding: '8px 0',
            opacity: canConfirm ? 1 : 0.4,
            background: draft.confirmed ? 'var(--green, #27ae60)' : undefined,
            cursor: canConfirm ? 'pointer' : 'default',
          }}
        >
          {draft.confirmed ? '✓ 已確認' : '確認'}
        </button>
      </div>
    </div>
  )
}
