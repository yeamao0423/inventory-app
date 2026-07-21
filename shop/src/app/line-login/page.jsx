'use client'
// LINE 登入（LIFF 入口）：LINE App 內開頁即自動登入；一般瀏覽器開此頁也可用
// （LIFF 會轉去 LINE 網頁認證再回來）。已綁定者無感登入；未綁定者進 email 關卡。
// 支援 ?redirect=/checkout 回跳參數（LIFF 認證來回會保留）。
import { useEffect, useRef } from 'react'
import { getStore } from '../../lib/store'
import { useLineLogin, loadLiff, IDT_KEY } from './useLineLogin'
import LoginCard from './LoginCard'

const FALLBACK_LIFF_ID = process.env.NEXT_PUBLIC_LIFF_ID || '2010616155-bJSaanw4'

export default function LineLoginPage() {
  const flow = useLineLogin()
  const started = useRef(false)
  const { start, setPhase, setMsg } = flow

  useEffect(() => {
    if (started.current) return
    started.current = true
    ;(async () => {
      try {
        // 功能閘門：需平台開通＋店家啟用（後端 line-login 也會擋，這裡先給友善訊息）
        let settings = {}
        try { settings = (await getStore()).settings ?? {} } catch { /* 查不到店家交給後端擋 */ }
        if (!(settings.line_login_provisioned && settings.line_login_enabled)) {
          setPhase('error'); setMsg('此商店尚未啟用 LINE 登入'); return
        }

        // 同頁重整（email 關卡期間）：直接用暫存 id_token 續走，不重跑 LIFF
        const cached = sessionStorage.getItem(IDT_KEY)
        if (cached) { await start({ id_token: cached }); return }

        const liffId = settings.line_liff_id || FALLBACK_LIFF_ID
        const liff = await loadLiff()
        await liff.init({ liffId })
        if (!liff.isLoggedIn()) {
          liff.login({ redirectUri: window.location.href }) // 認證後回本頁自動續走
          return
        }
        const idToken = liff.getIDToken()
        if (!idToken) { setPhase('error'); setMsg('取不到 LINE 驗證資訊，請重新操作'); return }
        await start({ id_token: idToken })
      } catch (e) {
        setPhase('error'); setMsg(e?.message || 'LIFF 初始化失敗')
      }
    })()
  }, [start, setPhase, setMsg])

  return <LoginCard flow={flow} />
}
