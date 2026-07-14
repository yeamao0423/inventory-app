import { supabase } from './supabase'

const DEFAULT_SLUG = 'daigogo'
const STORE_COLS = 'id, name, slug, settings, is_active'

let storePromise = null

// 子網域 / env / 本機 → slug
function resolveSlug() {
  if (process.env.NEXT_PUBLIC_STORE_SLUG) return process.env.NEXT_PUBLIC_STORE_SLUG
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname
    if (hostname === 'localhost' || hostname === '127.0.0.1') return DEFAULT_SLUG
    return hostname.split('.')[0]
  }
  return DEFAULT_SLUG
}

// 完整 hostname，供 custom_domain 比對（客戶綁自己的網域）。
// env 指定 slug、本機、*.localhost 一律回 null（不走 custom_domain）。
function resolveHost() {
  if (process.env.NEXT_PUBLIC_STORE_SLUG) return null
  if (typeof window === 'undefined') return null
  const h = window.location.hostname
  if (h === 'localhost' || h === '127.0.0.1' || h.endsWith('.localhost')) return null
  return h
}

async function fetchStore() {
  // 1) 先用完整網域比對 custom_domain（最後階段：客戶綁自己的網域，如 daigoking.com）
  const host = resolveHost()
  if (host) {
    const { data } = await supabase
      .from('stores').select(STORE_COLS)
      .eq('custom_domain', host).eq('is_active', true)
      .maybeSingle()
    if (data) return data
  }
  // 2) 退回子網域 / env / 預設 slug（寄生期：daigoking.daigogo.com → slug=daigoking）
  const { data, error } = await supabase
    .from('stores').select(STORE_COLS)
    .eq('slug', resolveSlug())
    .single()
  if (error || !data) throw error || new Error('Store not found')
  return data
}

export function getStore() {
  if (!storePromise) {
    storePromise = fetchStore().catch(err => {
      storePromise = null // 允許下次重試
      throw err
    })
  }
  return storePromise
}

export async function getStoreId() {
  const store = await getStore()
  return store.id
}

// 該店已發佈的靜態頁（footer 連結用）。anon 讀取，RLS 只露出 is_published。
export async function getStorePages() {
  const store = await getStore()
  const { data } = await supabase
    .from('store_pages').select('slug, title, sort_order')
    .eq('store_id', store.id).eq('is_published', true)
    .order('sort_order').order('id')
  return data || []
}
