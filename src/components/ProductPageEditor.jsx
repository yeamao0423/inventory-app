import { useState } from 'react'
import LivePreview from './LivePreview'
import BlockInspector, { BLOCK_HINTS, blockSummary } from './BlockInspector'
import { useMediaQuery } from '../hooks/useMediaQuery'
import {
  BLOCK_TYPES, PRODUCT_BLOCK_TYPES, BLOCK_LABELS,
  createBlock, moveBlock, duplicateBlock, removeBlock, replaceBlock,
} from '../lib/contentBlocks'
import '../styles/product-editor.css'

// 商品頁編排器的本體：左邊區塊面板、右邊即時預覽。
//
// 全店範本（/product-template）與單一商品覆寫（/storefront/:spId/page）共用這一個元件。
// 差別只在讀寫哪張表，那是外層頁面的事 —— 這裡完全不碰資料庫，只吃 blocks 陣列、吐新的陣列。
//
// 兩層面板而不是三欄：屬性面板佔用區塊清單那塊面積，選中時切過去、按「← 回到區塊清單」切回來。
// 多開一欄的話預覽會被壓到幾百 px，商城的 media query 量的是 iframe 自己的寬度，
// 於是預覽永遠是手機版 —— 那正是這次改造要修掉的毛病（見計畫書 §0）。
//
// Props:
//   blocks       – 區塊陣列
//   onChange     – (blocks) => void
//   shopBase     – 商城網址（預覽 iframe 用）
//   productId    – 預覽要拿哪一件商品當範例
//   storeId      – 圖片上傳路徑用
//   products     – [{ product_id, name }] 商品精選（手動）可選的商品
//   categories   – [{ id, name, parent_id }] 商品精選（分類）可選的分類
//   header       – 面板頂端的額外內容（例如範本模式的「預覽商品」選擇）
//   footer       – 面板底部固定區（儲存／發佈那一排，由外層頁面提供）
//   emptyAction  – 清單為空時顯示的引導（例如「從現有版型開始」）
export default function ProductPageEditor({
  blocks = [], onChange, shopBase, productId, storeId,
  products = [], categories = [], header = null, footer = null, emptyAction = null,
}) {
  const [selectedId, setSelectedId] = useState(null)
  const [hoverId, setHoverId] = useState(null)     // 滑過清單 → 預覽把該區塊框起來
  const [adding, setAdding] = useState(false)
  const [dragIndex, setDragIndex] = useState(null)
  const [dropAt, setDropAt] = useState(null)       // { index, after } 落點提示

  // 窄螢幕塞不下「左面板右預覽」，就不掛 iframe（連都不連），避免白花一次商城請求
  const wide = useMediaQuery('(min-width: 1200px)')

  // 選中的區塊可能已被刪掉（或外層換了一份 blocks），這時就當作沒選中，
  // 不需要 effect 去同步 —— 每次算一次比多一條副作用便宜也安全
  const selectedIndex = blocks.findIndex(b => b.id === selectedId)
  const selected = selectedIndex >= 0 ? blocks[selectedIndex] : null

  function addBlock(type) {
    const block = createBlock(type)
    if (!block) return
    onChange([...blocks, block])
    setSelectedId(block.id)   // 加完直接進屬性面板，不必再回頭點一次
    setAdding(false)
  }

  function removeAt(i) {
    const block = blocks[i]
    if (!window.confirm(`確定刪除這個「${BLOCK_LABELS[block.type]}」區塊？`)) return
    if (block.id === selectedId) setSelectedId(null)
    onChange(removeBlock(blocks, i))
  }

  // ── 拖拉排序（HTML5 原生，不裝套件）──────────
  // dataTransfer 一定要 setData，Firefox 沒有它就不會啟動拖曳；
  // 但真正的來源索引走 state，因為 dragover 期間讀不到 dataTransfer 的內容。
  function onDragStart(e, i) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(i))
    setDragIndex(i)
  }

  function onDragOver(e, i) {
    if (dragIndex == null) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    // 以項目中線決定要插在它上面還是下面，游標停在哪半邊就往哪邊放
    const rect = e.currentTarget.getBoundingClientRect()
    const after = e.clientY > rect.top + rect.height / 2
    if (dropAt?.index !== i || dropAt?.after !== after) setDropAt({ index: i, after })
  }

  function onDrop(e) {
    e.preventDefault()
    const from = dragIndex
    endDrag()
    if (from == null || !dropAt) return
    // 插入點是「移除來源之後」的索引，所以來源在插入點前面時要往回退一格
    const insertAt = dropAt.after ? dropAt.index + 1 : dropAt.index
    const to = from < insertAt ? insertAt - 1 : insertAt
    if (to === from) return
    onChange(reorder(blocks, from, to))
  }

  function endDrag() { setDragIndex(null); setDropAt(null) }

  const panelBody = selected ? (
    <BlockInspector
      key={selected.id}
      block={selected}
      onChange={(next) => onChange(replaceBlock(blocks, selectedIndex, next))}
      storeId={storeId}
      products={products}
      categories={categories}
    />
  ) : (
    <>
      {adding ? (
        <div style={{ marginBottom: 18 }}>
          <div className="sec" style={{ marginTop: 0 }}>商品元素</div>
          <div className="pe-add-grid">
            {PRODUCT_BLOCK_TYPES.map(type => (
              <AddButton key={type} type={type} onClick={() => addBlock(type)} />
            ))}
          </div>
          <div className="sec">自由內容</div>
          <div className="pe-add-grid">
            {BLOCK_TYPES.map(type => (
              <AddButton key={type} type={type} onClick={() => addBlock(type)} />
            ))}
          </div>
          <button type="button" className="btn btn-outline" style={{ marginTop: 10 }}
            onClick={() => setAdding(false)}>
            取消
          </button>
        </div>
      ) : (
        <button type="button" className="btn btn-outline" style={{ marginBottom: 18 }}
          onClick={() => setAdding(true)}>
          ＋ 加入區塊
        </button>
      )}

      <div className="sec" style={{ marginTop: 0 }}>目前版面</div>

      {blocks.length === 0 ? (
        <div className="pe-empty">
          還沒有任何區塊。
          {emptyAction && <div style={{ marginTop: 12 }}>{emptyAction}</div>}
        </div>
      ) : (
        <div className="pe-list" onDragOver={(e) => { if (dragIndex != null) e.preventDefault() }} onDrop={onDrop}>
          {blocks.map((block, i) => {
            const over = dropAt?.index === i && dragIndex != null
            const cls = [
              'pe-item',
              block.id === selectedId ? 'is-selected' : '',
              dragIndex === i ? 'is-dragging' : '',
              over ? (dropAt.after ? 'is-over-bottom' : 'is-over-top') : '',
            ].filter(Boolean).join(' ')
            const summary = blockSummary(block)
            return (
              <div key={block.id} className={cls}
                draggable
                onDragStart={(e) => onDragStart(e, i)}
                onDragOver={(e) => onDragOver(e, i)}
                onDragEnd={endDrag}
                onMouseEnter={() => setHoverId(block.id)}
                onMouseLeave={() => setHoverId(null)}>
                <span className="pe-handle" aria-hidden="true" title="拖曳排序">⣿</span>
                <button type="button" className="pe-item-main" onClick={() => setSelectedId(block.id)}>
                  <div className="pe-item-name">{BLOCK_LABELS[block.type]}</div>
                  <div className="pe-item-sub">
                    {spanLabel(block.span)}{summary ? ` · ${summary}` : ''}
                  </div>
                </button>
                {/* 上移／下移留著當鍵盤與觸控的備援 —— 原生拖拉在這兩種輸入上都不好用 */}
                <button type="button" className="pe-icon-btn" title="上移" aria-label="上移"
                  disabled={i === 0} onClick={() => onChange(moveBlock(blocks, i, -1))}>↑</button>
                <button type="button" className="pe-icon-btn" title="下移" aria-label="下移"
                  disabled={i === blocks.length - 1} onClick={() => onChange(moveBlock(blocks, i, 1))}>↓</button>
                <button type="button" className="pe-icon-btn" title="複製" aria-label="複製"
                  onClick={() => onChange(duplicateBlock(blocks, i))}>⧉</button>
                <button type="button" className="pe-icon-btn is-danger" title="刪除" aria-label="刪除"
                  onClick={() => removeAt(i)}>×</button>
              </div>
            )
          })}
        </div>
      )}
    </>
  )

  return (
    <div className="hd-split">
      <div className="pe-panel">
        <div className="pe-head">
          {selected ? (
            <>
              <button type="button" className="pe-back" onClick={() => setSelectedId(null)}>
                ← 回到區塊清單
              </button>
              <span className="pe-head-sub" style={{ marginLeft: 'auto' }}>
                {BLOCK_LABELS[selected.type]}
              </span>
            </>
          ) : (
            header || <span className="pe-head-title">版面</span>
          )}
        </div>

        <div className="pe-body">{panelBody}</div>

        {footer && <div className="pe-foot">{footer}</div>}
      </div>

      {wide && (
        productId ? (
          // highlightId 對應 previewBridge 的 PREVIEW_HIGHLIGHT（滑過清單就把該區塊框起來）。
          // 縮放與桌機／平板／手機切換是 LivePreview 自己的事，這裡不介入。
          <LivePreview
            blocks={blocks}
            shopBase={shopBase}
            target="product"
            productId={productId}
            editing
            selectedId={selectedId}
            onSelect={setSelectedId}
            highlightId={hoverId}
          />
        ) : (
          <div className="pe-panel" style={{ padding: 24 }}>
            <div className="pe-empty" style={{ border: 'none' }}>
              這家店還沒有上架中的商品，沒有東西可以拿來預覽。<br />
              先上架一件商品，再回來編排版面。
            </div>
          </div>
        )
      )}
    </div>
  )
}

function AddButton({ type, onClick }) {
  return (
    <button type="button" className="pe-add-btn" onClick={onClick}>
      <div className="pe-add-name">{BLOCK_LABELS[type]}</div>
      <div className="pe-add-hint">{BLOCK_HINTS[type]}</div>
    </button>
  )
}

function spanLabel(span) {
  if (span === 12 || span == null) return '整列'
  if (span === 6) return '一半'
  if (span === 4) return '三分之一'
  return `${span} / 12 欄`
}

// 把一個區塊搬到任意位置。
// 用 moveBlock 一格一格推而不是自己 splice：排序規則只有一份實作（而且那份有測試），
// 這裡就不會出現「拖拉的結果和上移下移不一致」這種難查的落差。
function reorder(blocks, from, to) {
  const dir = to > from ? 1 : -1
  let out = blocks
  for (let i = from; i !== to; i += dir) out = moveBlock(out, i, dir)
  return out
}
