'use client'
// 商品頁的互動狀態，抽成 context 供各個 product_* 區塊共用。
//
// 為什麼要抽出來：區塊化之後「規格選擇」與「價格」「數量」「加入購物車」可能被店主
// 排到版面上任何地方（甚至不相鄰），沒有共同的父元件可以用 props 串。
// 但這些東西彼此連動 —— 換一個規格會同時改變價格、庫存、可買不可買、圖庫顯示哪幾張圖，
// 少了任何一條連動就會出現「畫面寫有貨、按下去說缺貨」這種對不起客人的狀況。
//
// 內容是從 ProductDetail.jsx 原封搬過來的，刻意不改行為 —— 這是搬家不是改寫。
// 兩邊會有一段時間並存（沒編排過的店走 ProductDetail，編排過的走 ProductPageView），
// 所以那邊的邏輯若有修正，這裡要跟著改。
import { createContext, useContext, useEffect, useState } from 'react'
import { useI18n, useCart } from '../../layout'
import { getActivePrice } from '../../../lib/salePrice'
import { trackPixel } from '../../../lib/metaPixel'
import { visibleImages, indexOfRepImage } from '../../../lib/variantImages'
import { useFreshStock, mergeStock, mergeQuantity } from '../../../lib/useFreshStock'
import { isValueSoldOut as valueSoldOut, initialOptions, valuesForType } from '../../../lib/variantStock'

const ProductStateContext = createContext(null)

/** 區塊元件用這支讀狀態。忘了包 Provider 會拿到 null，讓錯誤當場炸掉而不是靜靜畫錯。 */
export function useProductState() {
  return useContext(ProductStateContext)
}

export default function ProductStateProvider({
  sp, variants: rawVariants, customOptions, optTypes, productTags, children,
}) {
  const { t, lang } = useI18n()
  const { addItem } = useCart()
  const [customNote, setCustomNote] = useState('')
  const [qty, setQty] = useState(1)
  const [added, setAdded] = useState(false)
  const [addError, setAddError] = useState(null)
  const [autoSwitched, setAutoSwitched] = useState(null)   // { from, to } 或 null

  const p = sp.products

  // 收單／預購狀態要在初始選擇之前算好 —— 挑「第一個還有貨的值」需要 skipStock，
  // 晚一步算會拿到 undefined，預購商品的初始選擇會被誤判成缺貨。
  const isCollection = !!sp.collection_end
  const isPreorder = !isCollection && !!sp.skip_stock_check
  const collectionExpired = isCollection && new Date(sp.collection_end) < new Date()
  const markedSoldOut = sp.sold_out
  const skipStock = sp.skip_stock_check || isCollection

  // SSR 的庫存最舊可能是一小時前的快照，補正之後底下所有可選性判斷才是真的。
  // 補正還沒回來（或失敗）時 mergeStock 原樣回傳，頁面就是原本的行為。
  const fresh = useFreshStock([p.id])
  const variants = mergeStock(rawVariants, fresh)
  const quantity = mergeQuantity(p.quantity, p.id, fresh)

  // 哪些規格類型被這個商品的 variants 使用（由 props 推導，server/client 結果一致）
  const usedTypeIds = new Set()
  variants.forEach(v => Object.keys(v.options || {}).forEach(tid => usedTypeIds.add(Number(tid))))
  const activeTypes = optTypes.filter(ty => usedTypeIds.has(ty.id))

  // 初始選擇：每個維度挑第一個還有貨的值，全缺貨才退回第一個。
  // 與組合商品頁同一支函式 —— 同一件商品在兩條路徑上不該有不同的預設選擇。
  // 這裡用 rawVariants：首次 render 時補正還沒回來，SSR 與 client 首渲染必須一致。
  const [selectedOptions, setSelectedOptions] = useState(
    () => initialOptions(rawVariants, activeTypes, skipStock),
  )
  // 圖庫預覽目前顯示第幾張，跟著 setOption 連動跳到該規格對應的圖 —— 不能放在 Gallery
  // 元件內部，元件重畫時會被沖掉。
  const [galleryIndex, setGalleryIndex] = useState(0)

  const name = lang === 'en' && sp.name_en ? sp.name_en : p.name
  const desc = lang === 'en' ? sp.desc_en : sp.desc_zh
  const sortedImages = [...(p.product_images || [])].sort((a, b) => a.sort_order - b.sort_order)
  const zh = lang === 'zh'

  // 依目前選到的規格過濾 gallery；若過濾後為空（該規格無專屬圖且無共用圖）則退回全部，避免開天窗
  const visible = visibleImages(sortedImages, selectedOptions)
  // galleryIndex 是靠上次選規格算出來的，若換規格後圖片變少可能會超出範圍 —— 退回第一張，不要炸掉。
  const galleryIndexSafe = galleryIndex >= 0 && galleryIndex < visible.length ? galleryIndex : 0

  // Meta Pixel：瀏覽商品事件（每次進入詳情頁發一次）
  useEffect(() => {
    trackPixel('ViewContent', {
      content_ids: [String(p.id)],
      content_name: p.name,
      content_type: 'product',
      value: sp.shop_price,
      currency: 'TWD',
    })
  }, [p.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // 庫存補正回來時，如果客人正選著的規格已經賣完，幫他換到同維度第一個有貨的。
  // 但一定要講 —— 默默改掉客人的選擇比不改更糟。
  useEffect(() => {
    if (fresh.status !== 'ready') return
    for (const type of activeTypes) {
      const tid = String(type.id)
      const cur = selectedOptions[tid]
      if (!cur || !valueSoldOut(variants, selectedOptions, type.id, cur, skipStock)) continue
      const values = valuesForType(type, variants)
      const next = values.find(v => !valueSoldOut(variants, selectedOptions, type.id, v.id, skipStock))
      if (!next) continue
      const label = id => type.variant_option_values?.find(v => v.id === id)?.value ?? ''
      setAutoSwitched({ from: label(cur), to: label(next.id) })
      setSelectedOptions(o => ({ ...o, [tid]: next.id }))
      break
    }
  }, [fresh.at, fresh.status]) // eslint-disable-line react-hooks/exhaustive-deps

  // Find current variant based on selected options
  const currentVariant = variants.find(v =>
    Object.entries(selectedOptions).every(([tid, vid]) => v.options?.[tid] === vid)
  )
  const stock = currentVariant?.stock ?? (variants.length === 0 ? quantity : 0)
  const stockSoldOut = stock <= 0 && !skipStock
  const isSoldOut = markedSoldOut || stockSoldOut
  const isUnavailable = isSoldOut || collectionExpired
  const regularPrice = currentVariant?.variant_price != null ? Number(currentVariant.variant_price) : sp.shop_price + (currentVariant?.price_adjustment || 0)
  const sale = getActivePrice(sp, regularPrice, currentVariant?.sale_price)
  const price = sale.price

  // Human-readable label for cart
  const variantLabel = activeTypes.map(type => {
    const vid = selectedOptions[String(type.id)]
    const val = type.variant_option_values?.find(v => v.id === vid)
    return val ? val.value : null
  }).filter(Boolean).join(' / ')

  // 按鈕上的字。狀態有優先序：剛加入 → 缺貨 → 收單截止 → 庫存為零 → 正常。
  // 抽成一個值是因為黏底購買列與版面裡的 CTA 是同一顆按鈕的兩個位置，字必須一致。
  const ctaLabel = added
    ? '✓ ' + (zh ? '已加入' : 'Added!')
    : markedSoldOut
      ? (zh ? '缺貨中' : 'Out of Stock')
      : collectionExpired
        ? (zh ? '收單已截止' : 'Collection Ended')
        : stockSoldOut
          ? t('product.sold_out')
          : t('product.add_to_cart')

  // 規格可選性：與組合商品頁共用 lib/variantStock，區塊只吃 (typeId, valueId) 這個簡短簽名
  function isValueSoldOut(typeId, valueId) {
    return valueSoldOut(variants, selectedOptions, typeId, valueId, skipStock)
  }

  function setOption(typeId, valueId) {
    // 客人自己動手挑之後，「已幫你改成…」那句就過期了
    setAutoSwitched(null)
    setAddError(null)
    const next = { ...selectedOptions, [String(typeId)]: valueId }
    setSelectedOptions(next)
    // 篩選規格的同時，把預覽跳到該規格真正對應的那一張，而不是靠 remount 巧合停在第一張。
    const nextVisible = visibleImages(sortedImages, next)
    const idx = indexOfRepImage(nextVisible, typeId, valueId)
    setGalleryIndex(idx >= 0 ? idx : 0)
  }

  async function addToCart() {
    // 即時再檢查一次收單是否已截止
    if (sp.collection_end && new Date(sp.collection_end) < new Date()) {
      alert(lang === 'zh' ? '收單已截止，無法加入購物車' : 'Collection period has ended')
      return
    }
    if (isUnavailable) return
    setAddError(null)

    // 頁面可能開很久了。按下去的這一刻再確認一次，不要讓客人填完整張結帳表才知道沒貨。
    // refetch 失敗（now 為 null）就照常加入 —— place_order 仍會擋，
    // 把客人卡在「連不到伺服器所以不能買」是更糟的結果。
    const now = await fresh.refetch()
    if (now && !skipStock) {
      const merged = mergeStock(rawVariants, now)
      const cur = merged.find(v => v.id === currentVariant?.id)
      const left = cur ? cur.stock : mergeQuantity(p.quantity, p.id, now)
      if (left < qty) {
        setAddError(zh
          ? (left > 0 ? `這個規格只剩 ${left} 件了` : '這件剛剛被買走了')
          : (left > 0 ? `Only ${left} left` : 'Just sold out'))
        return
      }
    }

    addItem({
      id: p.id,
      sku: p.sku,
      name,
      price,
      variantId: currentVariant?.id || null,
      variantLabel,
      customNote,
      qty,
      image: sortedImages[0]?.url || null,
      isCollection: skipStock,
    })
    setAdded(true)
    setTimeout(() => setAdded(false), 2000)
  }

  // 刻意不 memo：這裡面每一個值都是「選了哪個規格」的函數，狀態一動所有區塊本來就都要重畫。
  // 包 useMemo 只會多一份依賴清單要維護，漏寫一個就變成畫面停在舊價格 —— 那是最難查的一種 bug。
  const value = ({
    // 原始資料
    sp, p, variants, customOptions, optTypes, productTags,
    // i18n
    t, lang, zh, name, desc,
    // 狀態
    selectedOptions, qty, customNote, added,
    // 庫存補正的兩則對客人的交代（見 ProductOptionsBlock / ProductCtaBlock）
    autoSwitched, addError,
    // 衍生
    activeTypes, currentVariant, stock, skipStock, isCollection, isPreorder, collectionExpired,
    markedSoldOut, stockSoldOut, isSoldOut, isUnavailable,
    // context 的 key 維持 visibleImages（ProductGalleryBlock 在讀它），值換成本地的 visible
    price, sale, variantLabel, sortedImages, visibleImages: visible, ctaLabel,
    // 圖庫預覽目前該停在第幾張（ProductGalleryBlock 讀這個，不再自己管 current）
    galleryIndex: galleryIndexSafe, setGalleryIndex,
    // 動作
    setOption, setQty, setCustomNote, addToCart, isValueSoldOut,
  })

  return (
    <ProductStateContext.Provider value={value}>
      {children}
    </ProductStateContext.Provider>
  )
}
