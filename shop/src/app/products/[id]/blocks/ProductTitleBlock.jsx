'use client'
// 商品名稱（＋標籤）。整頁只有這裡是 h1 —— 區塊可以被排到任何位置，但標題層級不能因此亂掉。
import { useProductState } from '../ProductStateProvider'

export default function ProductTitleBlock({ block }) {
  const { name, productTags, lang } = useProductState()
  return (
    <div className="pp-title-block">
      <h1 className="detail-name">{name}</h1>
      {block.showTags && productTags.length > 0 && (
        <div className="pp-tags">
          {productTags.map(tg => (
            <span key={tg.id} className="product-tag">
              {lang === 'en' && tg.name_en ? tg.name_en : tg.name}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
