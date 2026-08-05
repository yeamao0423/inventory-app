// 即時庫存查詢。商品頁與組合頁是 ISR 靜態頁（最舊可能一小時前的快照），
// 而下單扣庫存不會觸發任何快取失效 —— 所以賣完的規格會繼續顯示成可選，
// 消費者填完整張表才被 place_order 擋下。這支就是用來補正那段落差。
//
// 一律用 anon key 走 RLS（與 lib/data.js 同一個規則，共用 lib/supabase 那個 client）：
// migration 39 對 anon 封鎖了 variant_cost，走 anon 等於白拿一層成本保護。
// 明列欄位而不是 select('*') 也是同一個理由。
//
// products 走 shop_products 視圖：migration 21 之後 products 本表對 anon 是關的
//（成本欄位在裡面），視圖只露安全欄位且只含已上架商品。
import { NextResponse } from 'next/server'
import { supabase } from '../../../lib/supabase'

// 組合商品最多也就十幾件。超過這個數代表呼叫端有問題，不該默默照做。
const MAX_IDS = 50

export async function POST(req) {
  if (!supabase) {
    return NextResponse.json({ error: 'server not configured' }, { status: 500 })
  }

  const body = await req.json().catch(() => ({}))
  const ids = Array.isArray(body?.productIds)
    ? [...new Set(body.productIds.map(Number).filter(n => Number.isInteger(n) && n > 0))]
    : []

  if (ids.length === 0) return NextResponse.json({ error: 'productIds required' }, { status: 400 })
  if (ids.length > MAX_IDS) return NextResponse.json({ error: 'too many productIds' }, { status: 400 })

  const [{ data: variants }, { data: products }] = await Promise.all([
    // 明列欄位：這張表有 variant_cost，成本不可出現在消費者拿得到的回應裡
    supabase.from('product_variants').select('id, product_id, stock').in('product_id', ids),
    supabase.from('shop_products').select('id, quantity').in('id', ids),
  ])

  const out = {
    products: Object.fromEntries((products ?? []).map(p => [p.id, Number(p.quantity) || 0])),
    variants: Object.fromEntries((variants ?? []).map(v => [v.id, Number(v.stock) || 0])),
    at: new Date().toISOString(),
  }

  // 這支的意義就是不被快取。少了這個 header，Next 或 CDN 會把它當成可快取的 POST 回應。
  return NextResponse.json(out, { headers: { 'Cache-Control': 'no-store' } })
}
