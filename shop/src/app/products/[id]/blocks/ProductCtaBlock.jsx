'use client'
// 加入購物車。
//
// anchorRef 由 ProductPageView 傳進來掛在外層：黏底購買列要知道「版面裡的這顆按鈕
// 有沒有被捲出畫面」才決定要不要滑出來。任何時刻畫面上只有一顆加入購物車，
// 這一顆與黏底那一顆是同一顆的兩個位置（見 ProductPageView 檔頭）。
import { useProductState } from '../ProductStateProvider'

export default function ProductCtaBlock({ block, anchorRef }) {
  const { ctaLabel, isUnavailable, addToCart } = useProductState()
  return (
    <div ref={anchorRef} className={`pp-cta${block.fullWidth ? '' : ' pp-cta-auto'}`}>
      <button type="button" className="add-btn" onClick={addToCart} disabled={isUnavailable}>
        {ctaLabel}
      </button>
    </div>
  )
}
