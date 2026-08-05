import { useState } from 'react'
import LivePreview from './LivePreview'
import BlockInspector, { BLOCK_HINTS, blockSummary } from './BlockInspector'
import { useMediaQuery } from '../hooks/useMediaQuery'
import {
  BLOCK_TYPES, PRODUCT_BLOCK_TYPES, BLOCK_LABELS, MIN_COLUMNS,
  createBlock, createColumns,
  getBlockAt, removeBlockAt, replaceBlockAt,
  duplicateBlockAt, moveBlockAt, moveBlockTo, removeColumnAt,
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
// 清單是兩層樹：欄容器（columns）一列，它的欄與子區塊縮排在下面。
// 巢狀只有一層，所以所有操作吃的「路徑」也只有兩種形狀：[i] 與 [i, 欄, j]。
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
  const [dragPath, setDragPath] = useState(null)   // 正在拖的那一塊的路徑
  const [dropAt, setDropAt] = useState(null)       // { path, after } 落點提示
  const [collapsedIds, setCollapsedIds] = useState([])  // 收合起來的欄容器

  // 窄螢幕塞不下「左面板右預覽」，就不掛 iframe（連都不連），避免白花一次商城請求
  const wide = useMediaQuery('(min-width: 1200px)')

  // 選中的區塊可能已被刪掉（或外層換了一份 blocks），這時就當作沒選中，
  // 不需要 effect 去同步 —— 每次算一次比多一條副作用便宜也安全
  const selectedPath = selectedId ? findPath(blocks, selectedId) : null
  const selected = selectedPath ? getBlockAt(blocks, selectedPath) : null

  function addBlock(type) {
    const block = createBlock(type)
    if (!block) return
    onChange([...blocks, block])
    setSelectedId(block.id)   // 加完直接進屬性面板，不必再回頭點一次
    setAdding(false)
  }

  function addColumns(count) {
    const block = createColumns(count)
    onChange([...blocks, block])
    setSelectedId(block.id)
    setAdding(false)
  }

  function removeAt(path) {
    const block = getBlockAt(blocks, path)
    if (!block) return
    if (block.type === 'columns') {
      const n = block.columns.reduce((s, c) => s + c.blocks.length, 0)
      const msg = n > 0
        ? `確定刪除這個欄容器？裡面的 ${n} 個區塊會一起刪掉。`
        : '確定刪除這個欄容器？'
      if (!window.confirm(msg)) return
    } else if (!window.confirm(`確定刪除這個「${BLOCK_LABELS[block.type]}」區塊？`)) {
      return
    }
    if (block.id === selectedId) setSelectedId(null)
    onChange(removeBlockAt(blocks, path))
  }

  // 刪一欄：內容搬到相鄰欄，不會靜靜消失。只剩兩欄時不給刪
  //（欄容器至少要兩欄，要整個拿掉請刪整塊）。
  function removeColumn(columnsIndex, columnIndex) {
    const parent = blocks[columnsIndex]
    if (!parent || parent.type !== 'columns') return
    if (parent.columns.length <= MIN_COLUMNS) {
      window.alert('欄容器至少要兩欄。要整個拿掉請刪除這個欄容器。')
      return
    }
    onChange(removeColumnAt(blocks, columnsIndex, columnIndex))
  }

  function toggleCollapse(id) {
    setCollapsedIds(ids => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]))
  }

  // ── 拖拉排序（HTML5 原生，不裝套件）──────────
  // dataTransfer 一定要 setData，Firefox 沒有它就不會啟動拖曳；
  // 但真正的來源走 state，因為 dragover 期間讀不到 dataTransfer 的內容。
  function onDragStart(e, path) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', path.join('.'))
    setDragPath(path)
  }

  // 落點有三種：頂層項目之間、某一欄的子項之間、空欄本身。
  // 空欄要能當落點，否則店主建了欄容器卻沒辦法把東西放進去。
  function onDragOverItem(e, path) {
    if (!dragPath) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    // 以項目中線決定要插在它上面還是下面，游標停在哪半邊就往哪邊放
    const rect = e.currentTarget.getBoundingClientRect()
    const after = e.clientY > rect.top + rect.height / 2
    if (!samePath(dropAt?.path, path) || dropAt?.after !== after) setDropAt({ path, after })
  }

  function onDragOverEmptyColumn(e, columnsIndex, columnIndex) {
    if (!dragPath) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const path = [columnsIndex, columnIndex, 0]
    if (!samePath(dropAt?.path, path)) setDropAt({ path, after: false })
  }

  function onDrop(e) {
    e.preventDefault()
    const from = dragPath
    const target = dropAt
    endDrag()
    if (!from || !target) return
    const to = target.path.slice()
    if (target.after) to[to.length - 1] += 1
    // 不准把欄容器拖進欄裡（巢狀只有一層）
    const moving = getBlockAt(blocks, from)
    if (moving?.type === 'columns' && to.length === 3) return
    // 放回自己原本的位置就什麼都不做，不要讓「沒動」被記成一次未儲存的變更
    if (isNoOpMove(from, to)) return
    const next = moveBlockTo(blocks, from, to)
    if (next !== blocks) onChange(next)
  }

  function endDrag() { setDragPath(null); setDropAt(null) }

  // 清單裡的一列。頂層與欄內的子項共用它，差別只在路徑長度與縮排的 class。
  function renderItem(block, path, siblingCount) {
    const i = path[path.length - 1]
    const over = samePath(dropAt?.path, path) && dragPath != null
    const cls = [
      'pe-item',
      path.length === 3 ? 'is-child' : '',
      block.id === selectedId ? 'is-selected' : '',
      samePath(dragPath, path) ? 'is-dragging' : '',
      over ? (dropAt.after ? 'is-over-bottom' : 'is-over-top') : '',
    ].filter(Boolean).join(' ')
    const summary = blockSummary(block)
    return (
      <div key={block.id} className={cls}
        draggable
        onDragStart={(e) => onDragStart(e, path)}
        onDragOver={(e) => onDragOverItem(e, path)}
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
        {/* 上移／下移留著當鍵盤與觸控的備援 —— 原生拖拉在這兩種輸入上都不好用。
            它們只在自己的容器內移動，到邊界就停住，不會跳出欄外。 */}
        <button type="button" className="pe-icon-btn" title="上移" aria-label="上移"
          disabled={i === 0} onClick={() => onChange(moveBlockAt(blocks, path, -1))}>↑</button>
        <button type="button" className="pe-icon-btn" title="下移" aria-label="下移"
          disabled={i === siblingCount - 1} onClick={() => onChange(moveBlockAt(blocks, path, 1))}>↓</button>
        <button type="button" className="pe-icon-btn" title="複製" aria-label="複製"
          onClick={() => onChange(duplicateBlockAt(blocks, path))}>⧉</button>
        <button type="button" className="pe-icon-btn is-danger" title="刪除" aria-label="刪除"
          onClick={() => removeAt(path)}>×</button>
      </div>
    )
  }

  // 欄容器：容器一列，底下每一欄一個小標題列＋該欄的子區塊
  function renderColumns(block, i) {
    const collapsed = collapsedIds.includes(block.id)
    return (
      <div key={block.id} className="pe-group">
        {renderItem(block, [i], blocks.length)}
        <button type="button" className="pe-group-toggle"
          onClick={() => toggleCollapse(block.id)}
          aria-expanded={!collapsed}>
          {collapsed ? `▸ 展開 ${block.columns.length} 欄` : '▾ 收合'}
        </button>
        {!collapsed && block.columns.map((col, c) => (
          <div key={col.id}>
            <div className="pe-col-head">
              <span>第 {c + 1} 欄・{spanLabel(col.span)}</span>
              <button type="button" className="pe-icon-btn is-danger" title="刪除這一欄" aria-label="刪除這一欄"
                onClick={() => removeColumn(i, c)}>×</button>
            </div>
            <div className="pe-col-body">
              {col.blocks.length === 0 ? (
                <div
                  className={`pe-col-empty${samePath(dropAt?.path, [i, c, 0]) && dragPath ? ' is-over' : ''}`}
                  onDragOver={(e) => onDragOverEmptyColumn(e, i, c)}>
                  把區塊拖到這裡
                </div>
              ) : (
                col.blocks.map((child, j) => renderItem(child, [i, c, j], col.blocks.length))
              )}
            </div>
          </div>
        ))}
      </div>
    )
  }

  const panelBody = selected ? (
    <BlockInspector
      key={selected.id}
      block={selected}
      onChange={(next) => onChange(replaceBlockAt(blocks, selectedPath, next))}
      storeId={storeId}
      products={products}
      categories={categories}
    />
  ) : (
    <>
      {adding ? (
        <div style={{ marginBottom: 18 }}>
          {/* 版面放最上面：先決定「東西排在哪」，再決定「排什麼」 */}
          <div className="sec" style={{ marginTop: 0 }}>版面</div>
          <div className="pe-add-grid">
            <button type="button" className="pe-add-btn" onClick={() => addColumns(2)}>
              <div className="pe-add-name">兩欄</div>
              <div className="pe-add-hint">例如左邊放圖、右邊放購買資訊</div>
            </button>
            <button type="button" className="pe-add-btn" onClick={() => addColumns(3)}>
              <div className="pe-add-name">三欄</div>
              <div className="pe-add-hint">三件事情並排，各佔三分之一</div>
            </button>
          </div>
          <div className="sec">商品元素</div>
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
        <div className="pe-list" onDragOver={(e) => { if (dragPath) e.preventDefault() }} onDrop={onDrop}>
          {blocks.map((block, i) => (
            block.type === 'columns'
              ? renderColumns(block, i)
              : renderItem(block, [i], blocks.length)
          ))}
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

/**
 * 用 id 找出區塊在樹裡的路徑（選中的那塊可能在某一欄裡）。
 * 回 [i] 或 [i, 欄, j]，找不到回 null —— 呼叫端據此當作「沒選中」。
 */
function findPath(blocks, id) {
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].id === id) return [i]
    if (blocks[i].type === 'columns') {
      const cols = blocks[i].columns || []
      for (let c = 0; c < cols.length; c++) {
        const j = cols[c].blocks.findIndex(b => b.id === id)
        if (j >= 0) return [i, c, j]
      }
    }
  }
  return null
}

function samePath(a, b) {
  if (!a || !b || a.length !== b.length) return false
  return a.every((v, i) => v === b[i])
}

// 把一塊放回它原本的位置（同一個容器、同一個縫）：插入點等於自己的索引或索引 +1。
function isNoOpMove(from, to) {
  if (from.length !== to.length) return false
  if (!from.slice(0, -1).every((v, i) => v === to[i])) return false
  const at = from[from.length - 1]
  return to[to.length - 1] === at || to[to.length - 1] === at + 1
}
