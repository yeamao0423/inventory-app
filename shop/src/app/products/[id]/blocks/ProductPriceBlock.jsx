'use client'
// 價格。沿用 .detail-price 那組 class，品牌主色的規則（globals.css 的「品牌主色」段）
// 才會自動套到這裡 —— 特價維持紅色是刻意的，那是消費者認得的慣例。
import { useProductState } from '../ProductStateProvider'

export default function ProductPriceBlock({ block }) {
  const { price, sale, zh } = useProductState()
  const size = block.size === 'md' ? ' pp-price-md' : ''

  if (sale.onSale) {
    return (
      <div className={`detail-price pp-price${size}`}>
        <span className="detail-price-sale">NT${Number(sale.price).toLocaleString()}</span>
        <span className="detail-price-old">NT${Number(sale.original).toLocaleString()}</span>
        <span className="product-badge product-badge-sale">{zh ? '特價' : 'Sale'}</span>
      </div>
    )
  }
  return <div className={`detail-price pp-price${size}`}>NT${Number(price).toLocaleString()}</div>
}
