'use client'
import { useEffect, useRef, useState } from 'react'

// 黏底購買列的顯示時機。
//
// 規則刻意寫死成「主視覺裡的 CTA 被捲到畫面上方之後才顯示」，
// 不是「捲了 N px 就顯示」—— 後者在不同螢幕高度會亂掉，而且會出現
// 兩顆加入購物車同時在畫面上的情形。任何時刻只有一顆。
//
// 用 IntersectionObserver 而不是 scroll 事件：scroll 每一幀都跑，手機直接掉幀。
//
// anchorKey：錨點元素換人時要重掛 observer。寫死版面（ProductDetail、BundleDetail）
// 的錨點從頭到尾是同一個節點，不必傳；商品頁編排器的預覽裡店主一搬動區塊，
// CTA 就是另一個節點了，舊的 observer 還盯著已經卸載的元素 —— 那時要把區塊順序傳進來。
export function useBuyBar(anchorKey = '') {
  const anchorRef = useRef(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const el = anchorRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([entry]) => {
      // boundingClientRect.top < 0 才算「已經捲過去」；
      // 少了這個判斷，還沒捲到 CTA（它在畫面下方）時也會被當成看不見而彈出來。
      setVisible(!entry.isIntersecting && entry.boundingClientRect.top < 0)
    }, { threshold: 0 })
    io.observe(el)
    return () => io.disconnect()
  }, [anchorKey])

  return { anchorRef, visible }
}
