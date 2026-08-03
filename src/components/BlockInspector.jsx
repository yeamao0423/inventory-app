import { useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { compressImage } from '../lib/imageUtils'
import CustomSelect from './CustomSelect'
import {
  SPANS, DEFAULT_SPAN,
  GALLERY_RATIOS, PRICE_SIZES, CHIP_STYLES, IMAGE_RATIOS,
} from '../lib/contentBlocks'
import '../styles/product-editor.css'

// 單一區塊的屬性面板（商品頁編排器左欄的第二層）。
//
// 為什麼不開第三欄放屬性：預覽是這個工具的主體，第三欄會把預覽壓回幾百 px 寬，
// 商城就會渲染成手機版 —— 那正是這次改造要修掉的毛病。所以屬性面板佔用的是
// 「區塊清單」原本那塊面積，看屬性時就看不到清單，用「← 回到區塊清單」切回去。
//
// 可調欄位刻意只有計畫書 §3.2 列的那些。字級、間距、顏色一概不開放：
// 開了之後每家店的商品頁品質會參差不齊，理由同 docs/adr/0006（品牌色只套指定幾處）。
//
// Props:
//   block      – 目前選中的區塊（正規化過的形狀）
//   onChange   – (nextBlock) => void
//   storeId    – 圖片上傳路徑用
//   products   – [{ product_id, name }] 商品精選（手動）可選的商品
//   categories – [{ id, name, parent_id }] 商品精選（分類）可選的分類
export default function BlockInspector({ block, onChange, storeId, products = [], categories = [] }) {
  if (!block) return null
  const set = (key) => (value) => onChange({ ...block, [key]: value })

  return (
    <div>
      <div className="pe-hint" style={{ marginTop: 0, marginBottom: 14 }}>
        {BLOCK_HINTS[block.type]}
      </div>

      <SpanField value={block.span ?? DEFAULT_SPAN} onChange={set('span')} />

      {block.type === 'product_gallery' && (
        <>
          <Field label="圖片比例">
            <ChipRow options={GALLERY_RATIOS.map(r => ({ v: r, label: r.replace('/', ' : ') }))}
              value={block.ratio} onChange={set('ratio')} />
          </Field>
          <Switch label="顯示縮圖列" checked={block.thumbs !== false} onChange={set('thumbs')} />
        </>
      )}

      {block.type === 'product_title' && (
        <Switch label="顯示商品標籤" checked={block.showTags !== false} onChange={set('showTags')} />
      )}

      {block.type === 'product_price' && (
        <Field label="字級">
          <ChipRow options={PRICE_SIZES.map(s => ({ v: s, label: s === 'lg' ? '大' : '中' }))}
            value={block.size} onChange={set('size')} />
        </Field>
      )}

      {block.type === 'product_options' && (
        <Field label="規格呈現方式" hint="「自動」會在規格有代表圖時顯示圖片，沒有就退回文字。">
          <ChipRow options={CHIP_STYLES.map(s => ({ v: s, label: s === 'auto' ? '自動' : '只用文字' }))}
            value={block.chipStyle} onChange={set('chipStyle')} />
        </Field>
      )}

      {block.type === 'product_qty' && (
        <Switch label="顯示剩餘庫存" checked={block.showStock !== false} onChange={set('showStock')} />
      )}

      {block.type === 'product_cta' && (
        <Switch label="按鈕佔滿整個欄寬" checked={block.fullWidth !== false} onChange={set('fullWidth')} />
      )}

      {NO_SETTING_TYPES.includes(block.type) && (
        <div className="pe-nosetting">
          這個區塊顯示商品本身的資料，沒有可調整的設定。<br />
          內容要改的話，回到商品編輯頁改{NO_SETTING_SOURCE[block.type]}。
        </div>
      )}

      {block.type === 'hero' && <HeroFields block={block} set={set} storeId={storeId} />}
      {block.type === 'media_text' && <MediaTextFields block={block} set={set} storeId={storeId} />}
      {block.type === 'text' && <TextFields block={block} set={set} />}
      {block.type === 'products' && (
        <ProductsFields block={block} set={set} products={products} categories={categories} />
      )}
    </div>
  )
}

// 一句話說明每種區塊會畫出什麼。加入面板與屬性面板共用，兩邊講法才不會漂移。
export const BLOCK_HINTS = {
  hero: '大圖配標題與按鈕，內容由你自己填。',
  media_text: '一邊圖、一邊文字，內容由你自己填。',
  text: '純文字，一行一段，內容由你自己填。',
  products: '從店裡挑幾件商品排成一排。',
  product_gallery: '這件商品的圖片，含縮圖切換。',
  product_title: '商品名稱與標籤。',
  product_price: '售價，有特價時一併顯示原價與折扣徽章。',
  product_desc: '商品的中英文描述。',
  product_options: '規格選擇（顏色、尺寸…）。商品沒有規格時這個區塊不會出現。',
  product_status: '收單截止、缺貨等狀態提示。',
  product_qty: '購買數量。',
  product_note: '客製備註欄位。商品沒開放備註時不會出現。',
  product_cta: '加入購物車按鈕。捲離畫面後會由底部的黏底購買列接手。',
}

// 內容完全來自商品本身、店主在這裡沒有東西可調的區塊
const NO_SETTING_TYPES = ['product_desc', 'product_status', 'product_note']
const NO_SETTING_SOURCE = {
  product_desc: '「商品描述」',
  product_status: '收單日期與庫存',
  product_note: '「客製備註」設定',
}

// ── 欄寬 ───────────────────────────────────
// 十二欄的 span。直接丟一個 1–12 的下拉，店主得先在腦中把 12 欄換算成版面才選得下去；
// 常用的其實只有三個比例，所以預設給比例、要細調再展開數值。
const SPAN_PRESETS = [
  { v: 12, label: '整列' },
  { v: 6, label: '一半' },
  { v: 4, label: '三分之一' },
]

function SpanField({ value, onChange }) {
  const isPreset = SPAN_PRESETS.some(p => p.v === value)
  const [advanced, setAdvanced] = useState(!isPreset)

  return (
    <Field label="欄寬" hint="只在桌機生效 —— 手機一律整列堆疊，並排會每一欄都太窄。">
      <div className="pe-chip-row">
        {SPAN_PRESETS.map(p => (
          <button key={p.v} type="button"
            className={`pe-chip ${!advanced && value === p.v ? 'is-active' : ''}`}
            onClick={() => { setAdvanced(false); onChange(p.v) }}>
            {p.label}
          </button>
        ))}
        <button type="button" className={`pe-chip ${advanced ? 'is-active' : ''}`}
          onClick={() => setAdvanced(a => !a)}>
          自訂
        </button>
      </div>
      {advanced && (
        <div style={{ marginTop: 8 }}>
          <CustomSelect
            label="— 選擇欄寬 —"
            value={value}
            options={SPANS.map(n => ({ value: n, label: `${n} / 12 欄` }))}
            onChange={(v) => { if (v != null) onChange(v) }}
            allowClear={false}
          />
        </div>
      )}
    </Field>
  )
}

// ── 共用小元件 ─────────────────────────────

function Field({ label, hint, children }) {
  return (
    <div className="pe-field">
      <label className="pe-field-label">{label}</label>
      {children}
      {hint && <div className="pe-hint">{hint}</div>}
    </div>
  )
}

function ChipRow({ options, value, onChange }) {
  return (
    <div className="pe-chip-row">
      {options.map(o => (
        <button key={o.v} type="button"
          className={`pe-chip ${value === o.v ? 'is-active' : ''}`}
          onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Switch({ label, checked, onChange, hint }) {
  return (
    <div className="pe-field">
      <button type="button" className="pe-switch" role="switch" aria-checked={checked}
        onClick={() => onChange(!checked)}>
        <span className="pe-switch-label">{label}</span>
        <span className="pe-switch-track"><span className="pe-switch-knob" /></span>
      </button>
      {hint && <div className="pe-hint">{hint}</div>}
    </div>
  )
}

// ── 靜態區塊的欄位 ─────────────────────────
// 與 BlocksEditor 的同名欄位是同一份規格（型別、上限、提示文案都一致）。
// 沒有共用元件是刻意的：BlocksEditor 是首頁那條路徑的既有實作，
// 為了這裡去改它的內部結構，等於讓兩個編輯器互相牽制。這裡只讀它、不動它。

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
        <ChipRow
          options={[{ v: 'left', label: '圖在左' }, { v: 'right', label: '圖在右' }]}
          value={block.imageSide} onChange={set('imageSide')} />
      </Field>
      <Field label="圖片佔寬" hint="只在桌機生效 —— 手機一律上下堆疊，並排會兩邊都太窄">
        <ChipRow
          options={IMAGE_RATIOS.map(r => ({ v: r, label: `${r}%` }))}
          value={block.imageRatio} onChange={set('imageRatio')} />
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
        <input className="form-input" value={block.title} onChange={e => set('title')(e.target.value)} placeholder="例：一起買更划算" />
      </Field>
      <Field label="挑選方式">
        <ChipRow
          options={[{ v: 'manual', label: '手動挑選' }, { v: 'category', label: '依分類' }]}
          value={block.mode} onChange={set('mode')} />
      </Field>

      {block.mode === 'manual' ? (
        <Field label="已選商品" hint="順序就是商城上顯示的順序">
          {selected.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
              {selected.map((id, i) => {
                const p = products.find(x => x.product_id === id)
                return (
                  <div key={id} style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '6px 8px', borderRadius: 8, background: 'var(--bg)', border: '1px solid var(--border)',
                  }}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p ? p.name : `（商品 #${id} 已不在上架清單）`}
                    </span>
                    <button type="button" className="pe-icon-btn" title="上移" aria-label="上移"
                      disabled={i === 0} onClick={() => set('productIds')(swap(selected, i, i - 1))}>↑</button>
                    <button type="button" className="pe-icon-btn" title="下移" aria-label="下移"
                      disabled={i === selected.length - 1} onClick={() => set('productIds')(swap(selected, i, i + 1))}>↓</button>
                    <button type="button" className="pe-icon-btn is-danger" title="移除" aria-label="移除"
                      onClick={() => set('productIds')(selected.filter(x => x !== id))}>×</button>
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

// ── 圖片欄位 ───────────────────────────────
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
      <div className="pe-img-row">
        <div className="pe-img-thumb">
          {value ? <img src={value} alt="" /> : '未設定'}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-outline" style={{ width: 'auto', padding: '6px 12px', fontSize: 12.5 }}
              disabled={uploading} onClick={() => inputRef.current?.click()}>
              {uploading ? '上傳中…' : (value ? '更換圖片' : '上傳圖片')}
            </button>
            {value && (
              <button type="button" className="btn btn-outline" style={{ width: 'auto', padding: '6px 12px', fontSize: 12.5 }}
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

/**
 * 清單那一行的次要說明。
 * 靜態區塊顯示店主填的標題（沒填就空字串，讓呼叫端決定要不要提示「尚未填內容」）；
 * 動態區塊沒有店主填的內容可顯示，一律回空字串。
 */
export function blockSummary(block) {
  if (!block) return ''
  if (block.type === 'products') {
    if (block.mode === 'category') return block.title || '（依分類挑選）'
    return block.title || `${(block.productIds || []).length} 件商品`
  }
  return block.title || block.body?.split('\n')[0] || ''
}
