'use client'
// 庫存補正：SSR 給的是快照（最舊一小時前），這支在瀏覽器補上當下的數字。
//
// 為什麼不改成動態渲染：商品頁要 SSR 出完整 HTML 給搜尋引擎與社群預覽，
// 那是 SEO 改造的成果，不能為了庫存新鮮度退回去。
//
// 為什麼不定時輪詢：這不是拍賣網站。掛載時取一次、分頁回到前景時再取一次就夠，
// 剩下的競態由 place_order 的 FOR UPDATE 檢查兜住。
//
// 失敗一律沿用 SSR 快照。寧可顯示舊資料，也不要把消費者鎖成不能購買。
import { useCallback, useEffect, useRef, useState } from 'react'

async function fetchStock(productIds) {
  const res = await fetch('/api/stock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productIds }),
  })
  if (!res.ok) throw new Error('stock fetch failed')
  return res.json()
}

export function useFreshStock(productIds) {
  const [state, setState] = useState({ products: null, variants: null, status: 'loading', at: null })
  // 陣列每次 render 都是新物件，用內容當依賴才不會無限重取
  const key = (productIds || []).filter(n => Number.isFinite(Number(n))).join(',')
  const keyRef = useRef(key)
  keyRef.current = key

  const load = useCallback(async () => {
    const ids = keyRef.current ? keyRef.current.split(',').map(Number) : []
    if (ids.length === 0) {
      setState({ products: {}, variants: {}, status: 'ready', at: null })
      return { products: {}, variants: {} }
    }
    try {
      const data = await fetchStock(ids)
      setState({ products: data.products, variants: data.variants, status: 'ready', at: data.at })
      return data
    } catch {
      // 取不到就維持 SSR 快照。寧可顯示舊資料，也不要讓整頁不能買。
      setState(s => ({ ...s, status: 'error' }))
      return null
    }
  }, [])

  useEffect(() => { load() }, [key, load])

  // 分頁被切到背景一陣子再回來，看到的不該是十分鐘前的庫存
  useEffect(() => {
    function onVisible() { if (!document.hidden) load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])

  return { ...state, refetch: load }
}

/**
 * 把 SSR 的 variants 換上新鮮庫存。回新陣列，fresh 沒有的項目維持原值。
 *
 * hasOwnProperty 不是龜毛：新庫存是 0 時必須覆蓋，而 0 正是「賣完了」。
 * 用 `if (map[v.id])` 之類的真值判斷會剛好漏掉唯一重要的那個值。
 *
 * @param {Array} variants SSR 帶下來的規格列
 * @param {{variants?: Object}|null} fresh useFreshStock 的結果或 refetch 的回傳
 */
export function mergeStock(variants, fresh) {
  const map = fresh?.variants
  if (!map) return variants || []
  return (variants || []).map(v => (
    Object.prototype.hasOwnProperty.call(map, v.id) ? { ...v, stock: map[v.id] } : v
  ))
}

/** 沒有規格的商品用 products.quantity。取不到就沿用原值。 */
export function mergeQuantity(quantity, productId, fresh) {
  const map = fresh?.products
  if (!map || !Object.prototype.hasOwnProperty.call(map, productId)) return quantity
  return map[productId]
}
