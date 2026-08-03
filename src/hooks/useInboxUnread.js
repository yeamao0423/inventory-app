import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from './useAuth'

// 導覽列「客服」上的未讀紅點：有幾條對話還沒被看過。
// 低頻輪詢即可 —— 真的要即時提醒靠的是 PWA 推播，不是這顆點。
const POLL_MS = 30_000

export function useInboxUnread() {
  const { storeId, isBackendUser } = useAuth()
  const [unread, setUnread] = useState(0)

  useEffect(() => {
    if (!storeId || !isBackendUser) { setUnread(0); return }
    let alive = true

    async function fetchCount() {
      if (document.hidden) return
      const { count } = await supabase
        .from('conversations')
        .select('id', { count: 'exact', head: true })
        .eq('store_id', storeId)
        .gt('unread_for_store', 0)
      if (alive) setUnread(count ?? 0)
    }

    fetchCount()
    const timer = setInterval(fetchCount, POLL_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [storeId, isBackendUser])

  return unread
}
