'use client'
// 即時預覽的畫布：聽父視窗（後台編輯器）推來的草稿，用商城正式的渲染器重畫。
//
// 這是整條路徑上唯一的 client component。它用的 BlocksView 沒有 'use client'，
// 所以在這裡會被當成 client 元件編譯 —— 而商城正式頁面用同一支時仍然是 server 元件。
// 一份版面、兩種身分，不必維護兩套渲染器（見 blocks/BlocksView.jsx 檔頭）。
//
// 商品不重新查資料庫：server 端已經把精簡快照帶下來，挑選規則走 pickBlockProducts
// （與正式站同一支純函式），所以預覽挑出來的商品順序、數量都跟發佈後一致。
import { useEffect, useMemo, useState } from 'react'
import { normalizeContent } from '../../../lib/contentBlocks'
import { pickBlockProducts } from '../../../lib/blockProducts'
import { readPreviewMessage, PREVIEW_READY } from '../../../lib/previewBridge'
import BlocksView from '../../blocks/BlocksView'

function Hint({ title, detail }) {
  return (
    <div className="container" style={{ padding: '72px 20px', textAlign: 'center', color: 'var(--text-2)' }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13.5 }}>{detail}</div>
    </div>
  )
}

export default function LiveCanvas({ catalog, categories, parentOrigin }) {
  const [content, setContent] = useState(null)

  useEffect(() => {
    function onMessage(e) {
      const next = readPreviewMessage(e, parentOrigin)
      if (next) setContent(next)
    }
    window.addEventListener('message', onMessage)
    // listener 掛好之後才敢說 ready：先說的話，後台推的第一份會掉在地上，預覽卡在空白
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: PREVIEW_READY }, parentOrigin)
    }
    return () => window.removeEventListener('message', onMessage)
  }, [parentOrigin])

  // 正規化在這裡做，跟正式站同一支：後台推什麼過來都不會畫出比正式站更寬鬆的東西
  const blocks = useMemo(() => normalizeContent(content)?.blocks ?? null, [content])

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
  return <BlocksView blocks={blocks} productsByBlock={productsByBlock} />
}
