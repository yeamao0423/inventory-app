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

const ProductStateContext = createContext(null)

/** 區塊元件用這支讀狀態。忘了包 Provider 會拿到 null，讓錯誤當場炸掉而不是靜靜畫錯。 */
export function useProductState() {
  return useContext(ProductStateContext)
}

export default function ProductStateProvider({
  sp, variants, customOptions, optTypes, productTags, children,
}) {
  const { t, lang } = useI18n()
  const { addItem } = useCart()
  const [customNote, setCustomNote] = useState('')
  const [qty, setQty] = useState(1)
  const [added, setAdded] = useState(false)

  // 哪些規格類型被這個商品的 variants 使用（由 props 推導，server/client 結果一致）
  const usedTypeIds = new Set()
  variants.forEach(v => Object.keys(v.options || {}).forEach(tid => usedTypeIds.add(Number(tid))))
  const activeTypes = optTypes.filter(ty => usedTypeIds.has(ty.id))

  // 初始選擇：每個類型的第一個可用值
  const [selectedOptions, setSelectedOptions] = useState(() => {
    const initial = {}
    activeTypes.forEach(type => {
      const valueIds = [...new Set(variants.map(v => v.options?.[String(type.id)]).filter(Boolean))]
      if (valueIds.length) initial[String(type.id)] = valueIds[0]
    })
    return initial
  })

  const p = sp.products
  const name = lang === 'en' && sp.name_en ? sp.name_en : p.name
  const desc = lang === 'en' ? sp.desc_en : sp.desc_zh
  const sortedImages = [...(p.product_images || [])].sort((a, b) => a.sort_order - b.sort_order)
  const zh = lang === 'zh'

  // 依目前選到的規格過濾 gallery；若過濾後為空（該規格無專屬圖且無共用圖）則退回全部，避免開天窗
  const matched = sortedImages.filter(img => imageMatches(img, selectedOptions))
  const visibleImages = matched.length ? matched : sortedImages

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

  // Collection / sold_out status
  const isCollection = !!sp.collection_end
  const collectionExpired = isCollection && new Date(sp.collection_end) < new Date()
  const markedSoldOut = sp.sold_out
  const skipStock = sp.skip_stock_check || isCollection

  // Find current variant based on selected options
  const currentVariant = variants.find(v =>
    Object.entries(selectedOptions).every(([tid, vid]) => v.options?.[tid] === vid)
  )
  const stock = currentVariant?.stock ?? (variants.length === 0 ? p.quantity : 0)
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

  // Check if a value is sold out given current selections for other types
  function isValueSoldOut(typeId, valueId) {
    if (skipStock) return false
    const matching = variants.filter(v => {
      if (v.options?.[String(typeId)] !== valueId) return false
      return Object.entries(selectedOptions).every(([tid, vid]) => {
        if (Number(tid) === typeId) return true
        return v.options?.[tid] === undefined || v.options?.[tid] === vid
      })
    })
    if (matching.length === 0) return true
    return matching.every(v => v.stock <= 0)
  }

  function setOption(typeId, valueId) {
    setSelectedOptions(s => ({ ...s, [String(typeId)]: valueId }))
  }

  function addToCart() {
    // 即時再檢查一次收單是否已截止
    if (sp.collection_end && new Date(sp.collection_end) < new Date()) {
      alert(lang === 'zh' ? '收單已截止，無法加入購物車' : 'Collection period has ended')
      return
    }
    if (isUnavailable) return
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
    // 衍生
    activeTypes, currentVariant, stock, skipStock, isCollection, collectionExpired,
    markedSoldOut, stockSoldOut, isSoldOut, isUnavailable,
    price, sale, variantLabel, sortedImages, visibleImages, ctaLabel,
    // 動作
    setOption, setQty, setCustomNote, addToCart, isValueSoldOut,
  })

  return (
    <ProductStateContext.Provider value={value}>
      {children}
    </ProductStateContext.Provider>
  )
}

// 規格對應圖片：tag_filter={"<typeId>":[valueId,...]}；null=共用圖。
// 規則：每個有設限的維度，目前選到的值要落在允許清單內才顯示。
export function imageMatches(img, selectedOptions) {
  const tf = img.tag_filter
  if (!tf) return true
  return Object.entries(tf).every(([typeId, vals]) => {
    if (!Array.isArray(vals) || vals.length === 0) return true
    const sel = selectedOptions[typeId]
    return sel == null || vals.map(Number).includes(Number(sel))
  })
}

// 某規格值的代表圖：images 已依 sort_order 排序，取第一張綁到該值的圖
export function repImageFor(images, typeId, valueId) {
  return images.find(img => {
    const allowed = img.tag_filter?.[String(typeId)]
    return Array.isArray(allowed) && allowed.map(Number).includes(Number(valueId))
  }) || null
}
