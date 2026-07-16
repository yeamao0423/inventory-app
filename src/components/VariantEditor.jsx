import { useState, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'

// 規格編輯器（快速上架 QuickListSheet / 批量上架 BulkListSheet 共用）。
// 受控元件：selectedTypes / selectedValues / variants 由父層持有——
// 批量上架的草稿卡收合再展開會 unmount，狀態放內部會遺失。
// 批次套用輸入框為暫態 UI，留在元件內部即可。
// inline 新增規格類型/值：寫入店家規格庫（與規格管理頁同步），
// insert 欄位與 sort_order 比照 TaxonomyManager 的 addSpec/addValue（追加末尾）。

export function resolveVariantLabel(options, optionTypes) {
  if (!options || Object.keys(options).length === 0) return '無規格'
  return Object.entries(options).map(([typeId, valueId]) => {
    const type = optionTypes.find(t => t.id === Number(typeId))
    const val = type?.variant_option_values?.find(v => v.id === valueId)
    return val ? `${type.name}: ${val.value}` : ''
  }).filter(Boolean).join(' / ')
}

function cartesian(arrays) {
  if (arrays.length === 0) return [[]]
  return arrays.reduce((acc, arr) =>
    acc.flatMap(combo => arr.map(item => [...combo, item])),
  [[]])
}

export default function VariantEditor({
  optionTypes,
  selectedTypes,
  selectedValues,
  variants,
  onChange,            // (partial: {selectedTypes?, selectedValues?, variants?}) => void
  onOptionTypesChange, // (nextOptionTypes) => void — inline 新增規格後回寫父層清單
  showStock = true,    // 限時單/不檢查庫存時隱藏庫存欄與批次列
  showSale = false,
  basePrice = '',
  baseCost = '',
  baseSale = '',
  currency = 'TWD',
}) {
  const { storeId } = useAuth()
  const [batchStock, setBatchStock] = useState('')
  const [batchPrice, setBatchPrice] = useState('')
  const [batchSale, setBatchSale] = useState('')
  const [batchCost, setBatchCost] = useState('')
  const [addingValueFor, setAddingValueFor] = useState(null)  // 正在新增值的 type id
  const [newValueText, setNewValueText] = useState('')
  const [addingType, setAddingType] = useState(false)
  const [newTypeText, setNewTypeText] = useState('')
  const creatingRef = useRef(false)  // 防 Enter 連按重複 insert

  function toggleType(typeId) {
    const tid = String(typeId)
    const nextTypes = { ...selectedTypes }
    let nextValues = selectedValues
    if (nextTypes[tid]) {
      delete nextTypes[tid]
      nextValues = { ...selectedValues }
      delete nextValues[tid]
    } else {
      nextTypes[tid] = true
    }
    onChange({ selectedTypes: nextTypes, selectedValues: nextValues, variants: [] })
  }

  function toggleValue(typeId, valueId) {
    const tid = String(typeId)
    const next = { ...selectedValues }
    next[tid] = new Set(next[tid] || [])
    if (next[tid].has(valueId)) next[tid].delete(valueId)
    else next[tid].add(valueId)
    onChange({ selectedValues: next, variants: [] })
  }

  // inline 新增規格值：同名（trim 後）直接選取既有值不重複建立；DB UNIQUE 為最後防線
  async function createValue(typeId) {
    const val = newValueText.trim()
    if (!val) { setAddingValueFor(null); setNewValueText(''); return }
    if (creatingRef.current) return
    const type = optionTypes.find(t => t.id === typeId)
    const existing = (type?.variant_option_values || []).find(v => v.value === val)
    if (existing) {
      if (!selectedValues[String(typeId)]?.has(existing.id)) toggleValue(typeId, existing.id)
      setNewValueText('')
      return
    }
    creatingRef.current = true
    const { data, error } = await supabase.from('variant_option_values')
      .insert({ option_type_id: typeId, value: val, sort_order: (type?.variant_option_values || []).length })
      .select('*').single()
    creatingRef.current = false
    if (error || !data) { alert('新增規格值失敗：' + (error?.message || '未知錯誤')); return }
    onOptionTypesChange?.(optionTypes.map(t =>
      t.id === typeId ? { ...t, variant_option_values: [...(t.variant_option_values || []), data] } : t
    ))
    // 自動選取新值（依既有規則會清掉已產生的組合）；輸入框保持開啟方便連續新增
    toggleValue(typeId, data.id)
    setNewValueText('')
  }

  // inline 新增規格類型：建立後自動勾選，並開啟其值輸入框方便接著加值
  async function createType() {
    const name = newTypeText.trim()
    if (!name) { setAddingType(false); setNewTypeText(''); return }
    if (creatingRef.current) return
    const existing = optionTypes.find(t => t.name === name)
    if (existing) {
      if (!selectedTypes[String(existing.id)]) toggleType(existing.id)
      setAddingType(false); setNewTypeText('')
      return
    }
    creatingRef.current = true
    const { data, error } = await supabase.from('variant_option_types')
      .insert({ name, sort_order: optionTypes.length, store_id: storeId })
      .select('*').single()
    creatingRef.current = false
    if (error || !data) { alert('新增規格類型失敗：' + (error?.message || '未知錯誤')); return }
    onOptionTypesChange?.([...optionTypes, { ...data, variant_option_values: [] }])
    onChange({ selectedTypes: { ...selectedTypes, [String(data.id)]: true }, variants: [] })
    setAddingType(false)
    setNewTypeText('')
    setAddingValueFor(data.id)
  }

  function generateCombinations() {
    const activeTypeIds = Object.keys(selectedTypes).filter(tid => selectedTypes[tid] && selectedValues[tid]?.size > 0)
    if (activeTypeIds.length === 0) return
    const axes = activeTypeIds.map(tid =>
      [...selectedValues[tid]].map(vid => ({ tid, vid }))
    )
    const combos = cartesian(axes)
    onChange({
      variants: combos.map(combo => {
        const options = {}
        combo.forEach(({ tid, vid }) => { options[tid] = vid })
        return { options, stock: 0, variant_price: null, sale_price: null, variant_cost: null }
      }),
    })
  }

  function updateVariant(idx, field, value) {
    onChange({
      variants: variants.map((v, i) => {
        if (i !== idx) return v
        if (field === 'stock') return { ...v, stock: value === '' ? 0 : Number(value) }
        if (field === 'sale_price') return { ...v, sale_price: value === '' ? null : Number(value) }
        if (field === 'variant_cost') return { ...v, variant_cost: value === '' ? null : Number(value) }
        return { ...v, variant_price: value === '' ? null : Number(value) }
      }),
    })
  }

  function removeVariant(idx) {
    onChange({ variants: variants.filter((_, i) => i !== idx) })
  }

  function applyBatch(field) {
    const val = field === 'stock' ? batchStock : field === 'sale_price' ? batchSale : field === 'variant_cost' ? batchCost : batchPrice
    if (val === '') return
    onChange({ variants: variants.map(v => ({ ...v, [field]: Number(val) })) })
    if (field === 'stock') setBatchStock('')
    else if (field === 'sale_price') setBatchSale('')
    else if (field === 'variant_cost') setBatchCost('')
    else setBatchPrice('')
  }

  const activeTypeIds = Object.keys(selectedTypes).filter(tid => selectedTypes[tid] && selectedValues[tid]?.size > 0)
  const totalCombos = activeTypeIds.length > 0
    ? activeTypeIds.reduce((acc, tid) => acc * (selectedValues[tid]?.size || 1), 1)
    : 0

  return (
    <>
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
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', paddingLeft: 24, alignItems: 'center' }}>
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
                  {addingValueFor === type.id ? (
                    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                      <input
                        autoFocus
                        value={newValueText}
                        onChange={e => setNewValueText(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') createValue(type.id)
                          if (e.key === 'Escape') { setAddingValueFor(null); setNewValueText('') }
                        }}
                        onBlur={() => { setAddingValueFor(null); setNewValueText('') }}
                        placeholder="新規格值"
                        style={{
                          width: 90, fontSize: 13, padding: '4px 10px', borderRadius: 20,
                          border: '0.5px solid var(--text)', outline: 'none', background: 'var(--bg)',
                        }}
                      />
                      <button
                        onMouseDown={e => e.preventDefault()}
                        onClick={() => createValue(type.id)}
                        style={{
                          fontSize: 13, padding: '4px 10px', borderRadius: 20, cursor: 'pointer',
                          border: '0.5px solid var(--border)', background: 'var(--bg)', color: 'var(--text)',
                        }}
                      >✓</button>
                    </span>
                  ) : (
                    <button
                      onClick={() => { setAddingType(false); setAddingValueFor(type.id); setNewValueText('') }}
                      title="新增規格值"
                      style={{
                        fontSize: 13, padding: '4px 14px', borderRadius: 20,
                        background: 'transparent', color: 'var(--text-3)',
                        border: '0.5px dashed var(--border)', cursor: 'pointer',
                      }}
                    >＋</button>
                  )}
                </div>
              )}
            </div>
          )
        })}

        {addingType ? (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
            <input
              autoFocus
              value={newTypeText}
              onChange={e => setNewTypeText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') createType()
                if (e.key === 'Escape') { setAddingType(false); setNewTypeText('') }
              }}
              onBlur={() => { setAddingType(false); setNewTypeText('') }}
              placeholder="規格類型名稱（例：顏色、尺寸）"
              style={{
                width: 200, fontSize: 13, padding: '6px 10px', borderRadius: 8,
                border: '0.5px solid var(--text)', outline: 'none', background: 'var(--bg)',
              }}
            />
            <button
              onMouseDown={e => e.preventDefault()}
              onClick={createType}
              style={{
                fontSize: 13, padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
                border: '0.5px solid var(--border)', background: 'var(--bg)', color: 'var(--text)',
              }}
            >✓</button>
          </div>
        ) : (
          <button
            onClick={() => { setAddingValueFor(null); setAddingType(true); setNewTypeText('') }}
            style={{
              fontSize: 13, padding: '6px 12px', borderRadius: 8, marginBottom: 4,
              border: '0.5px dashed var(--border)', background: 'transparent',
              color: 'var(--text-3)', cursor: 'pointer',
            }}
          >＋ 新增規格類型</button>
        )}

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
      {variants.length > 0 && (
        <div style={{ background: 'var(--surface)', borderRadius: 12, padding: 14, border: '0.5px solid var(--border)' }}>
          <div className="muted fs12 fw600" style={{ marginBottom: 10 }}>
            2. 編輯規格（{variants.length} 種）
          </div>

          {/* Batch controls */}
          {showStock && (
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
                  placeholder={String(basePrice || 0)}
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
                  placeholder={baseCost !== '' ? String(baseCost) : '成本'}
                  style={{ width: 80, padding: '4px 8px', borderRadius: 6, border: '0.5px solid var(--border)', fontSize: 13, textAlign: 'center' }}
                />
                <button onClick={() => applyBatch('variant_cost')} style={{ padding: '4px 10px', borderRadius: 6, border: '0.5px solid var(--border)', background: 'var(--bg)', fontSize: 11, cursor: 'pointer' }}>套用</button>
              </div>
              {showSale && (
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <span className="muted fs12" style={{ color: 'var(--red)' }}>批次特價:</span>
                  <input
                    type="number"
                    value={batchSale}
                    onChange={e => setBatchSale(e.target.value)}
                    placeholder={baseSale !== '' ? String(baseSale) : '特價'}
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
                  {showStock && (
                    <th style={{ padding: '8px 6px', width: 70, textAlign: 'center', fontSize: 12, color: 'var(--text-3)', fontWeight: 600 }}>庫存</th>
                  )}
                  <th style={{ padding: '8px 6px', width: 90, textAlign: 'center', fontSize: 12, color: 'var(--text-3)', fontWeight: 600 }}>售價(NT$)</th>
                  <th style={{ padding: '8px 6px', width: 90, textAlign: 'center', fontSize: 12, color: 'var(--text-3)', fontWeight: 600 }}>成本({currency})</th>
                  {showSale && (
                    <th style={{ padding: '8px 6px', width: 90, textAlign: 'center', fontSize: 12, color: 'var(--red)', fontWeight: 600 }}>特價(NT$)</th>
                  )}
                  <th style={{ padding: '8px 6px', width: 36 }}></th>
                </tr>
              </thead>
              <tbody>
                {variants.map((v, idx) => (
                  <tr key={idx} style={{ borderBottom: '1px solid var(--border-light)' }}>
                    <td style={{ padding: '8px 6px' }}>
                      <span className="fw600">{resolveVariantLabel(v.options, optionTypes)}</span>
                    </td>
                    {showStock && (
                      <td style={{ padding: '8px 6px', textAlign: 'center' }}>
                        <input
                          type="number"
                          value={v.stock || ''}
                          onChange={e => updateVariant(idx, 'stock', e.target.value)}
                          placeholder="0"
                          style={{ width: '100%', padding: '5px 8px', borderRadius: 6, border: '0.5px solid var(--border)', fontSize: 13, textAlign: 'center', background: 'var(--bg)' }}
                        />
                      </td>
                    )}
                    <td style={{ padding: '8px 6px', textAlign: 'center' }}>
                      <input
                        type="number"
                        value={v.variant_price ?? ''}
                        onChange={e => updateVariant(idx, 'variant_price', e.target.value)}
                        placeholder={String(basePrice || 0)}
                        style={{ width: '100%', padding: '5px 8px', borderRadius: 6, border: '0.5px solid var(--border)', fontSize: 13, textAlign: 'center', background: 'var(--bg)' }}
                      />
                    </td>
                    <td style={{ padding: '8px 6px', textAlign: 'center' }}>
                      <input
                        type="number"
                        value={v.variant_cost ?? ''}
                        onChange={e => updateVariant(idx, 'variant_cost', e.target.value)}
                        placeholder={baseCost !== '' ? String(baseCost) : '成本'}
                        style={{ width: '100%', padding: '5px 8px', borderRadius: 6, border: '0.5px solid var(--border)', fontSize: 13, textAlign: 'center', background: 'var(--bg)' }}
                      />
                    </td>
                    {showSale && (
                      <td style={{ padding: '8px 6px', textAlign: 'center' }}>
                        <input
                          type="number"
                          value={v.sale_price ?? ''}
                          onChange={e => updateVariant(idx, 'sale_price', e.target.value)}
                          placeholder={baseSale !== '' ? String(baseSale) : '特價'}
                          style={{ width: '100%', padding: '5px 8px', borderRadius: 6, border: '0.5px solid var(--red)', fontSize: 13, textAlign: 'center', background: 'var(--bg)' }}
                        />
                      </td>
                    )}
                    <td style={{ padding: '8px 6px', textAlign: 'center' }}>
                      <button
                        onClick={() => removeVariant(idx)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', fontSize: 15, padding: 0 }}
                      >×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="muted fs12" style={{ marginTop: 8 }}>
            售價留空 = 使用商城售價 NT${Number(basePrice || 0).toLocaleString()}
            <br/>成本留空 = 使用進貨成本{baseCost !== '' ? ` ${Number(baseCost).toLocaleString()} ${currency}` : ''}
            {showSale && <><br/>特價留空 = 使用全品特價{baseSale !== '' ? ` NT$${Number(baseSale).toLocaleString()}` : '（未設定則該規格不特價）'}</>}
          </div>
        </div>
      )}
    </>
  )
}
