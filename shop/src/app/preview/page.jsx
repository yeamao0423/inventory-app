// 草稿預覽：讓店主在發佈前，用商城真正的樣子看一次已存檔的草稿（開新分頁那顆按鈕）。
// 編輯途中「打字就跟著變」的那種預覽在 preview/live/，兩者共用 guard.js 的身分閘門。
//
// 快取：next.config.js 已對 /preview/:path* 送 no-store，這裡再加 force-dynamic 與 noindex 兩道。
import { getStoreByHost } from '../../lib/data'
import Blocks, { hasBlocks } from '../blocks/Blocks'
import BrandStyle from '../BrandStyle'
import Notice from './Notice'
import { previewClient, previewConfigured, isStoreMember } from './guard'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: '草稿預覽',
  robots: { index: false, follow: false },
}

export default async function PreviewPage({ searchParams }) {
  const token = typeof searchParams?.t === 'string' ? searchParams.t : ''
  const target = searchParams?.target === 'product' ? 'product' : 'home'
  const productId = Number(searchParams?.id)

  if (!previewConfigured) return <Notice title="預覽不可用" detail="商城環境變數未設定。" />
  if (!token) return <Notice title="需要登入" detail="請從後台的「預覽」按鈕開啟，網址需要帶上你的登入憑證。" />

  const sb = previewClient(token)
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return <Notice title="憑證已失效" detail="請回後台重新整理後再按一次預覽。" />

  let storeId = null
  let content = null
  let store = null

  if (target === 'product') {
    if (!Number.isFinite(productId)) return <Notice title="缺少商品" detail="預覽網址少了商品編號。" />
    // 未上架的商品也要看得到草稿 → 走該使用者的 RLS（is_store_member 那條）
    const { data: sp } = await sb
      .from('storefront_products')
      .select('store_id, intro_blocks_draft, products(name)')
      .eq('product_id', productId).maybeSingle()
    if (!sp) return <Notice title="找不到商品" detail="這個商品不存在，或你的帳號沒有權限。" />
    storeId = sp.store_id
    content = sp.intro_blocks_draft
  } else {
    store = await getStoreByHost()
    if (!store) return <Notice title="找不到店家" detail="這個網域沒有對應的店。" />
    storeId = store.id
    const { data } = await sb.from('stores').select('home_blocks_draft').eq('id', storeId).maybeSingle()
    content = data?.home_blocks_draft ?? null
  }

  if (!await isStoreMember(sb, user.id, storeId)) {
    return <Notice title="沒有權限" detail="你的帳號不是這家店的後台成員。" />
  }

  if (!store) {
    const { data } = await sb.from('stores').select('id, name, settings').eq('id', storeId).maybeSingle()
    store = data
  }

  return (
    <>
      <BrandStyle store={store} />
      <div style={{
        background: '#8a5c00', color: '#fff', padding: '8px 16px',
        fontSize: 13, textAlign: 'center',
      }}>
        草稿預覽 —— 這是還沒發佈的內容，客人看不到。按「發佈」後才會換上商城。
      </div>
      {hasBlocks(content)
        ? <Blocks content={content} storeId={storeId} />
        : <Notice title="草稿是空的" detail="回後台加幾個區塊，或先套一套起始模板。" />}
    </>
  )
}
