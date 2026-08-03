'use client'
// 聊天視窗的延遲載入外殼。
//
// shop/ 是 SSR + ISR 且做過 SEO 改造，聊天元件「不可」拖累首屏：
//   1. next/dynamic + ssr:false —— 不進 server render、不進首屏 HTML
//   2. 等瀏覽器閒下來（requestIdleCallback）才真的去抓那個 chunk
// 兩層合起來的效果是：首屏該有的東西全部畫完之後，聊天泡泡才出現。
import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'

const ChatWidget = dynamic(() => import('./ChatWidget'), { ssr: false, loading: () => null })

export default function ChatLauncher() {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let handle = null
    const start = () => setReady(true)
    if (typeof window.requestIdleCallback === 'function') {
      handle = window.requestIdleCallback(start, { timeout: 4000 })
      return () => window.cancelIdleCallback?.(handle)
    }
    handle = setTimeout(start, 2000)
    return () => clearTimeout(handle)
  }, [])

  if (!ready) return null
  return <ChatWidget />
}
