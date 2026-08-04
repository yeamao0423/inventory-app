// 後台 PWA 推播訂閱。
//
// 後台已經是 vite-plugin-pwa 的 PWA，service worker 是現成的；
// push / notificationclick 事件的處理在 public/push-sw.js（由 workbox importScripts 掛進 sw.js）。
//
// iOS 必須先「加入主畫面」、從主畫面圖示開啟，才拿得到 Notification 權限與推播。
import { supabase } from './supabase'

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || ''
const FLAG_KEY = 'daigogo_push_subscribed'

/** base64url 的 VAPID 公鑰 → PushManager 要的 Uint8Array */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/** ArrayBuffer → base64url（送給後端存起來當訂閱金鑰） */
function bufToBase64Url(buf) {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return window.btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * 裝置能力與設定完整性分開判斷。
 *
 * 兩者混成一個布林值害過人：線上漏設 VITE_VAPID_PUBLIC_KEY 時，收件匣顯示
 * 「此裝置不支援推播」，看起來像手機或「加入主畫面」的問題，實際上是部署設定漏了。
 * 純函式、不碰 window，方便測。
 */
export function evaluateSupport({ hasServiceWorker, hasPushManager, hasNotification, hasVapidKey }) {
  const device = !!(hasServiceWorker && hasPushManager && hasNotification)
  const configured = !!hasVapidKey
  return { device, configured, supported: device && configured }
}

export function pushState() {
  const hasWindow = typeof window !== 'undefined'
  const { device, configured, supported } = evaluateSupport({
    hasServiceWorker: hasWindow && 'serviceWorker' in navigator,
    hasPushManager: hasWindow && 'PushManager' in window,
    hasNotification: hasWindow && 'Notification' in window,
    hasVapidKey: !!VAPID_PUBLIC_KEY,
  })
  return {
    supported,
    deviceSupported: device,
    configured,
    // 權限問得到與否只看裝置，跟有沒有設 VAPID 公鑰無關
    permission: device ? Notification.permission : 'denied',
    subscribed: supported && localStorage.getItem(FLAG_KEY) === '1',
  }
}

export async function subscribePush({ storeId, userId }) {
  const state = pushState()
  if (!state.deviceSupported) throw new Error('這台裝置或瀏覽器不支援推播（iOS 需先加入主畫面）')
  if (!state.configured) throw new Error('推播尚未設定：部署環境缺少 VITE_VAPID_PUBLIC_KEY')
  if (!storeId || !userId) throw new Error('缺少店家或使用者資訊')

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('你沒有允許通知，請到瀏覽器設定開啟')

  const reg = await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    })
  }

  const json = sub.toJSON()
  const p256dh = json.keys?.p256dh ?? bufToBase64Url(sub.getKey('p256dh'))
  const auth = json.keys?.auth ?? bufToBase64Url(sub.getKey('auth'))

  // endpoint 是唯一鍵：同一台裝置重新訂閱就覆蓋原本那筆
  const { error } = await supabase.from('push_subscriptions').upsert({
    user_id: userId,
    store_id: storeId,
    endpoint: sub.endpoint,
    p256dh,
    auth,
  }, { onConflict: 'endpoint' })
  if (error) throw new Error('訂閱失敗：' + error.message)

  localStorage.setItem(FLAG_KEY, '1')
  return true
}

export async function unsubscribePush() {
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  if (sub) {
    await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint)
    await sub.unsubscribe()
  }
  localStorage.removeItem(FLAG_KEY)
  return true
}
