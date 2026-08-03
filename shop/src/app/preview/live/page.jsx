// 即時預覽：後台編輯器把它嵌成 iframe，打字時用 postMessage 把草稿推進來，畫面立刻跟著變。
//
// 與隔壁 /preview（開新分頁看已存檔草稿）的差別只有內容從哪來：那邊讀資料庫，這邊聽父視窗。
// 身分閘門完全一樣（guard.js），所以「沒登入／不是這家店的人」看到的一樣是提示、不是內容。
//
// server 端在這裡只做兩件事：驗身分、把商品清單撈成精簡快照交給 client。
// 有快照，client 端才能在不打 API 的情況下即時重算「商品精選」要顯示哪幾件。
//
// 快取：next.config.js 已對 /preview/:path* 送 no-store，這裡再加 force-dynamic 與 noindex 兩道。
import { getStoreByHost, getProductList } from '../../../lib/data'
import { isSafeOrigin } from '../../../lib/previewBridge'
import BrandStyle from '../../BrandStyle'
import Notice from '../Notice'
import { previewClient, previewConfigured, isStoreMember } from '../guard'
import LiveCanvas from './LiveCanvas'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: '即時預覽',
  robots: { index: false, follow: false },
}

// 快照上限。商品很多的店不該為了預覽把幾百 KB 的 JSON 塞進 iframe；
// 一個區塊最多顯示 24 件，挑得到就夠了。
const MAX_CATALOG = 500

// 商品卡片實際用得到的欄位而已（名稱／分類／首圖／價格與規格價）。
// 成本、庫存、標籤這些一律不送進瀏覽器 —— 預覽是給店主看版面的，不是資料出口。
function toCatalogRow(sp) {
  const p = sp.products || {}
  const cover = [...(p.product_images || [])].sort((a, b) => a.sort_order - b.sort_order)[0]
  return {
    product_id: sp.product_id,
    shop_price: sp.shop_price,
    sale_price: sp.sale_price,
    on_sale: sp.on_sale,
    sale_start: sp.sale_start,
    sale_end: sp.sale_end,
    products: {
      name: p.name,
      category_id: p.category_id,
      product_images: cover ? [{ url: cover.url, sort_order: cover.sort_order }] : [],
      product_variants: (p.product_variants || []).map(v => ({
        variant_price: v.variant_price, sale_price: v.sale_price,
      })),
    },
  }
}

export default async function LivePreviewPage({ searchParams }) {
  const token = typeof searchParams?.t === 'string' ? searchParams.t : ''
  const parentOrigin = typeof searchParams?.parentOrigin === 'string' ? searchParams.parentOrigin : ''
  const target = searchParams?.target === 'product' ? 'product' : 'home'
  const productId = Number(searchParams?.id)

  if (!previewConfigured) return <Notice title="預覽不可用" detail="商城環境變數未設定。" />
  if (!token) return <Notice title="需要登入" detail="請從後台開啟預覽，網址需要帶上你的登入憑證。" />
  // parentOrigin 之後會拿去當 postMessage 的 targetOrigin，形狀不對就不玩（不退回 '*'）
  if (!isSafeOrigin(parentOrigin)) {
    return <Notice title="預覽網址不完整" detail="請回後台重新開啟即時預覽。" />
  }

  const sb = previewClient(token)
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return <Notice title="憑證已失效" detail="請回後台按「重新連線」。" />

  // 這份預覽屬於哪家店：首頁看網域，商品介紹看那件商品掛在誰底下
  let store = null
  let storeId = null
  if (target === 'product') {
    if (!Number.isFinite(productId)) return <Notice title="缺少商品" detail="預覽網址少了商品編號。" />
    // 未上架的商品也要看得到 → 走該使用者的 RLS（is_store_member 那條）
    const { data: sp } = await sb
      .from('storefront_products').select('store_id')
      .eq('product_id', productId).maybeSingle()
    if (!sp) return <Notice title="找不到商品" detail="這個商品不存在，或你的帳號沒有權限。" />
    storeId = sp.store_id
  } else {
    store = await getStoreByHost()
    if (!store) return <Notice title="找不到店家" detail="這個網域沒有對應的店。" />
    storeId = store.id
  }

  if (!await isStoreMember(sb, user.id, storeId)) {
    return <Notice title="沒有權限" detail="你的帳號不是這家店的後台成員。" />
  }

  if (!store) {
    const { data } = await sb.from('stores').select('id, name, settings').eq('id', storeId).maybeSingle()
    store = data
  }

  const { products, categories } = await getProductList(storeId)

  return (
    <>
      <BrandStyle store={store} />
      <LiveCanvas
        catalog={products.slice(0, MAX_CATALOG).map(toCatalogRow)}
        categories={categories.map(c => ({ id: c.id, parent_id: c.parent_id }))}
        parentOrigin={parentOrigin}
      />
    </>
  )
}
