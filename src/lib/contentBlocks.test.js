import { describe, it, expect } from 'vitest'
import {
  BLOCK_TYPES, ALL_BLOCK_TYPES, CONTENT_VERSION, IMAGE_RATIOS,
  createBlock, normalizeContent, normalizeProductContent, isEmptyContent, blockCount,
  moveBlock, duplicateBlock, removeBlock, replaceBlock,
  TEMPLATES, buildTemplate, safeHref, splitParagraphs,
  getBlockAt, insertBlockAt, removeBlockAt, replaceBlockAt,
  duplicateBlockAt, moveBlockAt, moveBlockTo, createColumns, removeColumnAt,
  buildProductTemplate, mergeIntroIntoTemplate, flattenBlocks,
} from './contentBlocks'

// 這份測試的重點不是「好資料能過」，而是「壞資料不能讓商城炸掉」。
// blocks 是 jsonb，資料庫沒有 schema 保護，任何形狀都可能出現在這裡。

describe('normalizeContent — 沒編過與壞資料', () => {
  it('null / undefined 代表沒編過，回 null（商城走預設版面）', () => {
    expect(normalizeContent(null)).toBe(null)
    expect(normalizeContent(undefined)).toBe(null)
  })

  it('不是物件的東西一律當成沒編過', () => {
    expect(normalizeContent('hello')).toBe(null)
    expect(normalizeContent(42)).toBe(null)
    expect(normalizeContent(true)).toBe(null)
    expect(normalizeContent([{ type: 'text' }])).toBe(null)
  })

  it('blocks 不是陣列時回空內容，不丟例外', () => {
    expect(normalizeContent({ version: 1, blocks: 'nope' })).toEqual({ version: 1, blocks: [] })
    expect(normalizeContent({ version: 1 })).toEqual({ version: 1, blocks: [] })
    expect(normalizeContent({})).toEqual({ version: 1, blocks: [] })
  })

  it('未知型別的區塊被丟掉，其餘保留', () => {
    const out = normalizeContent({
      version: 1,
      blocks: [
        { type: 'video', src: 'x' },
        { type: 'text', title: '標題', body: '內文' },
        { type: 'carousel' },
      ],
    })
    expect(out.blocks).toHaveLength(1)
    expect(out.blocks[0].type).toBe('text')
  })

  it('陣列裡混進 null / 字串 / 沒有 type 的東西都被丟掉', () => {
    const out = normalizeContent({ blocks: [null, 'text', 7, {}, { type: null }, { type: 'text' }] })
    expect(out.blocks).toHaveLength(1)
  })

  it('版本號不是 1（含未來版本、壞值）時仍盡力正規化，並標回目前版本', () => {
    expect(normalizeContent({ version: 99, blocks: [{ type: 'text', body: 'x' }] }))
      .toEqual({ version: CONTENT_VERSION, blocks: [{ id: 'text-0', type: 'text', span: 12, title: '', body: 'x' }] })
    expect(normalizeContent({ version: 'abc', blocks: [] }).version).toBe(CONTENT_VERSION)
  })

  it('超過上限的區塊數被截斷（防止壞資料把頁面撐爆）', () => {
    const many = Array.from({ length: 200 }, () => ({ type: 'text', body: 'x' }))
    expect(normalizeContent({ blocks: many }).blocks.length).toBe(60)
  })
})

describe('normalizeContent — 缺欄位補預設', () => {
  it('hero 缺欄位時每個欄位都補成空字串', () => {
    const out = normalizeContent({ blocks: [{ type: 'hero' }] })
    expect(out.blocks[0]).toEqual({
      id: 'hero-0', type: 'hero', span: 12,
      image: '', title: '', subtitle: '', buttonText: '', buttonHref: '',
    })
  })

  it('media_text 的 imageSide / imageRatio 有壞值時退回預設', () => {
    const out = normalizeContent({
      blocks: [
        { type: 'media_text', imageSide: 'top', imageRatio: 42 },
        { type: 'media_text', imageSide: 'right', imageRatio: '33' },
      ],
    })
    expect(out.blocks[0].imageSide).toBe('left')
    expect(out.blocks[0].imageRatio).toBe(50)
    expect(out.blocks[1].imageSide).toBe('right')
    expect(out.blocks[1].imageRatio).toBe(33)
    IMAGE_RATIOS.forEach(r => expect(typeof r).toBe('number'))
  })

  it('products 的 mode / limit / productIds 都被收斂到合法範圍', () => {
    const out = normalizeContent({
      blocks: [
        { type: 'products', mode: 'random', limit: 999, productIds: 'x' },
        { type: 'products', mode: 'category', categoryId: '12', limit: 0, productIds: [1, '2', null, 'x', 3.7] },
      ],
    })
    expect(out.blocks[0].mode).toBe('manual')
    expect(out.blocks[0].limit).toBe(24)
    expect(out.blocks[0].productIds).toEqual([])
    expect(out.blocks[0].categoryId).toBe(null)
    expect(out.blocks[1].mode).toBe('category')
    expect(out.blocks[1].categoryId).toBe(12)
    expect(out.blocks[1].limit).toBe(1)
    expect(out.blocks[1].productIds).toEqual([1, 2, 3])
  })

  it('不認識的額外欄位被丟掉（白名單），型別錯的文字欄位被轉成字串', () => {
    const out = normalizeContent({
      blocks: [{ type: 'text', title: 123, body: { a: 1 }, onClick: 'alert(1)', style: 'color:red' }],
    })
    expect(out.blocks[0]).toEqual({ id: 'text-0', type: 'text', span: 12, title: '123', body: '' })
  })

  it('文字欄位長度有上限，不會讓單一區塊塞爆頁面', () => {
    const out = normalizeContent({ blocks: [{ type: 'text', body: 'x'.repeat(20000) }] })
    expect(out.blocks[0].body.length).toBe(5000)
  })

  it('保留既有 id，沒有 id 時依索引補一個穩定的', () => {
    const out = normalizeContent({ blocks: [{ id: 'keep-me', type: 'text' }, { type: 'text' }] })
    expect(out.blocks[0].id).toBe('keep-me')
    expect(out.blocks[1].id).toBe('text-1')
  })
})

describe('safeHref — 連結不可以變成 XSS 入口', () => {
  it('放行相對路徑、錨點、http(s)、mailto、tel', () => {
    expect(safeHref('/products')).toBe('/products')
    expect(safeHref('#section')).toBe('#section')
    expect(safeHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(safeHref('http://example.com')).toBe('http://example.com')
    expect(safeHref('mailto:a@b.co')).toBe('mailto:a@b.co')
    expect(safeHref('tel:0912345678')).toBe('tel:0912345678')
  })

  it('擋掉 javascript: / data: / vbscript:，含大小寫與前置空白的變形', () => {
    expect(safeHref('javascript:alert(1)')).toBe('')
    expect(safeHref('  JavaScript:alert(1)')).toBe('')
    expect(safeHref('java\tscript:alert(1)')).toBe('')
    expect(safeHref('data:text/html,<script>alert(1)</script>')).toBe('')
    expect(safeHref('vbscript:msgbox')).toBe('')
    expect(safeHref('//evil.com')).toBe('')
  })

  it('非字串一律回空字串', () => {
    expect(safeHref(null)).toBe('')
    expect(safeHref({})).toBe('')
    expect(safeHref(5)).toBe('')
  })

  it('正規化後的 hero buttonHref 走同一套規則', () => {
    const out = normalizeContent({ blocks: [{ type: 'hero', buttonHref: 'javascript:alert(1)' }] })
    expect(out.blocks[0].buttonHref).toBe('')
  })
})

describe('createBlock 與編輯操作', () => {
  it('四種型別都建得出來，且立刻能通過正規化', () => {
    expect(BLOCK_TYPES).toEqual(['hero', 'media_text', 'text', 'products'])
    for (const type of BLOCK_TYPES) {
      const block = createBlock(type)
      expect(block.type).toBe(type)
      expect(block.id).toBeTruthy()
      const out = normalizeContent({ version: 1, blocks: [block] })
      expect(out.blocks).toHaveLength(1)
      expect(out.blocks[0].id).toBe(block.id)
    }
  })

  it('未知型別建不出區塊', () => {
    expect(createBlock('video')).toBe(null)
  })

  it('每次建立的 id 都不一樣', () => {
    expect(createBlock('text').id).not.toBe(createBlock('text').id)
  })

  it('上移／下移在邊界時原樣回傳（同一個陣列參考不強制，但內容不變）', () => {
    const blocks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(moveBlock(blocks, 0, -1).map(b => b.id)).toEqual(['a', 'b', 'c'])
    expect(moveBlock(blocks, 2, 1).map(b => b.id)).toEqual(['a', 'b', 'c'])
    expect(moveBlock(blocks, 0, 1).map(b => b.id)).toEqual(['b', 'a', 'c'])
    expect(moveBlock(blocks, 2, -1).map(b => b.id)).toEqual(['a', 'c', 'b'])
    expect(blocks.map(b => b.id)).toEqual(['a', 'b', 'c']) // 不可就地改動
  })

  it('複製會插在原區塊後面，且拿到新的 id', () => {
    const blocks = [createBlock('text'), createBlock('hero')]
    const out = duplicateBlock(blocks, 0)
    expect(out).toHaveLength(3)
    expect(out[1].type).toBe('text')
    expect(out[1].id).not.toBe(out[0].id)
    expect(out[2].id).toBe(blocks[1].id)
  })

  it('刪除與取代都回新陣列', () => {
    const blocks = [{ id: 'a' }, { id: 'b' }]
    expect(removeBlock(blocks, 0).map(b => b.id)).toEqual(['b'])
    expect(removeBlock(blocks, 9)).toHaveLength(2)
    expect(replaceBlock(blocks, 1, { id: 'b', title: 'x' })[1].title).toBe('x')
    expect(blocks[1].title).toBe(undefined)
  })
})

describe('isEmptyContent / blockCount', () => {
  it('null、空 blocks、壞資料都算空', () => {
    expect(isEmptyContent(null)).toBe(true)
    expect(isEmptyContent({ version: 1, blocks: [] })).toBe(true)
    expect(isEmptyContent('x')).toBe(true)
    expect(isEmptyContent({ version: 1, blocks: [{ type: 'nope' }] })).toBe(true)
    expect(isEmptyContent({ version: 1, blocks: [{ type: 'text' }] })).toBe(false)
  })

  it('blockCount 只算得到正規化後留下來的區塊', () => {
    expect(blockCount(null)).toBe(0)
    expect(blockCount({ blocks: [{ type: 'text' }, { type: 'nope' }] })).toBe(1)
  })
})

describe('起始模板', () => {
  it('兩套模板：品牌形象型與賣貨型', () => {
    expect(Object.keys(TEMPLATES)).toEqual(['brand', 'selling'])
  })

  it('品牌形象型＝主視覺→圖文並排→商品精選', () => {
    const content = buildTemplate('brand')
    expect(content.blocks.map(b => b.type)).toEqual(['hero', 'media_text', 'products'])
  })

  it('賣貨型＝主視覺→商品精選→圖文並排→文字段落', () => {
    const content = buildTemplate('selling')
    expect(content.blocks.map(b => b.type)).toEqual(['hero', 'products', 'media_text', 'text'])
  })

  it('模板產出的內容原封不動通過正規化（不會被自己的驗證擋掉）', () => {
    for (const key of Object.keys(TEMPLATES)) {
      const content = buildTemplate(key)
      expect(normalizeContent(content)).toEqual(content)
    }
  })

  it('未知模板回 null', () => {
    expect(buildTemplate('nope')).toBe(null)
  })
})

describe('splitParagraphs — body 允許換行但不解析 Markdown', () => {
  it('依換行切段，去掉多餘空白行', () => {
    expect(splitParagraphs('第一段\n第二段\n\n第三段')).toEqual(['第一段', '第二段', '第三段'])
  })

  it('相容 \\r\\n', () => {
    expect(splitParagraphs('a\r\nb')).toEqual(['a', 'b'])
  })

  it('空字串與非字串回空陣列', () => {
    expect(splitParagraphs('')).toEqual([])
    expect(splitParagraphs('   ')).toEqual([])
    expect(splitParagraphs(null)).toEqual([])
  })

  it('不解析 Markdown、不吃掉標記字元 —— 原樣留給渲染層逸出', () => {
    expect(splitParagraphs('**粗體** 與 <b>標籤</b>')).toEqual(['**粗體** 與 <b>標籤</b>'])
  })
})

describe('欄容器 columns', () => {
  const col = (span, blocks) => ({ span, blocks })
  const wrap = (columns) => ({ version: 1, blocks: [{ type: 'columns', columns }] })

  it('只有商品頁那組放行清單認得欄容器', () => {
    expect(ALL_BLOCK_TYPES).toContain('columns')
    expect(BLOCK_TYPES).not.toContain('columns')
  })

  it('正規化保留欄與子區塊，並補上 id', () => {
    const out = normalizeProductContent(wrap([
      col(6, [{ type: 'product_gallery' }]),
      col(6, [{ type: 'product_title' }, { type: 'product_price' }]),
    ]))
    expect(out.blocks).toHaveLength(1)
    const b = out.blocks[0]
    expect(b.type).toBe('columns')
    expect(b.id).toBeTruthy()
    expect(b.columns).toHaveLength(2)
    expect(b.columns[0].span).toBe(6)
    expect(b.columns[0].id).toBeTruthy()
    expect(b.columns[1].blocks.map(x => x.type)).toEqual(['product_title', 'product_price'])
  })

  it('欄容器沒有自己的 span（一律吃滿整列）', () => {
    const b = normalizeProductContent(wrap([col(6, []), col(6, [])])).blocks[0]
    expect(b.span).toBeUndefined()
  })

  it('欄裡再放欄會被丟棄', () => {
    const b = normalizeProductContent(wrap([
      col(6, [{ type: 'columns', columns: [col(6, []), col(6, [])] }, { type: 'text', title: 'ok' }]),
      col(6, []),
    ])).blocks[0]
    expect(b.columns[0].blocks.map(x => x.type)).toEqual(['text'])
  })

  it('欄數少於 2 補到 2、多於 3 截到 3', () => {
    expect(normalizeProductContent(wrap([col(12, [])])).blocks[0].columns).toHaveLength(2)
    expect(normalizeProductContent(wrap([col(3, []), col(3, []), col(3, []), col(3, [])]))
      .blocks[0].columns).toHaveLength(3)
  })

  it('壞掉的欄變成空欄，不丟例外', () => {
    const b = normalizeProductContent({ version: 1, blocks: [
      { type: 'columns', columns: [null, 'nope', { span: 6, blocks: 'x' }] },
    ] }).blocks[0]
    expect(b.columns).toHaveLength(3)
    b.columns.forEach(c => expect(c.blocks).toEqual([]))
  })

  it('columns 不是陣列時整塊丟棄', () => {
    expect(normalizeProductContent({ version: 1, blocks: [{ type: 'columns', columns: 'nope' }] }).blocks)
      .toEqual([])
  })

  it('span 不在允許值內時退回 6', () => {
    const b = normalizeProductContent(wrap([col(99, []), col('x', [])])).blocks[0]
    expect(b.columns[0].span).toBe(6)
    expect(b.columns[1].span).toBe(6)
  })

  it('首頁（預設放行清單）不接受欄容器', () => {
    expect(normalizeContent(wrap([col(6, []), col(6, [])])).blocks).toEqual([])
  })

  it('巢狀總數受 MAX_BLOCKS 限制', () => {
    const many = Array.from({ length: 40 }, () => ({ type: 'text', title: 't' }))
    const out = normalizeProductContent({ version: 1, blocks: [
      { type: 'columns', columns: [col(6, many), col(6, many)] },
      { type: 'text', title: '最後' },
    ] })
    const count = out.blocks.reduce((n, b) =>
      n + 1 + (b.columns ? b.columns.reduce((m, c) => m + c.blocks.length, 0) : 0), 0)
    expect(count).toBeLessThanOrEqual(60)
  })

  it('同一個欄容器裡的子區塊不會撞 id', () => {
    const b = normalizeProductContent(wrap([
      col(6, [{ type: 'text', title: 'a' }]),
      col(6, [{ type: 'text', title: 'b' }]),
    ])).blocks[0]
    expect(b.columns[0].blocks[0].id).not.toBe(b.columns[1].blocks[0].id)
    expect(b.columns[0].id).not.toBe(b.columns[1].id)
  })

  it('舊的扁平內容正規化後與加這個功能之前相同（回歸）', () => {
    const flat = { version: 1, blocks: [
      { type: 'product_gallery', span: 6 },
      { type: 'product_title', span: 6 },
    ] }
    const out = normalizeProductContent(flat)
    expect(out.blocks.map(b => [b.type, b.span])).toEqual([
      ['product_gallery', 6], ['product_title', 6],
    ])
  })
})

describe('路徑版編輯操作', () => {
  const flat = () => ([
    { id: 'a', type: 'text', span: 12, title: 'A', body: '' },
    { id: 'cols', type: 'columns', columns: [
      { id: 'c0', span: 6, blocks: [{ id: 'x', type: 'text', span: 12, title: 'X', body: '' }] },
      { id: 'c1', span: 6, blocks: [{ id: 'y', type: 'text', span: 12, title: 'Y', body: '' }] },
    ] },
    { id: 'b', type: 'text', span: 12, title: 'B', body: '' },
  ])

  it('getBlockAt 取得頂層與巢狀區塊', () => {
    expect(getBlockAt(flat(), [0]).id).toBe('a')
    expect(getBlockAt(flat(), [1, 1, 0]).id).toBe('y')
    expect(getBlockAt(flat(), [9])).toBe(null)
    expect(getBlockAt(flat(), [1, 5, 0])).toBe(null)
  })

  it('insertBlockAt 插進指定位置', () => {
    const nb = { id: 'n', type: 'text', span: 12, title: 'N', body: '' }
    expect(insertBlockAt(flat(), [0], nb).map(b => b.id)).toEqual(['n', 'a', 'cols', 'b'])
    expect(insertBlockAt(flat(), [1, 0, 0], nb)[1].columns[0].blocks.map(b => b.id))
      .toEqual(['n', 'x'])
  })

  it('removeBlockAt 移除頂層與巢狀', () => {
    expect(removeBlockAt(flat(), [0]).map(b => b.id)).toEqual(['cols', 'b'])
    expect(removeBlockAt(flat(), [1, 0, 0])[1].columns[0].blocks).toEqual([])
  })

  it('replaceBlockAt 換掉指定位置', () => {
    const nb = { id: 'n', type: 'text', span: 12, title: 'N', body: '' }
    expect(replaceBlockAt(flat(), [1, 1, 0], nb)[1].columns[1].blocks[0].id).toBe('n')
  })

  it('duplicateBlockAt 複製並給新 id', () => {
    const out = duplicateBlockAt(flat(), [1, 0, 0])
    const list = out[1].columns[0].blocks
    expect(list).toHaveLength(2)
    expect(list[1].id).not.toBe(list[0].id)
    expect(list[1].title).toBe('X')
  })

  it('複製欄容器時連子區塊的 id 都換掉', () => {
    const out = duplicateBlockAt(flat(), [1])
    const orig = out[1]
    const copy = out[2]
    expect(copy.type).toBe('columns')
    expect(copy.id).not.toBe(orig.id)
    expect(copy.columns.map(c => c.id)).not.toEqual(orig.columns.map(c => c.id))
    expect(copy.columns[0].blocks[0].id).not.toBe(orig.columns[0].blocks[0].id)
    expect(copy.columns[0].blocks[0].title).toBe('X')
  })

  it('moveBlockAt 只在自己的容器內移動', () => {
    const withTwo = insertBlockAt(flat(), [1, 0, 1], { id: 'x2', type: 'text', span: 12, title: '', body: '' })
    expect(moveBlockAt(withTwo, [1, 0, 0], 1)[1].columns[0].blocks.map(b => b.id)).toEqual(['x2', 'x'])
    // 到邊界就不動，不會跳到別的容器
    expect(moveBlockAt(flat(), [1, 0, 0], -1)[1].columns[0].blocks.map(b => b.id)).toEqual(['x'])
  })

  it('moveBlockTo 可以跨容器', () => {
    const out = moveBlockTo(flat(), [0], [1, 1, 0])       // 頂層 a → 第二欄最前面
    expect(out.map(b => b.id)).toEqual(['cols', 'b'])
    expect(out[0].columns[1].blocks.map(b => b.id)).toEqual(['a', 'y'])
  })

  it('moveBlockTo 從欄裡搬到頂層', () => {
    const out = moveBlockTo(flat(), [1, 0, 0], [0])
    expect(out.map(b => b.id)).toEqual(['x', 'a', 'cols', 'b'])
    expect(out[2].columns[0].blocks).toEqual([])
  })

  it('moveBlockTo 在同一個容器內往後搬時不會多退一格', () => {
    const out = moveBlockTo(flat(), [0], [2])   // a 搬到 cols 後面
    expect(out.map(b => b.id)).toEqual(['cols', 'a', 'b'])
  })

  it('非法路徑一律回原陣列', () => {
    const src = flat()
    expect(removeBlockAt(src, [99])).toBe(src)
    expect(replaceBlockAt(src, [1, 9, 0], {})).toBe(src)
    expect(moveBlockTo(src, [9], [0])).toBe(src)
  })

  it('createColumns 給合法的預設形狀', () => {
    const c2 = createColumns(2)
    expect(c2.type).toBe('columns')
    expect(c2.columns.map(c => c.span)).toEqual([6, 6])
    expect(createColumns(3).columns.map(c => c.span)).toEqual([4, 4, 4])
  })

  it('createColumns 產出的欄容器原封不動通得過正規化', () => {
    const content = { version: CONTENT_VERSION, blocks: [createColumns(3)] }
    expect(normalizeProductContent(content)).toEqual(content)
  })

  it('removeColumnAt 把內容搬到相鄰欄，不刪掉店主的東西', () => {
    const out = removeColumnAt(flat(), 1, 1)       // 刪第二欄
    expect(out[1].columns).toHaveLength(1)
    expect(out[1].columns[0].blocks.map(b => b.id)).toEqual(['x', 'y'])
  })

  it('removeColumnAt 刪第一欄時內容往後搬', () => {
    const out = removeColumnAt(flat(), 1, 0)
    expect(out[1].columns[0].blocks.map(b => b.id)).toEqual(['y', 'x'])
  })

  it('舊的扁平 API 行為不變', () => {
    const src = flat()
    expect(removeBlock(src, 0).map(b => b.id)).toEqual(['cols', 'b'])
    expect(moveBlock(src, 0, 1).map(b => b.id)).toEqual(['cols', 'a', 'b'])
  })
})

describe('buildProductTemplate — 左圖右資訊', () => {
  it('回傳一個欄容器：左欄圖庫、右欄購買動線', () => {
    const t = buildProductTemplate()
    expect(t.blocks).toHaveLength(1)
    const cols = t.blocks[0]
    expect(cols.type).toBe('columns')
    expect(cols.columns).toHaveLength(2)
    expect(cols.columns[0].blocks.map(b => b.type)).toEqual(['product_gallery'])
    expect(cols.columns[1].blocks.map(b => b.type)).toEqual([
      'product_title', 'product_price', 'product_desc', 'product_options',
      'product_status', 'product_qty', 'product_note', 'product_cta',
    ])
  })

  it('產出的內容通得過正規化且不變形', () => {
    const t = buildProductTemplate()
    expect(normalizeProductContent(t)).toEqual(t)
  })

  it('每個區塊都有互不相同的 id', () => {
    const t = buildProductTemplate()
    const ids = t.blocks.flatMap(b => [b.id, ...b.columns.flatMap(c => [c.id, ...c.blocks.map(x => x.id)])])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('flattenBlocks 把欄裡的子區塊也攤出來', () => {
    const t = buildProductTemplate()
    const flatTypes = flattenBlocks(t.blocks).map(b => b.type)
    expect(flatTypes[0]).toBe('columns')
    expect(flatTypes.filter(x => x !== 'columns')).toHaveLength(9)
    expect(flatTypes).toContain('product_cta')
  })

  it('flattenBlocks 對 null／壞資料不丟例外', () => {
    expect(flattenBlocks(null)).toEqual([])
    expect(flattenBlocks([null, { type: 'columns' }])).toHaveLength(1)
  })

  it('mergeIntroIntoTemplate 把既有 intro 接在最後、各佔滿版', () => {
    const merged = mergeIntroIntoTemplate(buildProductTemplate(), {
      version: 1, blocks: [{ type: 'text', title: '購買須知', body: '內容' }],
    })
    expect(merged.blocks).toHaveLength(2)
    expect(merged.blocks[1].type).toBe('text')
    expect(merged.blocks[1].span).toBe(12)
  })
})
