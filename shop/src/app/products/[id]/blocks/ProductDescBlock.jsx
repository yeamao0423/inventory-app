'use client'
// 商品描述（依語系取 desc_zh / desc_en）。沒填就整塊不出現，不留一段空白。
// white-space: pre-line 由 .detail-desc 提供，店主打的換行看得到、但不解析任何標記。
import { useProductState } from '../ProductStateProvider'

export default function ProductDescBlock() {
  const { desc } = useProductState()
  if (!desc) return null
  return <p className="detail-desc pp-desc">{desc}</p>
}
