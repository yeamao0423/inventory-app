'use client'
import { useEffect, useRef, useState } from 'react'

// 數字補間。價格是這頁唯一會因為使用者操作而改變的關鍵資訊，
// 瞬間跳值看不出「剛才那一下讓總價變了」，所以補一段 320ms 的過渡。
//
// 三個刻意的設計：
//   * 首次 render 直接回終值 —— 進頁面不該看到價格從 0 跑上來，那是噪音不是回饋
//   * prefers-reduced-motion 直接回終值
//   * 用 rAF 不用 setInterval，且 cleanup 一定取消，避免快速連點留下多條動畫互相打架
export function useCountUp(value, duration = 320) {
  const [display, setDisplay] = useState(value)
  const fromRef = useRef(value)
  const firstRef = useRef(true)
  const rafRef = useRef(0)

  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false
      fromRef.current = value
      setDisplay(value)
      return
    }

    const reduce = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const from = fromRef.current
    if (reduce || from === value) {
      fromRef.current = value
      setDisplay(value)
      return
    }

    const start = performance.now()
    const tick = now => {
      const t = Math.min(1, (now - start) / duration)
      // easeOutCubic：一開始快、收尾慢，讀數停下來的那一刻最清楚
      const eased = 1 - Math.pow(1 - t, 3)
      setDisplay(Math.round(from + (value - from) * eased))
      if (t < 1) rafRef.current = requestAnimationFrame(tick)
      else fromRef.current = value
    }
    rafRef.current = requestAnimationFrame(tick)

    return () => cancelAnimationFrame(rafRef.current)
  }, [value, duration])

  return display
}
