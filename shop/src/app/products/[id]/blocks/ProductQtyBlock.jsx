'use client'
// 數量。上限跟著目前選到的規格走：收單商品（skipStock）沒有上限，其餘不得超過庫存。
import { useProductState } from '../ProductStateProvider'

export default function ProductQtyBlock({ block }) {
  const { t, qty, setQty, stock, skipStock, isSoldOut, isUnavailable } = useProductState()

  return (
    <div className="spec-group">
      <div className="spec-label">{t('product.qty')}</div>
      <div className="qty-wrap">
        <button type="button" className="qty-btn" disabled={isUnavailable}
          onClick={() => setQty(q => Math.max(1, q - 1))}>−</button>
        <span className="qty-num">{qty}</span>
        <button type="button" className="qty-btn" disabled={isUnavailable}
          onClick={() => setQty(q => skipStock ? q + 1 : Math.min(stock, q + 1))}>+</button>
        {/* 收單商品沒有即時庫存可講，講了反而誤導 —— 所以 skipStock 時不管店主怎麼設都不顯示 */}
        {block.showStock && !skipStock && (
          <span className="pp-stock">
            {isSoldOut
              ? <span className="pp-stock-out">{t('product.sold_out')}</span>
              : <span className="pp-stock-in">{t('product.in_stock')} ({stock})</span>}
          </span>
        )}
      </div>
    </div>
  )
}
