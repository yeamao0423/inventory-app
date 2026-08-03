'use client'
// 收單／缺貨提示。三種狀態互斥，三種都不成立時整塊不出現（正常在賣的商品不需要提示框）。
import { useProductState } from '../ProductStateProvider'

export default function ProductStatusBlock() {
  const { sp, zh, isCollection, collectionExpired, markedSoldOut } = useProductState()

  // 缺貨的優先序最高：已標記缺貨時不必再告訴客人收單什麼時候截止
  if (markedSoldOut) {
    return (
      <div className="pp-status pp-status-red">
        <div className="pp-status-title">{zh ? '缺貨中' : 'Out of Stock'}</div>
      </div>
    )
  }
  if (collectionExpired) {
    return (
      <div className="pp-status pp-status-muted">
        <div className="pp-status-title">{zh ? '收單已截止' : 'Collection period has ended'}</div>
      </div>
    )
  }
  if (isCollection) {
    return (
      <div className="pp-status pp-status-amber">
        <div className="pp-status-title">{zh ? '限時收單商品' : 'Limited-Time Collection'}</div>
        <div className="pp-status-detail">
          {zh ? '收單截止：' : 'Deadline: '}
          {new Date(sp.collection_end).toLocaleString(zh ? 'zh-TW' : 'en-US', {
            month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
          })}
        </div>
      </div>
    )
  }
  return null
}
