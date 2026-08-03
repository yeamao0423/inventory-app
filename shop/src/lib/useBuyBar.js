'use client'
import { useEffect, useRef, useState } from 'react'

// 黏底購買列的顯示時機。
//
// 規則刻意寫死成「主視覺裡的 CTA 被捲到畫面上方之後才顯示」，
// 不是「捲了 N px 就顯示」—— 後者在不同螢幕高度會亂掉，而且會出現
// 兩顆加入購物車同時在畫面上的情形。任何時刻只有一顆。
//
// 到 footer 就收回去：黏底列是固定定位的，捲到底時會整條蓋在 footer 上，
// 服務條款、隱私權、聯絡方式全都點不到 —— 被蓋住的連結等於不存在。
// 不用「給 footer 補 padding」那條路，因為補償值必須等於購買列高度，
// 而它在手機上會變（見 globals.css 的 max-width: 600px 那幾條），
// 寫死的數字遲早對不上，變成有時多留空白、有時還是遮到。
// 收起來則完全不依賴任何高度數字，而且與上面那條「任何時刻只有一顆」是同一個道理：
// 商品內容都捲完了，這顆按鈕的班也該交了。
//
// 用 IntersectionObserver 而不是 scroll 事件：scroll 每一幀都跑，手機直接掉幀。
//
// anchorKey：錨點元素換人時要重掛 observer。寫死版面（ProductDetail、BundleDetail）
// 的錨點從頭到尾是同一個節點，不必傳；商品頁編排器的預覽裡店主一搬動區塊，
// CTA 就是另一個節點了，舊的 observer 還盯著已經卸載的元素 —— 那時要把區塊順序傳進來。
export function useBuyBar(anchorKey = '') {
  const anchorRef = useRef(null)
  const [pastAnchor, setPastAnchor] = useState(false)
  const [atFooter, setAtFooter] = useState(false)

  useEffect(() => {
    const el = anchorRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([entry]) => {
      // boundingClientRect.top < 0 才算「已經捲過去」；
      // 少了這個判斷，還沒捲到 CTA（它在畫面下方）時也會被當成看不見而彈出來。
      setPastAnchor(!entry.isIntersecting && entry.boundingClientRect.top < 0)
    }, { threshold: 0 })
    io.observe(el)
    return () => io.disconnect()
  }, [anchorKey])

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    // footer 在 layout.jsx，不是這棵樹的一部分，所以只能用選擇器找。
    // 找不到就當作沒有 footer（例如預覽的 iframe 裡），維持原本的行為。
    const footer = document.querySelector('.footer')
    if (!footer) return
    // threshold 0：footer 一碰到視窗下緣就開始重疊，那一刻正是該收起來的時機。
    const io = new IntersectionObserver(([entry]) => setAtFooter(entry.isIntersecting), { threshold: 0 })
    io.observe(footer)
    return () => io.disconnect()
  }, [])

  return { anchorRef, visible: pastAnchor && !atFooter }
}
