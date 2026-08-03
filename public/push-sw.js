// 後台 PWA 推播的 service worker 片段。
// 由 vite.config.js 的 workbox.importScripts 掛進 vite-plugin-pwa 產生的 sw.js，
// 這樣就不用改成 injectManifest 策略、也不會動到既有的離線快取行為。

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch (_e) {
    data = { title: '新的客服訊息', body: event.data ? event.data.text() : '' }
  }

  const title = data.title || '新的客服訊息'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      // 同一條對話的多則通知會疊在一起，不洗版
      tag: data.conversationId ? `conversation-${data.conversationId}` : 'customer-inbox',
      renotify: true,
      data: { url: data.url || '/inbox' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = (event.notification.data && event.notification.data.url) || '/inbox'
  event.waitUntil((async () => {
    const url = new URL(target, self.location.origin)
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    // 後台已經開著就直接切過去，不要再開一個分頁
    for (const client of clients) {
      if (new URL(client.url).origin === url.origin && 'focus' in client) {
        if ('navigate' in client) await client.navigate(url.href)
        return client.focus()
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url.href)
  })())
})
