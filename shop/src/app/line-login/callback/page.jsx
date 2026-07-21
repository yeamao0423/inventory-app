'use client'
// LINE 登入（Web OAuth callback）：一般瀏覽器從 /auth 導去 LINE 授權後回到此頁
// ?code=xxx&state=xxx → 校驗 state（防 CSRF）→ 後端用 Channel Secret 換 token
// authorization code 只能用一次；後端會把 id_token 回傳，email 關卡第二輪用它續走。
import { useEffect, useRef } from 'react'
import { getStore } from '../../../lib/store'
import { useLineLogin, IDT_KEY, STATE_KEY } from '../useLineLogin'
import LoginCard from '../LoginCard'

export default function LineLoginCallbackPage() {
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

        // 同頁重整（email 關卡期間）：code 已用掉，改用暫存 id_token 續走
        const cached = sessionStorage.getItem(IDT_KEY)
        if (cached) { await start({ id_token: cached }); return }

        const params = new URLSearchParams(window.location.search)
        const code = params.get('code')
        const state = params.get('state')
        if (params.get('error')) { setPhase('error'); setMsg('你取消了 LINE 授權'); return }
        if (!code) { setPhase('error'); setMsg('缺少授權資訊，請重新登入'); return }

        const saved = sessionStorage.getItem(STATE_KEY)
        sessionStorage.removeItem(STATE_KEY)
        if (!saved || saved !== state) { setPhase('error'); setMsg('登入驗證失敗（state 不符），請重新登入'); return }

        // redirect_uri 必須與 /auth 發起授權時一致（LINE 會比對）
        const redirectUri = settings.line_callback_url || `${window.location.origin}/line-login/callback`

        await start({ code, redirect_uri: redirectUri })
      } catch (e) {
        setPhase('error'); setMsg(e?.message || '登入失敗，請重新操作')
      }
    })()
  }, [start, setPhase, setMsg])

  return <LoginCard flow={flow} />
}
