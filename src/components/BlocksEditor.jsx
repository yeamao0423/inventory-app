import { useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { compressImage } from '../lib/imageUtils'
import CustomSelect from './CustomSelect'
import {
  BLOCK_TYPES, BLOCK_LABELS, IMAGE_RATIOS,
  createBlock, moveBlock, duplicateBlock, removeBlock, replaceBlock,
} from '../lib/contentBlocks'

// 區塊編輯器（首頁編排與商品介紹共用）。
//
// 表單式，刻意不做拖拉：拖拉在手機上難用、實作成本高，而店主一頁通常只有 5–8 個區塊，
// 「上移／下移／複製／刪除」四顆按鈕就夠了。這是訪談定案的決策，不是待補功能。
//
// 這個元件只管 blocks 陣列本身，不碰儲存與發佈 —— 那是使用它的頁面的事。
//
// Props:
//   blocks      – 區塊陣列
//   onChange    – (blocks) => void
//   storeId     – 圖片上傳路徑用
//   products    – [{ product_id, name }] 商品精選（手動）可選的商品
//   categories  – [{ id, name, parent_id }] 商品精選（分類）可選的分類
export default function BlocksEditor({ blocks = [], onChange, storeId, products = [], categories = [] }) {
  const [openId, setOpenId] = useState(null)   // 一次只展開一個，避免長長一頁全部攤開
  const [adding, setAdding] = useState(false)

  const update = (next) => onChange(next)

  function addBlock(type) {
    const block = createBlock(type)
    if (!block) return
    update([...blocks, block])
    setOpenId(block.id)
    setAdding(false)
  }

  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {blocks.map((block, i) => (
          <BlockCard
            key={block.id}
            block={block}
            index={i}
            total={blocks.length}
            open={openId === block.id}
            onToggle={() => setOpenId(openId === block.id ? null : block.id)}
            onChange={(next) => update(replaceBlock(blocks, i, next))}
            onMove={(dir) => update(moveBlock(blocks, i, dir))}
            onDuplicate={() => update(duplicateBlock(blocks, i))}
            onRemove={() => {
              if (!window.confirm(`確定刪除這個「${BLOCK_LABELS[block.type]}」區塊？`)) return
              update(removeBlock(blocks, i))
            }}
            storeId={storeId}
            products={products}
            categories={categories}
          />
        ))}
      </div>

      {blocks.length === 0 && (
        <div style={{
          padding: '28px 16px', textAlign: 'center', border: '1px dashed var(--border)',
          borderRadius: 12, color: 'var(--text-3)', fontSize: 13,
        }}>
          還沒有任何區塊。從下面新增，或先套一套起始模板。
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        {adding ? (
          <div className="card" style={{ padding: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>要新增哪一種區塊？</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
              {BLOCK_TYPES.map(type => (
                <button key={type} type="button" onClick={() => addBlock(type)}
                  style={{
                    padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)',
                    background: 'var(--bg)', cursor: 'pointer', textAlign: 'left',
                  }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{BLOCK_LABELS[type]}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>{TYPE_HINTS[type]}</div>
                </button>
              ))}
            </div>
            <button type="button" className="btn btn-outline" style={{ marginTop: 10 }} onClick={() => setAdding(false)}>
              取消
            </button>
          </div>
        ) : (
          <button type="button" className="btn btn-outline" onClick={() => setAdding(true)}>＋ 新增區塊</button>
        )}
      </div>
    </div>
  )
}

const TYPE_HINTS = {
  hero: '大圖配標題與按鈕',
  media_text: '一邊圖、一邊文字',
  text: '純文字，一行一段',
  products: '從店裡挑幾件商品',
}

// ── 單一區塊卡片 ─────────────────────────────

function BlockCard({
  block, index, total, open, onToggle, onChange, onMove, onDuplicate, onRemove,
  storeId, products, categories,
}) {
  const set = (key) => (value) => onChange({ ...block, [key]: value })
  const summary = summarize(block)

  return (
    <div className="card" style={{ padding: 0, overflow: 'visible' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px' }}>
        <button type="button" onClick={onToggle}
          style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
          <div style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 600 }}>
            {index + 1}. {BLOCK_LABELS[block.type]}
          </div>
          <div style={{
            fontSize: 13.5, fontWeight: 500, marginTop: 1,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            color: summary ? 'var(--text)' : 'var(--text-3)',
          }}>
            {summary || '（尚未填內容）'}
          </div>
        </button>
        <IconBtn label="上移" disabled={index === 0} onClick={() => onMove(-1)}>↑</IconBtn>
        <IconBtn label="下移" disabled={index === total - 1} onClick={() => onMove(1)}>↓</IconBtn>
        <IconBtn label="複製" onClick={onDuplicate}>⧉</IconBtn>
        <IconBtn label="刪除" onClick={onRemove} danger>×</IconBtn>
        <IconBtn label={open ? '收合' : '展開'} onClick={onToggle}>{open ? '▲' : '▼'}</IconBtn>
      </div>

      {open && (
        <div style={{ padding: '4px 12px 14px', borderTop: '0.5px solid var(--border-light)' }}>
          {block.type === 'hero' && <HeroFields block={block} set={set} storeId={storeId} />}
          {block.type === 'media_text' && <MediaTextFields block={block} set={set} storeId={storeId} />}
          {block.type === 'text' && <TextFields block={block} set={set} />}
          {block.type === 'products' && (
            <ProductsFields block={block} set={set} products={products} categories={categories} />
          )}
        </div>
      )}
    </div>
  )
}

function summarize(block) {
  if (block.type === 'products') {
    if (block.mode === 'category') return block.title || '（依分類挑選）'
    return block.title || `${(block.productIds || []).length} 件商品`
  }
  return block.title || block.body?.split('\n')[0] || ''
}

function IconBtn({ children, label, onClick, disabled, danger }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={label} aria-label={label}
      style={{
        width: 28, height: 28, flexShrink: 0, borderRadius: 6,
        border: '1px solid var(--border)', background: 'var(--bg)',
        color: danger ? '#c0392b' : 'var(--text-2)',
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.35 : 1,
        fontSize: 13, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
      {children}
    </button>
  )
}

// ── 各型別的欄位 ─────────────────────────────

function Field({ label, hint, children }) {
  return (
    <div style={{ marginTop: 12 }}>
      <label className="form-label">{label}</label>
      {children}
      {hint && <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 4 }}>{hint}</div>}
    </div>
  )
}

function HeroFields({ block, set, storeId }) {
  return (
    <>
      <ImageField label="背景圖" value={block.image} onChange={set('image')} storeId={storeId} />
      <Field label="標題">
        <input className="form-input" value={block.title} onChange={e => set('title')(e.target.value)} placeholder="例：本季新品到貨" />
      </Field>
      <Field label="副標">
        <input className="form-input" value={block.subtitle} onChange={e => set('subtitle')(e.target.value)} placeholder="一句話說明" />
      </Field>
      <Field label="按鈕文字" hint="文字與連結都填了才會出現按鈕">
        <input className="form-input" value={block.buttonText} onChange={e => set('buttonText')(e.target.value)} placeholder="例：立即選購" />
      </Field>
      <Field label="按鈕連結" hint="站內用 /products 這種相對路徑；外部連結要完整帶 https://">
        <input className="form-input" value={block.buttonHref} onChange={e => set('buttonHref')(e.target.value)} placeholder="/products" />
      </Field>
    </>
  )
}

function MediaTextFields({ block, set, storeId }) {
  return (
    <>
      <ImageField label="圖片" value={block.image} onChange={set('image')} storeId={storeId} />
      <Field label="圖片位置">
        <div style={{ display: 'flex', gap: 8 }}>
          {[{ v: 'left', label: '圖在左' }, { v: 'right', label: '圖在右' }].map(o => (
            <Chip key={o.v} active={block.imageSide === o.v} onClick={() => set('imageSide')(o.v)}>{o.label}</Chip>
          ))}
        </div>
      </Field>
      <Field label="圖片佔寬" hint="只在桌機生效 —— 手機一律上下堆疊，並排會兩邊都太窄">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {IMAGE_RATIOS.map(r => (
            <Chip key={r} active={block.imageRatio === r} onClick={() => set('imageRatio')(r)}>{r}%</Chip>
          ))}
        </div>
      </Field>
      <Field label="標題">
        <input className="form-input" value={block.title} onChange={e => set('title')(e.target.value)} />
      </Field>
      <BodyField value={block.body} onChange={set('body')} />
    </>
  )
}

function TextFields({ block, set }) {
  return (
    <>
      <Field label="標題">
        <input className="form-input" value={block.title} onChange={e => set('title')(e.target.value)} />
      </Field>
      <BodyField value={block.body} onChange={set('body')} />
    </>
  )
}

function BodyField({ value, onChange }) {
  return (
    <Field label="內文" hint="一行一段。不支援 **粗體** 這類語法，也不接受 HTML —— 打進去會原樣顯示。要分很多段就多放幾個區塊。">
      <textarea className="form-input" rows={5} value={value}
        onChange={e => onChange(e.target.value)}
        style={{ resize: 'vertical', lineHeight: 1.6 }} />
    </Field>
  )
}

function ProductsFields({ block, set, products, categories }) {
  const selected = block.productIds || []
  const catOptions = categories.map(c => ({
    value: c.id,
    label: c.parent_id ? `　└ ${c.name}` : c.name,
  }))
  const available = products.filter(p => !selected.includes(p.product_id))

  return (
    <>
      <Field label="區塊標題">
        <input className="form-input" value={block.title} onChange={e => set('title')(e.target.value)} placeholder="例：精選商品" />
      </Field>
      <Field label="挑選方式">
        <div style={{ display: 'flex', gap: 8 }}>
          <Chip active={block.mode === 'manual'} onClick={() => set('mode')('manual')}>手動挑選</Chip>
          <Chip active={block.mode === 'category'} onClick={() => set('mode')('category')}>依分類</Chip>
        </div>
      </Field>

      {block.mode === 'manual' ? (
        <Field label="已選商品" hint="順序就是商城上顯示的順序">
          {selected.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
              {selected.map((id, i) => {
                const p = products.find(x => x.product_id === id)
                return (
                  <div key={id} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '6px 8px', borderRadius: 8, background: 'var(--bg)', border: '1px solid var(--border)',
                  }}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p ? p.name : `（商品 #${id} 已不在上架清單）`}
                    </span>
                    <IconBtn label="上移" disabled={i === 0}
                      onClick={() => set('productIds')(swap(selected, i, i - 1))}>↑</IconBtn>
                    <IconBtn label="下移" disabled={i === selected.length - 1}
                      onClick={() => set('productIds')(swap(selected, i, i + 1))}>↓</IconBtn>
                    <IconBtn label="移除" danger
                      onClick={() => set('productIds')(selected.filter(x => x !== id))}>×</IconBtn>
                  </div>
                )
              })}
            </div>
          )}
          <CustomSelect
            label={available.length ? '＋ 加入商品' : '沒有其他可加入的商品'}
            value={null}
            options={available.map(p => ({ value: p.product_id, label: p.name }))}
            onChange={(v) => { if (v != null) set('productIds')([...selected, v]) }}
            allowClear={false}
            emptyText="這家店還沒有上架商品"
          />
        </Field>
      ) : (
        <Field label="分類" hint="選父分類時，底下子分類的商品也會一起出現">
          <CustomSelect
            label="— 選擇分類 —"
            value={block.categoryId}
            options={catOptions}
            onChange={(v) => set('categoryId')(v)}
            emptyText="這家店還沒有分類"
          />
        </Field>
      )}

      <Field label="最多顯示幾件">
        <input className="form-input" type="number" min={1} max={24} value={block.limit}
          onChange={e => set('limit')(Number(e.target.value))} style={{ maxWidth: 120 }} />
      </Field>
    </>
  )
}

function swap(arr, a, b) {
  const out = arr.slice()
  const tmp = out[a]; out[a] = out[b]; out[b] = tmp
  return out
}

function Chip({ active, onClick, children }) {
  return (
    <button type="button" onClick={onClick}
      style={{
        padding: '6px 12px', borderRadius: 999, fontSize: 13,
        border: `1px solid ${active ? 'var(--text)' : 'var(--border)'}`,
        background: active ? 'var(--text)' : 'var(--bg)',
        color: active ? '#fff' : 'var(--text-2)',
        cursor: 'pointer',
      }}>
      {children}
    </button>
  )
}

// ── 圖片欄位 ─────────────────────────────────
// 沿用既有的上傳機制：壓縮 → 公開 bucket product-images 的 blocks/ 路徑（不新建 bucket）。
function ImageField({ label, value, onChange, storeId }) {
  const [uploading, setUploading] = useState(false)
  const [err, setErr] = useState('')
  const inputRef = useRef(null)

  async function onFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true); setErr('')
    try {
      const compressed = await compressImage(file)
      const ext = compressed.name.split('.').pop().toLowerCase()
      const path = `blocks/${storeId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
      const { error } = await supabase.storage.from('product-images').upload(path, compressed)
      if (error) throw error
      const { data: { publicUrl } } = supabase.storage.from('product-images').getPublicUrl(path)
      onChange(publicUrl)
    } catch (e2) {
      setErr('上傳失敗：' + e2.message)
    }
    setUploading(false)
  }

  return (
    <Field label={label}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <div style={{
          width: 92, height: 69, flexShrink: 0, borderRadius: 8, overflow: 'hidden',
          background: 'var(--bg)', border: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, color: 'var(--text-3)',
        }}>
          {value
            ? <img src={value} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : '未設定'}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-outline" style={{ width: 'auto', padding: '7px 14px', fontSize: 13 }}
              disabled={uploading} onClick={() => inputRef.current?.click()}>
              {uploading ? '上傳中…' : (value ? '更換圖片' : '上傳圖片')}
            </button>
            {value && (
              <button type="button" className="btn btn-outline" style={{ width: 'auto', padding: '7px 14px', fontSize: 13 }}
                onClick={() => onChange('')}>
                移除
              </button>
            )}
          </div>
          <input ref={inputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onFile} />
          <input className="form-input" style={{ marginTop: 8, fontSize: 12 }}
            value={value} onChange={e => onChange(e.target.value)} placeholder="或直接貼上圖片網址" />
          {err && <div style={{ fontSize: 12, color: '#c0392b', marginTop: 4 }}>{err}</div>}
        </div>
      </div>
    </Field>
  )
}
