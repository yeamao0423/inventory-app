import { useEffect, useState } from 'react'

// CSS 的 media query 拿到 JS 這邊用。
// 為什麼不用 CSS 就好：即時預覽在窄螢幕要「整個不掛 iframe」，
// display:none 的 iframe 照樣會載入商城、照樣會連線，白花一次請求。
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  )

  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = e => setMatches(e.matches)
    setMatches(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])

  return matches
}
