'use client'
// 即時預覽的畫布：聽父視窗（後台編輯器）推來的草稿，用商城正式的渲染器重畫。
//
// 這是整條路徑上唯一的 client component。它用的 BlocksView 沒有 'use client'，
// 所以在這裡會被當成 client 元件編譯 —— 而商城正式頁面用同一支時仍然是 server 元件。
// 一份版面、兩種身分，不必維護兩套渲染器（見 blocks/BlocksView.jsx 檔頭）。
//
// 兩種畫布：
//   target='home'    首頁編排。內容直接交給 BlocksView。
//   target='product' 商品頁編排。範本內容 + 一份商品快照 → ProductPageView，
//                    畫出來的是完整商品頁（含規格連動與黏底購買列），與正式站同一支元件。
//
// 商品不重新查資料庫：server 端已經把精簡快照帶下來，挑選規則走 pickBlockProducts
// （與正式站同一支純函式），所以預覽挑出來的商品順序、數量都跟發佈後一致。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { normalizeContent, normalizeProductContent } from '../../../lib/contentBlocks'
import { pickBlockProducts } from '../../../lib/blockProducts'
import {
  readPreviewMessage, readHighlightMessage, PREVIEW_READY, PREVIEW_SELECT,
} from '../../../lib/previewBridge'
import BlocksView from '../../blocks/BlocksView'
import ProductPageView from '../../products/[id]/ProductPageView'

function Hint({ title, detail }) {
  return (
    <div className="container" style={{ padding: '72px 20px', textAlign: 'center', color: 'var(--text-2)' }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13.5 }}>{detail}</div>
    </div>
  )
}

export default function LiveCanvas({ catalog, categories, parentOrigin, target = 'home', product = null }) {
  const [content, setContent] = useState(null)
  // 編輯模式的兩個旗標跟著內容一起推過來（見 previewBridge：它們刻意放在訊息頂層）
  const [editing, setEditing] = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  // hover 高亮走另一則輕訊息，不跟內容一起推
  const [highlightId, setHighlightId] = useState(null)
  const isProduct = target === 'product'

  useEffect(() => {
    function onMessage(e) {
      const next = readPreviewMessage(e, parentOrigin)
      if (next) {
        setContent(next.content)
        setEditing(next.editing)
        setSelectedId(next.selectedId)
        return
      }
      const hi = readHighlightMessage(e, parentOrigin)
      if (hi !== undefined) setHighlightId(hi)
    }
    window.addEventListener('message', onMessage)
    // listener 掛好之後才敢說 ready：先說的話，後台推的第一份會掉在地上，預覽卡在空白
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: PREVIEW_READY }, parentOrigin)
    }
    return () => window.removeEventListener('message', onMessage)
  }, [parentOrigin])

  // 點預覽裡的區塊 → 告訴後台切到那一塊的設定。
  // 只送 id，不送內容：內容的唯一真相在後台的編輯器裡，這邊送回去只會打架。
  const onSelectBlock = useCallback((blockId) => {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: PREVIEW_SELECT, blockId: blockId ?? null }, parentOrigin)
    }
  }, [parentOrigin])

  // 正規化在這裡做，跟正式站同一支：後台推什麼過來都不會畫出比正式站更寬鬆的東西。
  // 商品頁範本要多放行 product_* 那組動態區塊，首頁維持只放行靜態區塊。
  const blocks = useMemo(() => {
    const norm = isProduct ? normalizeProductContent(content) : normalizeContent(content)
    return norm?.blocks ?? null
  }, [content, isProduct])

  const productsByBlock = useMemo(() => {
    const out = {}
    for (const b of blocks || []) {
      if (b.type === 'products') out[b.id] = pickBlockProducts(catalog, categories, b)
    }
    return out
  }, [blocks, catalog, categories])

  if (blocks === null) {
    return <Hint title="等待後台連線…" detail="如果一直停在這裡，回後台按一次「重新連線」。" />
  }
  if (blocks.length === 0) {
    return <Hint title="還沒有任何區塊" detail="在左邊新增區塊或套一套起始模板，這裡會立刻跟著出現。" />
  }

  if (isProduct) {
    // 快照撈不到（商品被刪、權限被撤）就不要硬畫：ProductPageView 每一塊都要讀商品
    if (!product) {
      return <Hint title="讀不到這件商品" detail="商品可能已被刪除，或你的帳號沒有權限看它。" />
    }
    return (
      <ProductPageView
        sp={product.sp}
        variants={product.variants}
        customOptions={product.customOptions}
        optTypes={product.optTypes}
        productTags={product.productTags}
        blocks={blocks}
        productsByBlock={productsByBlock}
        editing={editing}
        selectedId={selectedId}
        highlightId={highlightId}
        onSelectBlock={onSelectBlock}
      />
    )
  }

  return <BlocksView blocks={blocks} productsByBlock={productsByBlock} />
}
