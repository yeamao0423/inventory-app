'use client'
import { useEffect, useRef } from 'react'

// 進場揭示：元素捲進視窗才淡入上移。用 IntersectionObserver，
// 不用 scroll 事件（那個每一幀都跑、手機直接掉幀）。
//
// 初始狀態寫在 CSS 的 .reveal，這裡只負責加上 .is-in。
// 沒有 JS 或 IntersectionObserver 不存在時，CSS 的 @supports 後備會讓內容直接顯示，
// 不會變成一片空白 —— 這是漸進增強，不是靠 JS 才看得到東西。
export default function Reveal({ children, delay = 0, as: Tag = 'div', className = '', ...rest }) {
  const ref = useRef(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      el.classList.add('is-in')
      return
    }
    const io = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return
        entry.target.classList.add('is-in')
        io.unobserve(entry.target)
      })
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return (
    <Tag
      ref={ref}
      className={`reveal ${className}`.trim()}
      style={delay ? { '--reveal-delay': `${delay}ms` } : undefined}
      {...rest}
    >
      {children}
    </Tag>
  )
}
