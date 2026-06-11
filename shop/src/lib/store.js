import { supabase } from './supabase'

const DEFAULT_SLUG = 'daigogo'

let storePromise = null

function resolveSlug() {
  if (process.env.NEXT_PUBLIC_STORE_SLUG) return process.env.NEXT_PUBLIC_STORE_SLUG
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname
    if (hostname === 'localhost' || hostname === '127.0.0.1') return DEFAULT_SLUG
    return hostname.split('.')[0]
  }
  return DEFAULT_SLUG
}

export function getStore() {
  if (!storePromise) {
    storePromise = supabase
      .from('stores')
      .select('id, name, slug, settings, is_active')
      .eq('slug', resolveSlug())
      .single()
      .then(({ data, error }) => {
        if (error || !data) {
          storePromise = null // allow retry on transient failure
          throw error || new Error('Store not found')
        }
        return data
      })
  }
  return storePromise
}

export async function getStoreId() {
  const store = await getStore()
  return store.id
}
