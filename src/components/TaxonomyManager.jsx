import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { Pill } from './MenuPopover'
import CustomSelect from './CustomSelect'

// 商城管理 › 分類/標籤/規格/選單 子分頁。
// 分類：兩層（大分類→子分類）、拖曳排序、上下架（active，下架＝商城選單隱藏整個子樹）。
// 標籤：平面清單、拖曳排序、使用數統計。
// 規格：類型＋選項值。刻意不提供改名——product_variants.options 以「名稱」儲存，
//       改名會讓既有 SKU 斷鏈（與改版前行為一致），要改名請刪除重建。
// 選單：商城導覽選單設定，存 stores.settings.menu（JSON，無獨立資料表）。
//       一份有序清單混排「群組項」（分類/品牌/標籤，可開關）與「置頂項」（特定分類/
//       品牌/標籤直接放選單第一層）。商城端解析見 shop/src/lib/menu.js，兩邊 schema 需同步。
// 桌機（≥768px）雙欄；手機為「列表→點入詳情」。拖曳排序僅桌機（HTML5 DnD 不支援觸控）。

const GROUP_LABELS = { categories: '分類', brands: '品牌', tags: '標籤' }
const PIN_TYPE_LABELS = { category: '分類', brand: '品牌', tag: '標籤' }

// settings.menu 正規化：三個群組項一定要在（舊資料/未設定時補齊，預設開啟）
function normalizeMenu(menu) {
  const base = Array.isArray(menu) ? [...menu] : []
  for (const key of Object.keys(GROUP_LABELS)) {
    if (!base.some(i => i.type === 'group' && i.key === key)) base.push({ type: 'group', key, enabled: true })
  }
  return base
}

// ── 小圖示（不引外部 icon 套件） ─────────────────
const Icon = {
  grip: <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>,
  pencil: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5z"/></svg>,
  trash: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>,
  chevRight: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6"/></svg>,
  back: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>,
  plus: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  more: <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>,
}

function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const fn = e => setMobile(e.matches)
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  }, [])
  return mobile
}

function reorder(list, from, to) {
  const r = [...list]
  const [x] = r.splice(from, 1)
  r.splice(to, 0, x)
  return r
}

function Toggle({ checked, onChange, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled}
      onClick={e => { e.stopPropagation(); onChange() }}
      className="tx-toggle" style={{ background: checked ? 'var(--green, #2f9e44)' : 'var(--border)' }}>
      <span className="tx-toggle-thumb" style={{ transform: checked ? 'translateX(15px)' : 'translateX(0)' }} />
    </button>
  )
}

// 名稱編輯彈窗。showEn = 顯示英文名稱欄（分類/標籤要雙語，規格不用）。
// 以 key 重新掛載確保 initial 正確（呼叫端負責給 key）。
function NameDialog({ title, initName = '', initNameEn = '', showEn = true, nameLabel = '中文名稱', placeholder = '', onSave, onCancel }) {
  const [name, setName] = useState(initName)
  const [nameEn, setNameEn] = useState(initNameEn)
  const save = () => { if (name.trim()) onSave(name.trim(), nameEn.trim()) }
  return (
    <div className="tx-modal-overlay" onClick={onCancel}>
      <div className="tx-modal" onClick={e => e.stopPropagation()}>
        <div className="fw600 fs15" style={{ marginBottom: 14 }}>{title}</div>
        <label className="form-label fs12">{nameLabel} *</label>
        <input autoFocus className="form-input" style={{ width: '100%', marginBottom: 12 }} placeholder={placeholder}
          value={name} onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && save()} />
        {showEn && (
          <>
            <label className="form-label fs12">英文名稱</label>
            <input className="form-input" style={{ width: '100%', marginBottom: 12 }}
              value={nameEn} onChange={e => setNameEn(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && save()} />
          </>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
          <button className="btn btn-outline" onClick={onCancel} style={{ marginBottom: 0 }}>取消</button>
          <button className="btn" onClick={save} disabled={!name.trim()} style={{ marginBottom: 0, opacity: name.trim() ? 1 : 0.4 }}>儲存</button>
        </div>
      </div>
    </div>
  )
}

function ConfirmDialog({ title, body, onConfirm, onCancel }) {
  return (
    <div className="tx-modal-overlay" onClick={onCancel}>
      <div className="tx-modal" onClick={e => e.stopPropagation()}>
        <div className="fw600 fs15" style={{ marginBottom: 10 }}>{title}</div>
        <div className="fs13" style={{ color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 16 }}>{body}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-outline" onClick={onCancel} style={{ marginBottom: 0 }}>取消</button>
          <button className="btn" onClick={onConfirm} style={{ marginBottom: 0, background: 'var(--red)' }}>刪除</button>
        </div>
      </div>
    </div>
  )
}

// 置頂項目新增彈窗：選型別（分類/品牌/標籤）→ 選對象
function PinDialog({ categories, brands, tags, existing, onSave, onCancel }) {
  const [ptype, setPtype] = useState('category')
  const [ref, setRef] = useState(null)
  const options = ptype === 'category'
    ? categories.map(c => {
        const parent = c.parent_id ? categories.find(p => p.id === c.parent_id) : null
        return { value: String(c.id), label: (parent ? `${parent.name} › ` : '') + c.name }
      })
    : ptype === 'brand'
      ? brands.map(b => ({ value: b, label: b }))
      : tags.map(t => ({ value: String(t.id), label: t.name }))
  function save() {
    if (!ref) return
    const item = ptype === 'brand' ? { type: 'brand', value: ref } : { type: ptype, id: Number(ref) }
    const dup = existing.some(i => i.type === item.type && (i.type === 'brand' ? i.value === item.value : i.id === item.id))
    if (dup) { alert('這個項目已經在選單裡了'); return }
    onSave(item)
  }
  return (
    <div className="tx-modal-overlay" onClick={onCancel}>
      <div className="tx-modal" onClick={e => e.stopPropagation()}>
        <div className="fw600 fs15" style={{ marginBottom: 14 }}>新增置頂項目</div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          {Object.entries(PIN_TYPE_LABELS).map(([k, label]) => (
            <Pill key={k} active={ptype === k} onClick={() => { setPtype(k); setRef(null) }}>{label}</Pill>
          ))}
        </div>
        {options.length === 0
          ? <div className="muted fs13" style={{ padding: '8px 0' }}>目前沒有可選的{PIN_TYPE_LABELS[ptype]}</div>
          : <CustomSelect label="— 選擇對象 —" value={ref} options={options} onChange={setRef} />}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="btn btn-outline" onClick={onCancel} style={{ marginBottom: 0 }}>取消</button>
          <button className="btn" onClick={save} disabled={!ref} style={{ marginBottom: 0, opacity: ref ? 1 : 0.4 }}>加入選單</button>
        </div>
      </div>
    </div>
  )
}

function EmptyState({ title, hint }) {
  return (
    <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-3)' }}>
      <div className="fw600 fs15" style={{ color: 'var(--text-2)', marginBottom: 4 }}>{title}</div>
      <div className="fs12">{hint}</div>
    </div>
  )
}

export default function TaxonomyManager({ storeId, can, syncShop }) {
  const isMobile = useIsMobile()
  const [sub, setSub] = useState('cats')          // cats | tags | specs
  const [loading, setLoading] = useState(true)
  const [categories, setCategories] = useState([])
  const [tags, setTags] = useState([])
  const [optionTypes, setOptionTypes] = useState([])
  const [catCounts, setCatCounts] = useState({})   // { category_id: 商品數 }
  const [tagCounts, setTagCounts] = useState({})   // { tag_id: 商品數 }
  const [menu, setMenu] = useState([])             // 商城選單設定（settings.menu）
  const [storeSettings, setStoreSettings] = useState({}) // stores.settings（整包，存回時合併）
  const [brands, setBrands] = useState([])         // 置頂項候選：商品採購來源 distinct
  const [selCatId, setSelCatId] = useState(null)   // 桌機右欄 / 手機詳情
  const [selSpecId, setSelSpecId] = useState(null)
  const [mobileDetail, setMobileDetail] = useState(false) // 手機是否在詳情畫面
  const [dialog, setDialog] = useState(null)
  const [openMenu, setOpenMenu] = useState(null)   // 手機 ⋯ 選單開啟的項目 id
  const [catSearch, setCatSearch] = useState('')
  const [tagSortUsage, setTagSortUsage] = useState(false)
  const [newValInputs, setNewValInputs] = useState({}) // { typeId: 輸入中文字 }
  const [toast, setToast] = useState('')
  const toastTimer = useRef(null)
  const dragIdx = useRef(null)

  function flash(msg) {
    setToast(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 1800)
  }

  useEffect(() => { fetchAll() }, [storeId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchAll() {
    const [{ data: cats }, { data: tgs }, { data: opts }, { data: prods }, { data: ptags }, { data: storeRow }] = await Promise.all([
      supabase.from('categories').select('*').eq('store_id', storeId).order('sort_order').order('name'),
      supabase.from('tags').select('*').eq('store_id', storeId).order('sort_order').order('name'),
      supabase.from('variant_option_types').select('*, variant_option_values(id, value, sort_order)').eq('store_id', storeId).order('sort_order').order('name'),
      supabase.from('products').select('id, category_id, source').eq('store_id', storeId),
      supabase.from('product_tags').select('tag_id, products!inner(store_id)').eq('products.store_id', storeId),
      supabase.from('stores').select('settings').eq('id', storeId).maybeSingle(),
    ])
    setCategories(cats || [])
    setTags(tgs || [])
    setOptionTypes(opts || [])
    setBrands([...new Set((prods || []).map(p => p.source).filter(Boolean))].sort())
    setStoreSettings(storeRow?.settings || {})
    setMenu(normalizeMenu(storeRow?.settings?.menu))
    const cc = {}
    ;(prods || []).forEach(p => { if (p.category_id) cc[p.category_id] = (cc[p.category_id] || 0) + 1 })
    setCatCounts(cc)
    const tc = {}
    ;(ptags || []).forEach(pt => { tc[pt.tag_id] = (tc[pt.tag_id] || 0) + 1 })
    setTagCounts(tc)
    setLoading(false)
  }

  // 每次資料異動：重抓 + 清商城快取（分類/標籤/規格都是商城顯示的資料來源）
  async function mutated(msg) {
    await fetchAll()
    syncShop()
    if (msg) flash(msg)
  }

  // ── 分類資料 ──
  const topCats = categories.filter(c => !c.parent_id)
  const childrenOf = id => categories.filter(c => c.parent_id === id)
  const selCat = categories.find(c => c.id === selCatId) || (!isMobile ? topCats[0] : null)
  // 大分類商品數 = 自身 + 全部子分類
  const catTotal = cat => (catCounts[cat.id] || 0) + childrenOf(cat.id).reduce((s, k) => s + (catCounts[k.id] || 0), 0)

  async function addCategory(name, nameEn, parentId) {
    const level = parentId ? childrenOf(parentId) : topCats
    const { error } = await supabase.from('categories').insert({
      name, name_en: nameEn || null, parent_id: parentId || null,
      sort_order: level.length, store_id: storeId,
    })
    if (error) { alert('新增失敗：' + error.message); return }
    setDialog(null)
    mutated(parentId ? '子分類已新增' : '大分類已新增')
  }
  async function renameCategory(id, name, nameEn) {
    await supabase.from('categories').update({ name, name_en: nameEn || null }).eq('id', id)
    setDialog(null)
    mutated('分類已更新')
  }
  async function toggleCatActive(cat) {
    await supabase.from('categories').update({ active: !cat.active }).eq('id', cat.id)
    mutated(cat.active ? '已下架（商城選單隱藏）' : '已上架')
  }
  async function deleteCategory(cat) {
    await supabase.from('categories').delete().eq('id', cat.id)
    if (selCatId === cat.id) setSelCatId(null)
    setDialog(null)
    mutated('分類已刪除')
  }
  // 同層拖曳排序（頂層或某父分類的子層），寫回該層每筆的 sort_order
  async function persistCatOrder(newLevel) {
    const orderMap = new Map(newLevel.map((c, i) => [c.id, i]))
    setCategories(prev => {
      const next = prev.map(c => orderMap.has(c.id) ? { ...c, sort_order: orderMap.get(c.id) } : c)
      next.sort((a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name))
      return next
    })
    await Promise.all(newLevel.map((c, i) => supabase.from('categories').update({ sort_order: i }).eq('id', c.id)))
    syncShop()
    flash('排序已更新')
  }

  // ── 標籤 ──
  async function addTag(name, nameEn) {
    const { error } = await supabase.from('tags').insert({ name, name_en: nameEn || null, sort_order: tags.length, store_id: storeId })
    if (error) { alert('新增失敗：' + error.message); return }
    setDialog(null)
    mutated('標籤已新增')
  }
  async function renameTag(id, name, nameEn) {
    await supabase.from('tags').update({ name, name_en: nameEn || null }).eq('id', id)
    setDialog(null)
    mutated('標籤已更新')
  }
  async function deleteTag(id) {
    await supabase.from('tags').delete().eq('id', id)
    setDialog(null)
    mutated('標籤已刪除')
  }
  async function persistTagOrder(newList) {
    setTags(newList.map((t, i) => ({ ...t, sort_order: i })))
    await Promise.all(newList.map((t, i) => supabase.from('tags').update({ sort_order: i }).eq('id', t.id)))
    syncShop()
    flash('排序已更新')
  }

  // ── 規格 ──
  const selSpec = optionTypes.find(s => s.id === selSpecId) || (!isMobile ? optionTypes[0] : null)
  async function addSpec(name) {
    const { error } = await supabase.from('variant_option_types').insert({ name, sort_order: optionTypes.length, store_id: storeId })
    if (error) { alert('建立失敗：' + error.message); return }
    setDialog(null)
    mutated('規格類型已新增')
  }
  async function deleteSpec(id) {
    await supabase.from('variant_option_types').delete().eq('id', id)
    if (selSpecId === id) setSelSpecId(null)
    setDialog(null)
    mutated('規格類型已刪除')
  }
  async function addValue(typeId) {
    const val = (newValInputs[typeId] || '').trim()
    if (!val) return
    const type = optionTypes.find(t => t.id === typeId)
    const { error } = await supabase.from('variant_option_values').insert({
      option_type_id: typeId, value: val, sort_order: (type?.variant_option_values || []).length,
    })
    if (error) { alert('新增失敗：' + error.message); return }
    setNewValInputs(f => ({ ...f, [typeId]: '' }))
    mutated('選項值已新增')
  }
  async function deleteValue(valId) {
    await supabase.from('variant_option_values').delete().eq('id', valId)
    setDialog(null)
    mutated('選項值已刪除')
  }
  async function persistSpecOrder(newList) {
    setOptionTypes(newList.map((s, i) => ({ ...s, sort_order: i })))
    await Promise.all(newList.map((s, i) => supabase.from('variant_option_types').update({ sort_order: i }).eq('id', s.id)))
    syncShop()
    flash('排序已更新')
  }

  // ── 選單（stores.settings.menu）──
  // 存檔前重抓最新 settings 再合併，避免蓋掉店家設定頁同時段改的其他欄位
  async function saveMenu(next, msg = '選單已更新') {
    setMenu(next)
    const { data: row } = await supabase.from('stores').select('settings').eq('id', storeId).maybeSingle()
    const merged = { ...(row?.settings || storeSettings), menu: next }
    const { error } = await supabase.from('stores').update({ settings: merged }).eq('id', storeId)
    if (error) { alert('儲存失敗：' + error.message); return }
    setStoreSettings(merged)
    syncShop()
    flash(msg)
  }
  const toggleGroup = key => saveMenu(menu.map(i =>
    i.type === 'group' && i.key === key ? { ...i, enabled: !i.enabled } : i))
  const removePin = idx => saveMenu(menu.filter((_, i) => i !== idx), '置頂項目已移除')
  const addPin = item => { setDialog(null); saveMenu([item, ...menu], '置頂項目已新增') }

  // 置頂項目顯示名稱（即時解析；對象被刪/下架給提示，商城端會自動略過不顯示）
  function pinLabel(item) {
    if (item.type === 'category') {
      const c = categories.find(c => c.id === item.id)
      return c ? c.name + (c.active ? '' : '（已下架，商城不顯示）') : '（分類已刪除，商城不顯示）'
    }
    if (item.type === 'brand') return brands.includes(item.value) ? item.value : `${item.value}（無商品，商城不顯示）`
    if (item.type === 'tag') {
      const t = tags.find(t => t.id === item.id)
      return t ? t.name : '（標籤已刪除，商城不顯示）'
    }
    return '?'
  }

  // 拖曳（桌機限定；搜尋中停用避免索引錯位）
  const canDrag = can('edit') && !isMobile
  function dragProps(list, index, persist, disabled) {
    if (!canDrag || disabled) return {}
    return {
      draggable: true,
      onDragStart: () => { dragIdx.current = index },
      onDragOver: e => e.preventDefault(),
      onDrop: () => {
        if (dragIdx.current === null || dragIdx.current === index) { dragIdx.current = null; return }
        persist(reorder(list, dragIdx.current, index))
        dragIdx.current = null
      },
    }
  }

  function switchSub(key) {
    setSub(key)
    setMobileDetail(false)
    setOpenMenu(null)
    setDialog(null)
  }

  if (loading) return <div className="muted fs13">載入中…</div>

  // ── 分類列（桌機左欄/手機列表共用邏輯，樣式各自） ──
  const filteredTop = topCats.filter(c =>
    c.name.toLowerCase().includes(catSearch.toLowerCase()) ||
    (c.name_en || '').toLowerCase().includes(catSearch.toLowerCase()))

  const catDeleteBody = cat => {
    const kids = childrenOf(cat.id)
    const total = catTotal(cat)
    const parts = []
    if (total > 0) parts.push(`底下還有 ${total} 件商品，刪除後將變成未分類`)
    if (kids.length > 0) parts.push(`${kids.length} 個子分類會升為頂層`)
    return parts.length ? `「${cat.name}」${parts.join('；')}。確定要刪除嗎？` : `確定要刪除「${cat.name}」嗎？此動作無法復原。`
  }

  // ═══════════ 桌機版 ═══════════
  const catsDesktop = (
    <div className="tx-two-col">
      <div className="tx-pane-left">
        <input className="form-input" placeholder="搜尋大分類…" value={catSearch}
          onChange={e => setCatSearch(e.target.value)} style={{ width: '100%', marginBottom: 10 }} />
        <div className="tx-list">
          {filteredTop.length === 0 && <EmptyState title="找不到分類" hint={catSearch ? '試試其他關鍵字' : '點下方按鈕新增第一個大分類'} />}
          {filteredTop.map((cat, idx) => (
            <div key={cat.id}
              className={`tx-row${selCat?.id === cat.id ? ' tx-row-active' : ''}${!cat.active ? ' tx-row-disabled' : ''}`}
              onClick={() => setSelCatId(cat.id)}
              {...dragProps(filteredTop, idx, persistCatOrder, !!catSearch)}>
              {canDrag && !catSearch && <span className="tx-grip">{Icon.grip}</span>}
              <span className="tx-name">{cat.name}{cat.name_en ? <span className="muted fs12"> / {cat.name_en}</span> : null}</span>
              <span className="tx-count">{catTotal(cat)} 件</span>
              {can('edit') && <Toggle checked={cat.active} onChange={() => toggleCatActive(cat)} />}
              {can('edit') && <button className="tx-icon-btn" onClick={e => { e.stopPropagation(); setDialog({ type: 'edit-cat', target: cat }) }}>{Icon.pencil}</button>}
              {can('delete') && <button className="tx-icon-btn tx-icon-btn-danger" onClick={e => { e.stopPropagation(); setDialog({ type: 'del-cat', target: cat }) }}>{Icon.trash}</button>}
            </div>
          ))}
        </div>
        {can('add') && <button className="tx-add-btn" onClick={() => setDialog({ type: 'add-cat' })}>＋ 新增大分類</button>}
      </div>
      <div className="tx-pane-right">
        {!selCat ? <EmptyState title="請選擇一個大分類" hint="從左側清單點選以管理子分類" /> : (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <div className="fw600 fs15">子分類管理 <span className="muted">·</span> {selCat.name}</div>
              {can('add') && <button className="btn" style={{ marginBottom: 0, fontSize: 13, padding: '8px 14px' }} onClick={() => setDialog({ type: 'add-sub', parentId: selCat.id })}>＋ 新增子分類</button>}
            </div>
            {childrenOf(selCat.id).length === 0 ? (
              <EmptyState title="這個分類還沒有子分類" hint="新增子分類後，商城選單會顯示成兩層" />
            ) : (
              <div className="tx-list" style={{ flex: 'unset' }}>
                {childrenOf(selCat.id).map((sc, idx) => (
                  <div key={sc.id} className={`tx-row${!sc.active ? ' tx-row-disabled' : ''}`} style={{ cursor: 'default' }}
                    {...dragProps(childrenOf(selCat.id), idx, persistCatOrder)}>
                    {canDrag && <span className="tx-grip">{Icon.grip}</span>}
                    <span className="tx-name">{sc.name}{sc.name_en ? <span className="muted fs12"> / {sc.name_en}</span> : null}</span>
                    <span className="tx-count" style={{ color: (catCounts[sc.id] || 0) === 0 ? 'var(--red)' : undefined }}>
                      {(catCounts[sc.id] || 0) === 0 ? '無商品' : `${catCounts[sc.id]} 件商品`}
                    </span>
                    {can('edit') && <Toggle checked={sc.active} onChange={() => toggleCatActive(sc)} />}
                    {can('edit') && <button className="tx-icon-btn" onClick={() => setDialog({ type: 'edit-cat', target: sc })}>{Icon.pencil}</button>}
                    {can('delete') && <button className="tx-icon-btn tx-icon-btn-danger" onClick={() => setDialog({ type: 'del-cat', target: sc })}>{Icon.trash}</button>}
                  </div>
                ))}
              </div>
            )}
            <div className="muted fs12" style={{ marginTop: 'auto', paddingTop: 14 }}>拖曳列表左側圖示可調整排序（即商城選單順序）；關閉開關＝從商城選單下架，商品仍可在全部商品瀏覽</div>
          </>
        )}
      </div>
    </div>
  )

  const tagsDesktop = (
    <div style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 14, padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 10 }}>
        <Pill active={tagSortUsage} onClick={() => setTagSortUsage(v => !v)}>依使用次數排序</Pill>
        {can('add') && <button className="btn" style={{ marginBottom: 0, fontSize: 13, padding: '8px 14px' }} onClick={() => setDialog({ type: 'add-tag' })}>＋ 新增標籤</button>}
      </div>
      {tags.length === 0 ? <EmptyState title="還沒有標籤" hint="標籤無階層，一個商品可貼多個標籤，用於跨分類篩選" /> : (
        <div className="tx-list" style={{ flex: 'unset' }}>
          {(tagSortUsage ? [...tags].sort((a, b) => (tagCounts[b.id] || 0) - (tagCounts[a.id] || 0)) : tags).map((tag, idx) => (
            <div key={tag.id} className="tx-row" style={{ cursor: 'default' }}
              {...dragProps(tags, idx, persistTagOrder, tagSortUsage)}>
              {canDrag && !tagSortUsage && <span className="tx-grip">{Icon.grip}</span>}
              <span className="tx-name">{tag.name}{tag.name_en ? <span className="muted fs12"> / {tag.name_en}</span> : null}</span>
              <span className="tx-count" style={{ color: (tagCounts[tag.id] || 0) === 0 ? 'var(--red)' : undefined }}>
                {(tagCounts[tag.id] || 0) === 0 ? '尚未使用' : `使用中 · ${tagCounts[tag.id]} 件商品`}
              </span>
              {can('edit') && <button className="tx-icon-btn" onClick={() => setDialog({ type: 'edit-tag', target: tag })}>{Icon.pencil}</button>}
              {can('delete') && <button className="tx-icon-btn tx-icon-btn-danger" onClick={() => setDialog({ type: 'del-tag', target: tag })}>{Icon.trash}</button>}
            </div>
          ))}
        </div>
      )}
      <div className="muted fs12" style={{ marginTop: 12 }}>標籤沒有階層關係，可跨分類標記商品（例：熱銷、新品）</div>
    </div>
  )

  const specValues = spec => [...(spec?.variant_option_values || [])].sort((a, b) => a.sort_order - b.sort_order)

  const specsDesktop = (
    <div className="tx-two-col">
      <div className="tx-pane-left">
        <div className="tx-list">
          {optionTypes.length === 0 && <EmptyState title="尚未建立規格類型" hint="例如「顏色」「尺寸」" />}
          {optionTypes.map((spec, idx) => (
            <div key={spec.id} className={`tx-row${selSpec?.id === spec.id ? ' tx-row-active' : ''}`}
              onClick={() => setSelSpecId(spec.id)}
              {...dragProps(optionTypes, idx, persistSpecOrder)}>
              {canDrag && <span className="tx-grip">{Icon.grip}</span>}
              <span className="tx-name">{spec.name}</span>
              <span className="tx-count">{specValues(spec).length} 個值</span>
              {can('delete') && <button className="tx-icon-btn tx-icon-btn-danger" onClick={e => { e.stopPropagation(); setDialog({ type: 'del-spec', target: spec }) }}>{Icon.trash}</button>}
            </div>
          ))}
        </div>
        {can('add') && <button className="tx-add-btn" onClick={() => setDialog({ type: 'add-spec' })}>＋ 新增規格類型</button>}
      </div>
      <div className="tx-pane-right">
        {!selSpec ? <EmptyState title="請選擇一個規格類型" hint="從左側清單點選以管理選項值" /> : (
          <>
            <div className="fw600 fs15" style={{ marginBottom: 14 }}>選項值管理 <span className="muted">·</span> {selSpec.name}</div>
            {specValues(selSpec).length === 0 ? (
              <EmptyState title="這個規格還沒有選項值" hint={`例如${selSpec.name === '顏色' ? '「黑色」「白色」' : '「S」「M」「L」'}`} />
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
                {specValues(selSpec).map(v => (
                  <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 16, padding: '5px 12px' }}>
                    <span className="fs13">{v.value}</span>
                    {can('delete') && (
                      <button onClick={() => setDialog({ type: 'del-val', target: v })} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', fontSize: 13, padding: '0 0 0 2px', lineHeight: 1 }}>×</button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {can('add') && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                <div>
                  <label className="form-label fs12">新增選項值</label>
                  <input className="form-input" style={{ width: 140 }}
                    placeholder={selSpec.name === '顏色' ? '例：黑色' : '例：S'}
                    value={newValInputs[selSpec.id] || ''}
                    onChange={e => setNewValInputs(f => ({ ...f, [selSpec.id]: e.target.value }))}
                    onKeyDown={e => e.key === 'Enter' && addValue(selSpec.id)} />
                </div>
                <button className="btn" onClick={() => addValue(selSpec.id)} style={{ fontSize: 13, padding: '9px 16px', marginBottom: 0 }}>新增</button>
              </div>
            )}
            <div className="muted fs12" style={{ marginTop: 'auto', paddingTop: 14 }}>規格與選項值不提供改名：既有 SKU 以名稱記錄規格，改名會讓已建立的規格組合失聯，需要時請刪除重建</div>
          </>
        )}
      </div>
    </div>
  )

  // ═══════════ 手機版（列表 → 點入詳情） ═══════════
  const mMenu = (id, items) => openMenu === id && (
    <div className="tx-menu">
      {items.map((it, i) => (
        <button key={i} className={it.danger ? 'tx-menu-danger' : ''} onClick={() => { setOpenMenu(null); it.onClick() }}>
          {it.icon} {it.label}
        </button>
      ))}
    </div>
  )

  const catsMobile = !mobileDetail ? (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div className="fw600 fs15">分類管理</div>
        {can('add') && <button className="tx-icon-btn" style={{ background: 'var(--text)', color: '#fff', borderRadius: 9, padding: 8 }} onClick={() => setDialog({ type: 'add-cat' })}>{Icon.plus}</button>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {topCats.length === 0 && <EmptyState title="尚未建立分類" hint="點右上角 ＋ 新增第一個大分類" />}
        {topCats.map(cat => (
          <div key={cat.id}>
            <div className={`tx-m-row${!cat.active ? ' tx-row-disabled' : ''}`} onClick={() => { setSelCatId(cat.id); setMobileDetail(true) }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="tx-m-name">{cat.name}</div>
                <div className="tx-m-sub">{catTotal(cat)} 件商品 · {childrenOf(cat.id).length} 個子分類</div>
              </div>
              {!cat.active && <span className="fs12 fw600" style={{ background: 'var(--red-bg)', color: 'var(--red)', padding: '3px 7px', borderRadius: 6, whiteSpace: 'nowrap' }}>已下架</span>}
              <span className="muted">{Icon.chevRight}</span>
              {(can('edit') || can('delete')) && (
                <button className="tx-icon-btn" onClick={e => { e.stopPropagation(); setOpenMenu(openMenu === cat.id ? null : cat.id) }}>{Icon.more}</button>
              )}
            </div>
            {mMenu(cat.id, [
              ...(can('edit') ? [
                { icon: Icon.pencil, label: '編輯名稱', onClick: () => setDialog({ type: 'edit-cat', target: cat }) },
                { icon: null, label: cat.active ? '下架分類' : '上架分類', onClick: () => toggleCatActive(cat) },
              ] : []),
              ...(can('delete') ? [{ icon: Icon.trash, label: '刪除分類', danger: true, onClick: () => setDialog({ type: 'del-cat', target: cat }) }] : []),
            ])}
          </div>
        ))}
      </div>
      <div className="muted fs12" style={{ textAlign: 'center', marginTop: 12 }}>排序調整請使用電腦版拖曳</div>
    </>
  ) : (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <button className="tx-icon-btn" onClick={() => { setMobileDetail(false); setOpenMenu(null) }}>{Icon.back}</button>
        <div className="fw600 fs15" style={{ flex: 1 }}>{selCat?.name}</div>
        {can('add') && selCat && <button className="tx-icon-btn" style={{ background: 'var(--text)', color: '#fff', borderRadius: 9, padding: 8 }} onClick={() => setDialog({ type: 'add-sub', parentId: selCat.id })}>{Icon.plus}</button>}
      </div>
      {selCat && childrenOf(selCat.id).length === 0 ? <EmptyState title="這個分類還沒有子分類" hint="點右上角 ＋ 新增子分類" /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {selCat && childrenOf(selCat.id).map(sc => (
            <div key={sc.id}>
              <div className={`tx-m-row${!sc.active ? ' tx-row-disabled' : ''}`}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="tx-m-name">{sc.name}</div>
                  <div className="tx-m-sub" style={{ color: (catCounts[sc.id] || 0) === 0 ? 'var(--red)' : undefined }}>
                    {(catCounts[sc.id] || 0) === 0 ? '無商品' : `${catCounts[sc.id]} 件商品`}
                  </div>
                </div>
                {can('edit') && <Toggle checked={sc.active} onChange={() => toggleCatActive(sc)} />}
                {(can('edit') || can('delete')) && (
                  <button className="tx-icon-btn" onClick={() => setOpenMenu(openMenu === sc.id ? null : sc.id)}>{Icon.more}</button>
                )}
              </div>
              {mMenu(sc.id, [
                ...(can('edit') ? [{ icon: Icon.pencil, label: '編輯名稱', onClick: () => setDialog({ type: 'edit-cat', target: sc }) }] : []),
                ...(can('delete') ? [{ icon: Icon.trash, label: '刪除子分類', danger: true, onClick: () => setDialog({ type: 'del-cat', target: sc }) }] : []),
              ])}
            </div>
          ))}
        </div>
      )}
    </>
  )

  const tagsMobile = (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div className="fw600 fs15">標籤管理</div>
        {can('add') && <button className="tx-icon-btn" style={{ background: 'var(--text)', color: '#fff', borderRadius: 9, padding: 8 }} onClick={() => setDialog({ type: 'add-tag' })}>{Icon.plus}</button>}
      </div>
      {tags.length === 0 ? <EmptyState title="還沒有標籤" hint="新增標籤後可套用到任何商品" /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {tags.map(tag => (
            <div key={tag.id}>
              <div className="tx-m-row">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="tx-m-name">{tag.name}</div>
                  <div className="tx-m-sub" style={{ color: (tagCounts[tag.id] || 0) === 0 ? 'var(--red)' : undefined }}>
                    {(tagCounts[tag.id] || 0) === 0 ? '尚未使用' : `使用中 · ${tagCounts[tag.id]} 件商品`}
                  </div>
                </div>
                {(can('edit') || can('delete')) && (
                  <button className="tx-icon-btn" onClick={() => setOpenMenu(openMenu === tag.id ? null : tag.id)}>{Icon.more}</button>
                )}
              </div>
              {mMenu(tag.id, [
                ...(can('edit') ? [{ icon: Icon.pencil, label: '編輯標籤', onClick: () => setDialog({ type: 'edit-tag', target: tag }) }] : []),
                ...(can('delete') ? [{ icon: Icon.trash, label: '刪除標籤', danger: true, onClick: () => setDialog({ type: 'del-tag', target: tag }) }] : []),
              ])}
            </div>
          ))}
        </div>
      )}
      <div className="muted fs12" style={{ textAlign: 'center', marginTop: 12 }}>標籤無階層，一個商品可貼多個標籤</div>
    </>
  )

  const specsMobile = !mobileDetail ? (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div className="fw600 fs15">規格管理</div>
        {can('add') && <button className="tx-icon-btn" style={{ background: 'var(--text)', color: '#fff', borderRadius: 9, padding: 8 }} onClick={() => setDialog({ type: 'add-spec' })}>{Icon.plus}</button>}
      </div>
      {optionTypes.length === 0 && <EmptyState title="尚未建立規格類型" hint="例如「顏色」「尺寸」" />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {optionTypes.map(spec => (
          <div key={spec.id}>
            <div className="tx-m-row" onClick={() => { setSelSpecId(spec.id); setMobileDetail(true) }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="tx-m-name">{spec.name}</div>
                <div className="tx-m-sub">{specValues(spec).length} 個選項值</div>
              </div>
              <span className="muted">{Icon.chevRight}</span>
              {can('delete') && (
                <button className="tx-icon-btn" onClick={e => { e.stopPropagation(); setOpenMenu(openMenu === spec.id ? null : spec.id) }}>{Icon.more}</button>
              )}
            </div>
            {mMenu(spec.id, [
              { icon: Icon.trash, label: '刪除規格', danger: true, onClick: () => setDialog({ type: 'del-spec', target: spec }) },
            ])}
          </div>
        ))}
      </div>
    </>
  ) : (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <button className="tx-icon-btn" onClick={() => setMobileDetail(false)}>{Icon.back}</button>
        <div className="fw600 fs15" style={{ flex: 1 }}>{selSpec?.name}</div>
      </div>
      {selSpec && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
            {specValues(selSpec).map(v => (
              <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 16, padding: '6px 12px' }}>
                <span className="fs13">{v.value}</span>
                {can('delete') && (
                  <button onClick={() => setDialog({ type: 'del-val', target: v })} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', fontSize: 13, padding: '0 0 0 2px', lineHeight: 1 }}>×</button>
                )}
              </div>
            ))}
            {specValues(selSpec).length === 0 && <div className="muted fs13">還沒有選項值</div>}
          </div>
          {can('add') && (
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="form-input" style={{ flex: 1 }}
                placeholder={selSpec.name === '顏色' ? '例：黑色' : '例：S'}
                value={newValInputs[selSpec.id] || ''}
                onChange={e => setNewValInputs(f => ({ ...f, [selSpec.id]: e.target.value }))}
                onKeyDown={e => e.key === 'Enter' && addValue(selSpec.id)} />
              <button className="btn" onClick={() => addValue(selSpec.id)} style={{ fontSize: 13, padding: '9px 16px', marginBottom: 0 }}>新增</button>
            </div>
          )}
        </>
      )}
    </>
  )

  return (
    <div>
      {/* 子分頁切換 */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        <Pill active={sub === 'cats'} onClick={() => switchSub('cats')}>分類</Pill>
        <Pill active={sub === 'tags'} onClick={() => switchSub('tags')}>標籤</Pill>
        <Pill active={sub === 'specs'} onClick={() => switchSub('specs')}>規格</Pill>
        <Pill active={sub === 'menu'} onClick={() => switchSub('menu')}>選單</Pill>
      </div>

      {sub === 'cats' && (isMobile ? catsMobile : catsDesktop)}
      {sub === 'tags' && (isMobile ? tagsMobile : tagsDesktop)}
      {sub === 'specs' && (isMobile ? specsMobile : specsDesktop)}
      {sub === 'menu' && (
        <div style={{ background: 'var(--surface)', border: '0.5px solid var(--border)', borderRadius: 14, padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 10 }}>
            <div className="fw600 fs15">商城選單</div>
            {can('edit') && <button className="btn" style={{ width: 'auto', marginBottom: 0, fontSize: 13, padding: '8px 14px', borderRadius: 10 }} onClick={() => setDialog({ type: 'add-pin' })}>＋ 新增置頂項目</button>}
          </div>
          <div className="muted fs12" style={{ marginBottom: 12 }}>
            由上到下＝商城選單順序（「全部商品」固定最上方）。置頂項目直接顯示在選單第一層與桌機導覽列；群組（分類/品牌/標籤）為可展開清單，可用開關隱藏。
          </div>
          <div className="tx-list" style={{ flex: 'unset' }}>
            {menu.map((item, idx) => {
              const isGroup = item.type === 'group'
              return (
                <div key={isGroup ? `g-${item.key}` : `p-${item.type}-${item.id ?? item.value}`}
                  className={`tx-row${isGroup && !item.enabled ? ' tx-row-disabled' : ''}`} style={{ cursor: 'default' }}
                  {...dragProps(menu, idx, list => saveMenu(list, '排序已更新'))}>
                  {canDrag && <span className="tx-grip">{Icon.grip}</span>}
                  <span className="tx-name">{isGroup ? GROUP_LABELS[item.key] : pinLabel(item)}</span>
                  <span className="tx-count">{isGroup ? '群組（展開清單）' : `置頂 · ${PIN_TYPE_LABELS[item.type]}`}</span>
                  {isGroup
                    ? (can('edit') && <Toggle checked={item.enabled !== false} onChange={() => toggleGroup(item.key)} />)
                    : (can('edit') && <button className="tx-icon-btn tx-icon-btn-danger" onClick={() => removePin(idx)}>{Icon.trash}</button>)}
                </div>
              )
            })}
          </div>
          <div className="muted fs12" style={{ marginTop: 12 }}>
            {isMobile ? '排序調整請使用電腦版拖曳' : '拖曳左側圖示調整順序'}；置頂對象被刪除或下架時，商城會自動略過不顯示
          </div>
        </div>
      )}

      {/* 彈窗（key 確保每次開啟重掛載、initial 正確） */}
      {dialog?.type === 'add-cat' && (
        <NameDialog key="add-cat" title="新增大分類" placeholder="例：現貨專區" onCancel={() => setDialog(null)} onSave={(n, en) => addCategory(n, en, null)} />
      )}
      {dialog?.type === 'add-sub' && (
        <NameDialog key={`add-sub-${dialog.parentId}`} title="新增子分類" placeholder="例：日本小物" onCancel={() => setDialog(null)} onSave={(n, en) => addCategory(n, en, dialog.parentId)} />
      )}
      {dialog?.type === 'edit-cat' && (
        <NameDialog key={`edit-cat-${dialog.target.id}`} title="編輯分類名稱" initName={dialog.target.name} initNameEn={dialog.target.name_en || ''} onCancel={() => setDialog(null)} onSave={(n, en) => renameCategory(dialog.target.id, n, en)} />
      )}
      {dialog?.type === 'del-cat' && (
        <ConfirmDialog title="刪除分類？" body={catDeleteBody(dialog.target)} onCancel={() => setDialog(null)} onConfirm={() => deleteCategory(dialog.target)} />
      )}
      {dialog?.type === 'add-tag' && (
        <NameDialog key="add-tag" title="新增標籤" placeholder="例：熱銷" onCancel={() => setDialog(null)} onSave={addTag} />
      )}
      {dialog?.type === 'edit-tag' && (
        <NameDialog key={`edit-tag-${dialog.target.id}`} title="編輯標籤" initName={dialog.target.name} initNameEn={dialog.target.name_en || ''} onCancel={() => setDialog(null)} onSave={(n, en) => renameTag(dialog.target.id, n, en)} />
      )}
      {dialog?.type === 'del-tag' && (
        <ConfirmDialog title="刪除標籤？"
          body={(tagCounts[dialog.target.id] || 0) > 0 ? `「${dialog.target.name}」目前用在 ${tagCounts[dialog.target.id]} 件商品上，刪除後這些商品會移除此標籤。確定要刪除嗎？` : `確定要刪除「${dialog.target.name}」嗎？`}
          onCancel={() => setDialog(null)} onConfirm={() => deleteTag(dialog.target.id)} />
      )}
      {dialog?.type === 'add-spec' && (
        <NameDialog key="add-spec" title="新增規格類型" nameLabel="名稱" placeholder="例：顏色" showEn={false} onCancel={() => setDialog(null)} onSave={n => addSpec(n)} />
      )}
      {dialog?.type === 'del-spec' && (
        <ConfirmDialog title="刪除規格類型？" body={`「${dialog.target.name}」底下所有選項值與商品規格組合將一併刪除，確定嗎？`} onCancel={() => setDialog(null)} onConfirm={() => deleteSpec(dialog.target.id)} />
      )}
      {dialog?.type === 'del-val' && (
        <ConfirmDialog title="刪除選項值？" body={`套用「${dialog.target.value}」的規格組合將受影響，確定要刪除嗎？`} onCancel={() => setDialog(null)} onConfirm={() => deleteValue(dialog.target.id)} />
      )}
      {dialog?.type === 'add-pin' && (
        <PinDialog key="add-pin" categories={categories} brands={brands} tags={tags} existing={menu} onSave={addPin} onCancel={() => setDialog(null)} />
      )}

      {toast && <div className="tx-toast">{toast}</div>}
    </div>
  )
}
