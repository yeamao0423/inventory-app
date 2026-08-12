'use client'
import { useState, useEffect, useRef } from 'react'
import { isComposing } from '../../lib/imeSafeEnter'
import { useRouter } from 'next/navigation'
import { supabase } from '../../lib/supabase'
import { getStore, getStoreId } from '../../lib/store'
import { trackPixel } from '../../lib/metaPixel'
import { fetchBundlesByIds } from '../../lib/bundles'
import { bundleIdsInCart, cartLineKey, computeCartTotals } from '../../lib/bundleCart'
import { saveCheckoutDraft, readCheckoutDraft, cvsFromSearchParams } from '../../lib/checkoutDraft'
import { CVS_SUBTYPES } from '../../lib/ecpay'
import { useI18n, useCart, useUser } from '../layout'

// 電子地圖四大 C2C 通路的顯示名稱（純 UI 文字，非綠界規格的一部分）
const CVS_SUBTYPE_LABELS = {
  UNIMARTC2C: { zh: '7-11', en: '7-ELEVEN' },
  FAMIC2C: { zh: '全家', en: 'FamilyMart' },
  HILIFEC2C: { zh: '萊爾富', en: 'Hi-Life' },
  OKMARTC2C: { zh: 'OK超商', en: 'OK Mart' },
}

export default function CheckoutPage() {
  const { t, lang } = useI18n()
  const { cart, clearCart, removeItem, updateQty, appendTo, cancelAppend, hydrated } = useCart()
  const { user } = useUser()
  const router = useRouter()
  // 加購模式：購物車要併進既有訂單，不建新單也不重填收件資料
  const isAppend = !!appendTo?.token
  const [appendOrder, setAppendOrder] = useState(null)
  const [form, setForm] = useState({
    name: '', phone: '', email: '', store_name: '', store_number: '', line_id: '', remittance_last5: '', note: '',
    payment_method: 'remittance',   // 'credit' | 'cod' | 'remittance'
    shipping_subtype: 'UNIMARTC2C',
    cvs_store_id: '', cvs_store_name: '', cvs_address: '',
  })
  const [errors, setErrors] = useState({})
  const [submitting, setSubmitting] = useState(false)
  const [profileLoaded, setProfileLoaded] = useState(false)
  const [store, setStore] = useState(null)
  // 送出前的庫存攔截與 place_order 的錯誤共用同一塊區域。
  // 兩者都是「按了送出卻沒成功」，用 alert 打回票等於把人趕出流程。
  const [stockIssues, setStockIssues] = useState([])
  const [placeError, setPlaceError] = useState('')
  // 手機版是單欄，送出鈕在上、摘要在下：不捲過去的話按了送出像是什麼都沒發生
  const issueRef = useRef(null)
  useEffect(() => {
    if (stockIssues.length > 0 || placeError) {
      issueRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [stockIssues, placeError])

  useEffect(() => {
    getStore().then(setStore).catch(() => {})
  }, [])

  // 從草稿還原過付款方式的標記。下面 [store] 那個 effect 會在 store 載入後套預設值，
  // 而 getStore() 是 promise，一定晚於本 effect 執行——沒有這個標記的話，客人選了
  // 「貨到付款」去挑門市、回來會被靜靜改成信用卡，一按送出就被導去刷卡。
  const paymentRestoredRef = useRef(false)

  // 從綠界電子地圖選完店導回：先還原離開前存的草稿，再套上選到的門市資訊。
  // 一次性：讀完即清 sessionStorage，也把 query 清掉避免重新整理時重跑。
  useEffect(() => {
    const cvs = cvsFromSearchParams(new URLSearchParams(window.location.search))
    if (!cvs) return
    const draft = readCheckoutDraft(window.sessionStorage)
    if (draft?.payment_method) paymentRestoredRef.current = true
    setForm(f => ({
      ...f, ...(draft || {}),
      cvs_store_id: cvs.cvs_store_id,
      cvs_store_name: cvs.cvs_store_name,
      cvs_address: cvs.cvs_address,
      shipping_subtype: cvs.shipping_subtype || f.shipping_subtype,
    }))
    window.history.replaceState({}, '', '/checkout')
  }, [])

  useEffect(() => {
    if (!isAppend) return
    supabase.rpc('get_consumer_order', { p_token: appendTo.token })
      .then(({ data }) => setAppendOrder(data))
  }, [isAppend, appendTo?.token])

  useEffect(() => {
    if (hydrated && cart.length === 0 && !submitting) router.push('/cart')
  }, [hydrated, cart.length, submitting])

  // Meta Pixel：進入結帳事件（購物車就緒後發一次）
  const checkoutTracked = useRef(false)
  useEffect(() => {
    if (checkoutTracked.current || cart.length === 0) return
    checkoutTracked.current = true
    trackPixel('InitiateCheckout', {
      content_ids: cart.map(i => String(i.id)),
      num_items: cart.reduce((s, i) => s + i.qty, 0),
      value: cart.reduce((s, i) => s + i.price * i.qty, 0),
      currency: 'TWD',
    })
  }, [cart])

  // 登入用戶自動帶入個人資料
  useEffect(() => {
    if (!user || profileLoaded) return
    async function loadProfile() {
      const { data } = await supabase.from('consumers').select('name, phone, line_id').eq('id', user.id).single()
      if (data) {
        setForm(f => ({
          ...f,
          name: f.name || data.name || '',
          phone: f.phone || data.phone || '',
          email: f.email || user.email || '',
          line_id: f.line_id || data.line_id || '',
        }))
      } else {
        setForm(f => ({ ...f, email: f.email || user.email || '' }))
      }
      setProfileLoaded(true)
    }
    loadProfile()
  }, [user])

  // 優惠券
  const [couponCode, setCouponCode] = useState('')
  const [couponPreview, setCouponPreview] = useState(null) // { coupon_id, name, discount_amount } | null
  const [couponError, setCouponError] = useState('')
  const [couponLoading, setCouponLoading] = useState(false)

  // ── 組合商品（套裝價）──
  // 這裡算的只是「給消費者看的畫面」。真正生效的是 place_order 裡的重新驗證：
  // 套裝價一律取 DB 的 bundle_price、完整性一律比對 DB 的 bundle_items，
  // 前端 localStorage 怎麼改都不影響最後付多少（見 20250071 migration）。
  const [bundles, setBundles] = useState([])
  const bundleIds = bundleIdsInCart(cart)
  const bundleKey = bundleIds.join(',')
  useEffect(() => {
    if (bundleIds.length === 0) { setBundles([]); return }
    let alive = true
    fetchBundlesByIds(bundleIds).then(rows => { if (alive) setBundles(rows) }).catch(() => {})
    return () => { alive = false }
  }, [bundleKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const { subtotal, bundleDiscount } = computeCartTotals(cart, bundles)
  const hasBundlePrice = bundleDiscount > 0

  // 套裝價視為最終價，不與優惠券併用（ADR-0004）。已套用的券在套裝成立時自動移除。
  useEffect(() => {
    if (hasBundlePrice && couponPreview) {
      setCouponPreview(null)
      setCouponError(lang === 'zh'
        ? '套裝價不能與優惠券併用，已移除優惠碼'
        : 'Bundle price cannot be combined with coupons — the code has been removed')
    }
  }, [hasBundlePrice]) // eslint-disable-line react-hooks/exhaustive-deps

  const FREE_SHIPPING_THRESHOLD = store?.settings?.free_shipping_threshold ?? 3800
  const SHIPPING_FEE = store?.settings?.shipping_fee ?? 60
  const shippingFee = subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE
  const discountAmount = hasBundlePrice ? 0 : (couponPreview?.discount_amount || 0)
  const total = subtotal - bundleDiscount - discountAmount + shippingFee
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  // ── 綠界付款方式：依店家設定決定可選項 ──
  // 沒設綠界金鑰的店家（ecpayReady=false）完全不出現信用卡／貨到付款選項。
  //
  // 金流與物流是分開申請的：只設了金流、還沒設物流的店家（logisticsReady=false）
  // 不能出現「貨到付款」（COD 需要物流建單），也不能走電子地圖選店（見下面的
  // cvsPickupAvailable）——但信用卡本身不依賴物流，仍然開放，取貨改回手填店名/店號。
  //
  // 匯款一律提供，不看 settings.remit_account。這是接綠界之前唯一的付款方式，
  // 而且三家店的 remit_account 從來沒人設定過（都是 null）——拿它當開關會直接
  // 把匯款關掉，等於拔掉店家原本唯一的收款管道。remit_account 只決定「訂單頁與
  // 確認信要不要顯示匯款帳號」，不決定這個選項存不存在。
  // 兩個條件都要成立：金鑰設好了（ecpay_set），而且店家在後台按下開關對外開放
  // （ecpay_enabled）。分開的理由是設好金鑰不等於想立刻開賣——店家會先把物流單
  // 流程走過一遍確認沒問題才對消費者開。
  const ecpayReady = !!store?.settings?.ecpay_set && !!store?.settings?.ecpay_enabled
  const logisticsReady = ecpayReady && !!store?.settings?.ecpay_logistics_set
  const codMax = Number(store?.settings?.ecpay_cod_max) || 20000
  // 每個選項都帶一句說明：付款方式的差異在「什麼時候付、付給誰」，
  // 只給標籤的話消費者得自己猜，這是結帳頁棄單的常見原因。
  const payOptions = [
    ...(ecpayReady ? [{
      value: 'credit',
      zh: '信用卡線上付款', en: 'Credit card',
      descZh: '送出後前往綠界刷卡，付款完成訂單才成立',
      descEn: 'Pay by card via ECPay after submitting',
    }] : []),
    ...(logisticsReady ? [{
      value: 'cod',
      zh: '貨到付款', en: 'Cash on delivery',
      descZh: `到超商取貨時付現，金額上限 NT$${codMax.toLocaleString()}`,
      descEn: `Pay cash at pickup, up to NT$${codMax.toLocaleString()}`,
    }] : []),
    {
      value: 'remittance',
      zh: '銀行匯款', en: 'Bank transfer',
      descZh: '下單後匯款，並回報帳號末五碼',
      descEn: 'Transfer after ordering, then report the last 5 digits',
    },
  ]

  // 電子地圖選店只有在物流就緒、且目前選的付款方式是 credit／cod 時才可用。
  // 物流沒就緒時即使選了信用卡，也視同沒有電子地圖，取貨走下面的手填 fallback。
  const cvsPickupAvailable = logisticsReady && (form.payment_method === 'credit' || form.payment_method === 'cod')

  // store 設定載入後才知道有哪些付款選項，套一次預設值。只在 store 這個
  // 參照第一次從 null 變成物件時跑一次，不會蓋掉使用者之後自己選的付款方式。
  //
  // 例外：從電子地圖選店回來時，草稿還原的付款方式優先，這裡不可覆寫（見 paymentRestoredRef）。
  // 但還原值若不在這家店的可選項內（例如店家中途關掉綠界），仍要修正成合法值，
  // 否則畫面上沒有任何選項被選中、送出後還會走到店家沒開的付款方式。
  useEffect(() => {
    if (!store) return
    setForm(f => {
      if (paymentRestoredRef.current && payOptions.some(o => o.value === f.payment_method)) return f
      return { ...f, payment_method: payOptions[0]?.value ?? 'remittance' }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store])

  // 換超商子類型時清掉已選門市 —— 不同通路的門市代碼不通用
  function setShippingSubtype(subtype) {
    setForm(f => ({ ...f, shipping_subtype: subtype, cvs_store_id: '', cvs_store_name: '', cvs_address: '' }))
  }

  // 選門市：整頁導轉到綠界電子地圖前，先把表單存進 sessionStorage（回來才能還原）
  function goPickStore() {
    if (!store?.id) return
    saveCheckoutDraft(window.sessionStorage, form)
    const isMobile = /Mobi|Android/i.test(navigator.userAgent)
    window.location.href =
      `/api/ecpay/logistics/map?subtype=${form.shipping_subtype}&storeId=${store.id}&device=${isMobile ? 1 : 0}`
  }

  // ── 加購金額試算：與 DB 的 append_to_order 用同一組規則 ──
  // 合併後小計重新對免運門檻，所以「加購跨過門檻」會把原本收的運費退掉。
  const originalItems = Array.isArray(appendOrder?.items_json) ? appendOrder.items_json : []
  const originalSubtotal = originalItems
    .filter(i => (i.status ?? 'active') !== 'cancelled')
    .reduce((s, i) => s + Number(i.price || 0) * Number(i.qty || 0), 0)
  const mergedSubtotal = originalSubtotal + subtotal
  const appendShippingFee = mergedSubtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE
  const appendNewTotal = mergedSubtotal - Number(appendOrder?.discount_amount || 0) + appendShippingFee
  const appendPaid = Number(appendOrder?.paid_amount || 0)
  const appendBalanceDue = appendNewTotal - appendPaid
  const prevShippingFee = Number(appendOrder?.shipping_fee || 0)

  async function submitAppend() {
    if (cart.length === 0) return
    setSubmitting(true)

    const { data, error } = await supabase.rpc('append_to_order', {
      p_token: appendTo.token,
      p_items_json: cart,
    })

    if (error || !data?.ok) {
      alert(data?.error || error?.message || t('common.error'))
      setSubmitting(false)
      return
    }

    trackPixel('Purchase', {
      content_ids: cart.map(i => String(i.id)),
      num_items: cart.reduce((s, i) => s + i.qty, 0),
      value: Number(data.new_total) - Number(data.previous_total),
      currency: 'TWD',
    }, { eventID: `${appendTo.token}-append-${Date.now()}` })

    // 加購通知信（不阻斷流程，失敗靜默處理）
    fetch('/api/send-order-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: appendTo.token, lang, mode: 'append' }),
    }).catch(err => console.error('Email send failed:', err))

    clearCart()
    cancelAppend()
    router.push(`/order/${appendTo.token}`)
  }

  // 優惠碼預覽（read-only 查詢，不扣額度）
  async function applyCoupon() {
    const code = couponCode.trim().toUpperCase()
    if (!code) return
    if (hasBundlePrice) {
      setCouponError(lang === 'zh'
        ? '套裝價不能與優惠券併用。若想改用優惠碼，請回購物車把套裝拆開（各件以原價計算）。'
        : 'Bundle price cannot be combined with coupons. Break up the bundle in your cart to use a code.')
      return
    }
    setCouponLoading(true)
    setCouponError('')
    setCouponPreview(null)

    try {
      const storeId = await getStoreId()
      // 點查 RPC（coupons/coupon_codes 已不開放匿名直讀）
      const { data: result } = await supabase
        .rpc('lookup_coupon', { p_code: code, p_store_id: storeId })

      if (!result?.found) { setCouponError(lang === 'zh' ? '優惠碼不存在' : 'Invalid coupon code'); setCouponLoading(false); return }
      if (result.is_used) { setCouponError(lang === 'zh' ? '此優惠碼已被使用' : 'This coupon has been used'); setCouponLoading(false); return }

      const coupon = result.coupon
      const couponId = coupon.id
      const isUnique = result.is_unique

      // 基本驗證
      if (!coupon.is_active) { setCouponError(lang === 'zh' ? '此優惠活動已停用' : 'This promotion is inactive'); setCouponLoading(false); return }
      const now = new Date()
      if (now < new Date(coupon.starts_at)) { setCouponError(lang === 'zh' ? '此優惠尚未開始' : 'This promotion has not started'); setCouponLoading(false); return }
      if (coupon.expires_at && now > new Date(coupon.expires_at)) { setCouponError(lang === 'zh' ? '此優惠碼已過期' : 'This coupon has expired'); setCouponLoading(false); return }
      if (!isUnique && coupon.max_usage && coupon.usage_count >= coupon.max_usage) { setCouponError(lang === 'zh' ? '此優惠碼已達使用上限' : 'This coupon has reached its usage limit'); setCouponLoading(false); return }
      if (subtotal < Number(coupon.min_amount)) { setCouponError(lang === 'zh' ? `未達最低消費 NT$${Number(coupon.min_amount).toLocaleString()}` : `Minimum spend NT$${Number(coupon.min_amount).toLocaleString()} required`); setCouponLoading(false); return }
      // 會員等級資格（限定等級的券需登入會員）
      if (result.level_ok === false) {
        const restricted = (coupon.allowed_level_ids || []).length > 0
        setCouponError(lang === 'zh'
          ? (restricted ? '此優惠僅限特定會員等級使用，請先登入符合資格的會員帳號' : '您不符合此優惠的使用資格')
          : 'This coupon is limited to specific member levels. Please sign in with an eligible account')
        setCouponLoading(false); return
      }

      // 計算折扣
      let discount = 0
      if (coupon.discount_type === 'fixed') {
        discount = Math.min(Number(coupon.discount_value), subtotal)
      } else {
        discount = subtotal * (Number(coupon.discount_value) / 100)
        if (coupon.max_discount) discount = Math.min(discount, Number(coupon.max_discount))
        discount = Math.min(discount, subtotal)
      }
      discount = Math.round(discount)

      setCouponPreview({ coupon_id: couponId, name: coupon.name, discount_amount: discount, code })
    } catch {
      setCouponError(lang === 'zh' ? '驗證失敗，請稍後再試' : 'Validation failed, please try again')
    }
    setCouponLoading(false)
  }

  function removeCoupon() {
    setCouponPreview(null)
    setCouponCode('')
    setCouponError('')
  }

  function validate() {
    const e = {}
    if (!form.name.trim()) e.name = t('checkout.required')
    if (!form.phone.trim()) e.phone = t('checkout.required')
    if (!form.email.trim()) e.email = t('checkout.required')
    if (!form.line_id.trim()) e.line_id = t('checkout.required')

    // 走綠界電子地圖選店（cvsPickupAvailable，需物流就緒＋payment_method 為 credit／cod）：
    // 門市必填，手填店名/店號不必填。
    // 沒走電子地圖（remittance，或物流未就緒時的 credit）：維持現行手填店名/店號必填 ——
    // 這是沒設綠界物流金鑰的店家唯一的取貨路徑，不可拿掉
    if (!cvsPickupAvailable && !form.cvs_store_id) {
      if (!form.store_name.trim()) e.store_name = t('checkout.required')
      if (!form.store_number.trim()) e.store_number = t('checkout.required')
    }
    if (cvsPickupAvailable && !form.cvs_store_id) {
      e.cvs_store_id = lang === 'zh' ? '請選擇取貨門市' : 'Please choose a pickup store'
    }

    // 匯款後五碼只有匯款流程需要
    if (form.payment_method === 'remittance') {
      if (!form.remittance_last5.trim() || !/^\d{5}$/.test(form.remittance_last5.trim())) {
        e.remittance_last5 = lang === 'zh' ? '請輸入 5 位數字' : 'Please enter exactly 5 digits'
      }
    }

    if (form.payment_method === 'cod' && total > codMax) {
      e.payment_method = lang === 'zh'
        ? `貨到付款金額上限 NT$${codMax.toLocaleString()}，請改用其他付款方式`
        : `Cash on delivery is limited to NT$${codMax.toLocaleString()}. Please choose another payment method.`
    }

    setErrors(e)
    return Object.keys(e).length === 0
  }

  // 庫存不夠時給的兩個出路。key 一律用 cartLineKey —— 購物車的 removeItem／updateQty
  // 認的就是這個鍵，用別的格式會刪不到（同商品不同組合是兩列）。
  function dropShortItems() {
    stockIssues.forEach(s => removeItem(s.key))
    setStockIssues([])
  }
  function clampShortItems() {
    // 剩 0 的直接移除，其餘改成剩餘數量
    stockIssues.forEach(s => (s.left > 0 ? updateQty(s.key, s.left) : removeItem(s.key)))
    setStockIssues([])
  }

  async function submit() {
    if (!validate() || cart.length === 0) return
    setStockIssues([])
    setPlaceError('')
    setSubmitting(true)

    const storeId = await getStoreId()

    // Validate that all cart items are still available (not expired/sold out)
    const productIds = [...new Set(cart.map(i => i.id))]
    const { data: spCheck } = await supabase
      .from('storefront_products')
      .select('product_id, collection_end, sold_out, published')
      .eq('store_id', storeId)
      .in('product_id', productIds)

    const unavailable = (spCheck || []).filter(sp =>
      sp.sold_out || !sp.published || (sp.collection_end && new Date(sp.collection_end) < new Date())
    )
    if (unavailable.length > 0) {
      const unavailableIds = new Set(unavailable.map(u => u.product_id))
      const names = cart.filter(i => unavailableIds.has(i.id)).map(i => i.name)
      alert((lang === 'zh'
        ? `以下商品已無法購買，請返回購物車移除：\n${names.join('、')}`
        : `The following items are no longer available. Please remove them from your cart:\n${names.join(', ')}`
      ))
      setSubmitting(false)
      return
    }

    // 購物車可能放了很久。送出前再確認一次，不要在 place_order 丟例外之後才用 alert 打回票。
    // 查不到就放行 —— 交給 place_order 的 FOR UPDATE 檢查擋，那才是最後防線。
    const stockIds = [...new Set(cart.map(i => Number(i.id)).filter(Boolean))]
    let shortages = []
    if (stockIds.length) {
      try {
        const res = await fetch('/api/stock', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productIds: stockIds }),
        })
        if (res.ok) {
          const now = await res.json()
          const leftOf = i => (i.variantId ? now.variants?.[i.variantId] : now.products?.[i.id])
          shortages = cart
            // 預購／收單品項不看庫存，與 place_order 第 78-80 行的規則一致
            .filter(i => !i.isCollection)
            .filter(i => { const left = leftOf(i); return left != null && left < i.qty })
            .map(i => ({
              key: cartLineKey(i),
              name: i.name,
              variantLabel: i.variantLabel,
              want: i.qty,
              left: leftOf(i) ?? 0,
            }))
        }
      } catch {
        // 查不到就放行，交給 place_order 擋
      }
    }
    if (shortages.length) { setStockIssues(shortages); setSubmitting(false); return }

    const itemsStr = cart.map(i =>
      `${i.name}${i.variantLabel ? ' ' + i.variantLabel : ''} × ${i.qty}${i.customNote ? ' [' + i.customNote + ']' : ''}`
    ).join(', ')

    // 原子操作：檢查庫存 + 驗證優惠券 → 扣庫存 + 建立訂單 + 記錄優惠券（單一 transaction）
    const orderTotal = subtotal + shippingFee  // 未折扣金額，RPC 內部會扣除折扣

    // 走綠界電子地圖選店：p_store_name／p_store_number／p_address 沿用既有欄位改帶門市資訊
    // （後台與通知信不必改）；沒走綠界（手填 fallback）則維持原本的手填值。
    const usingCvsMap = !!form.cvs_store_id
    const orderStoreName = usingCvsMap ? form.cvs_store_name : form.store_name.trim()
    const orderStoreNumber = usingCvsMap ? form.cvs_store_id : form.store_number.trim()
    const orderAddress = usingCvsMap
      ? (form.cvs_address || `${form.cvs_store_name} (${form.cvs_store_id})`)
      : `${form.store_name} (${form.store_number})`

    const { data: placeResult, error: placeErr } = await supabase.rpc('place_order', {
      p_store_id: storeId,
      p_customer_name: form.name,
      p_email: form.email,
      p_phone: form.phone,
      p_address: orderAddress,
      p_store_name: orderStoreName,
      p_store_number: orderStoreNumber,
      p_line_id: form.line_id || null,
      p_remittance_last5: form.remittance_last5.trim(),
      p_note: form.note,
      p_items: itemsStr,
      p_items_json: cart,
      p_total_amount: orderTotal,
      p_shipping_fee: shippingFee,
      // coupon (nullable)。套裝價成立時一律不帶券 —— DB 端也會擋，這裡先避免白跑一趟。
      p_coupon_code: hasBundlePrice ? null : (couponPreview?.code || null),
      p_subtotal: !hasBundlePrice && couponPreview ? subtotal : null,
      p_consumer_email: form.email,
      p_payment_method: form.payment_method,
      p_shipping_subtype: form.cvs_store_id ? form.shipping_subtype : null,
      p_cvs_store_id: form.cvs_store_id || null,
      p_cvs_store_name: form.cvs_store_name || null,
      p_cvs_address: form.cvs_address || null,
    })

    if (placeErr || !placeResult?.ok) {
      // 檢查與下單之間又被買走仍有可能。那時的訊息與上面的庫存攔截顯示在同一塊，不用 alert。
      setPlaceError(placeResult?.error || placeErr?.message || t('common.error'))
      setSubmitting(false)
      return
    }

    const orderToken = placeResult.public_token  // 不可猜連結：完成頁以此查詢，取代可枚舉的流水號

    // Meta Pixel：購買完成事件。eventID 帶訂單 token，之後接 Conversions API 可據此去重
    trackPixel('Purchase', {
      content_ids: cart.map(i => String(i.id)),
      num_items: cart.reduce((s, i) => s + i.qty, 0),
      value: total,
      currency: 'TWD',
    }, { eventID: orderToken })

    // 寄訂單確認信（不阻斷成功流程，失敗靜默處理）。
    // 只送不可猜的 token，收件人與內容由 server 依 token 從 DB 重建（見 send-order-email）。
    fetch('/api/send-order-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: orderToken, lang }),
    }).catch(err => console.error('Email send failed:', err))

    // 認領：下單時身分揭曉，把這個瀏覽器先前以訪客身分留下的客服對話歸到本人名下。
    // 動態載入，避免把聊天相關程式碼拉進結帳頁的 bundle；失敗不影響下單。
    if (user) {
      import('../../lib/chat')
        .then(async ({ getVisitorToken, claimConversations }) => {
          const visitorToken = getVisitorToken()
          const { data: { session } } = await supabase.auth.getSession()
          if (visitorToken && session?.access_token) {
            await claimConversations({ storeId, visitorToken, accessToken: session.access_token })
          }
        })
        .catch(err => console.error('claim conversations failed:', err))
    }

    clearCart()
    if (form.payment_method === 'credit') {
      // 信用卡：導去綠界付款頁。路徑是 DB 的數字 id，但一定要帶 ?t=<public_token>
      // 當持有證明——付款路由是用 token 查訂單的，沒有 token 一律拒絕（防止用可枚舉
      // 的流水號換到不可猜的 token）。
      window.location.href = `/api/ecpay/credit/${placeResult.order_id}?t=${orderToken}`
    } else {
      router.push(`/order/${orderToken}`)
    }
  }

  // 導向必須等 localStorage 讀入後才判斷，否則重新整理結帳頁會因為
  // cart 還是初始空陣列而被踢回購物車；導向本身也要在 render 之外做。
  if (!hydrated) return null
  if (cart.length === 0 && !submitting) return null

  // ── 加購模式：不重填收件資料，只確認金額差額 ──
  if (isAppend) {
    const zh = lang === 'zh'
    const row = (label, value, style = {}) => (
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginBottom: 8, ...style }}>
        <span>{label}</span><span>{value}</span>
      </div>
    )

    return (
      <div style={{ padding: '40px 0', maxWidth: 560, margin: '0 auto' }}>
        <h1 className="form-title">
          {zh ? `加購到訂單 #${appendTo.orderNo}` : `Add to order #${appendTo.orderNo}`}
        </h1>

        {!appendOrder ? (
          <div style={{ color: 'var(--text-3)', padding: '30px 0' }}>{zh ? '載入中…' : 'Loading…'}</div>
        ) : !appendOrder.can_append ? (
          <div className="order-summary-card">
            <div style={{ fontSize: 14, lineHeight: 1.8 }}>
              {zh
                ? '這筆訂單已經無法加購了 —— 可能是加購時間已截止，或老闆已經開始採購。'
                : 'This order can no longer be modified — the window has closed or purchasing has started.'}
            </div>
            <button className="btn-primary" style={{ marginTop: 16 }}
              onClick={() => { cancelAppend(); router.push('/cart') }}>
              {zh ? '改為建立新訂單' : 'Create a new order instead'}
            </button>
          </div>
        ) : (
          <>
            <div className="order-summary-card">
              <div className="order-summary-title">{zh ? '加購商品' : 'Items to add'}</div>
              {cart.map(item => (
                <div className="order-summary-item" key={`${item.id}-${item.variantLabel || ''}`}>
                  <div className="order-summary-item-name">
                    {item.name}
                    {item.variantLabel && (
                      <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{item.variantLabel}</div>
                    )}
                    <div style={{ fontSize: 12, color: 'var(--text-3)' }}>× {item.qty}</div>
                  </div>
                  <div className="order-summary-item-price">NT${(item.price * item.qty).toLocaleString()}</div>
                </div>
              ))}
              {/* 加購走 append_to_order，不經過套裝價的驗證 —— 先講清楚，別讓她以為有折 */}
              {bundleDiscount > 0 && (
                <div style={{ marginTop: 10, fontSize: 12, color: 'var(--amber)', lineHeight: 1.7 }}>
                  {zh
                    ? '加購到既有訂單時不套用套裝價，以上商品以各件原價計算。想用套裝價請取消加購，另外建立新訂單。'
                    : 'Bundle pricing does not apply when adding to an existing order — these items are charged at regular price.'}
                </div>
              )}
            </div>

            <div className="order-summary-card" style={{ marginTop: 16 }}>
              <div className="order-summary-title">{zh ? '金額變化' : 'Amount changes'}</div>
              {row(zh ? '原訂單金額' : 'Current order', `NT$${Number(appendOrder.total_amount || 0).toLocaleString()}`,
                { color: 'var(--text-2)' })}
              {row(zh ? '加購商品' : 'Items added', `+NT$${subtotal.toLocaleString()}`, { color: 'var(--text-2)' })}

              <hr className="order-summary-divider" />

              {prevShippingFee !== appendShippingFee ? (
                row(
                  zh ? '運費' : 'Shipping',
                  <span>
                    <span style={{ textDecoration: 'line-through', color: 'var(--text-3)' }}>NT${prevShippingFee}</span>
                    {' → '}
                    <span style={{ color: '#1a7a3c', fontWeight: 600 }}>
                      {appendShippingFee === 0 ? (zh ? '免運' : 'Free') : `NT$${appendShippingFee}`}
                    </span>
                  </span>,
                  { color: 'var(--text-2)' },
                )
              ) : (
                row(zh ? '運費' : 'Shipping',
                  appendShippingFee === 0 ? (zh ? '免運費' : 'Free') : `NT$${appendShippingFee}`,
                  { color: 'var(--text-2)' })
              )}

              {Number(appendOrder.discount_amount) > 0 && row(
                zh ? '優惠券折抵' : 'Coupon',
                `-NT$${Number(appendOrder.discount_amount).toLocaleString()}`,
                { color: '#1a7a3c' },
              )}

              <div className="order-summary-total">
                <span>{zh ? '加購後應付' : 'New total'}</span>
                <span>NT${appendNewTotal.toLocaleString()}</span>
              </div>

              {appendPaid > 0 && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '0.5px solid var(--border)' }}>
                  {row(zh ? '已收' : 'Already paid', `NT$${appendPaid.toLocaleString()}`, { color: 'var(--text-2)' })}
                  {row(
                    appendBalanceDue >= 0 ? (zh ? '需補匯' : 'Balance due') : (zh ? '待退款' : 'Refund due'),
                    `NT$${Math.abs(appendBalanceDue).toLocaleString()}`,
                    { fontWeight: 700, fontSize: 16, marginBottom: 0 },
                  )}
                </div>
              )}

              {prevShippingFee > 0 && appendShippingFee === 0 && (
                <div style={{ marginTop: 10, fontSize: 12, color: '#1a7a3c', lineHeight: 1.6 }}>
                  {zh
                    ? `加購後已達免運門檻，原本的 NT$${prevShippingFee} 運費已為你退掉。`
                    : `You've reached free shipping — the NT$${prevShippingFee} shipping fee has been removed.`}
                </div>
              )}

              <div style={{ marginTop: 14, fontSize: 12, color: 'var(--text-3)', lineHeight: 1.7 }}>
                {zh
                  ? '收件資訊與付款方式沿用原訂單，不需要重新填寫。加購商品會與原訂單一起出貨。'
                  : 'Shipping details carry over from the original order. Added items ship together.'}
              </div>
            </div>

            <button className="btn-primary" onClick={submitAppend} disabled={submitting} style={{ marginTop: 16 }}>
              {submitting ? t('checkout.submitting') : (zh ? '確認加購' : 'Confirm')}
            </button>
            <button
              onClick={() => { cancelAppend(); router.push('/cart') }}
              style={{
                width: '100%', marginTop: 10, padding: '12px 0', background: 'none',
                border: 'none', color: 'var(--text-3)', fontSize: 13, cursor: 'pointer',
              }}>
              {zh ? '取消加購，改為建立新訂單' : 'Cancel and create a new order'}
            </button>
          </>
        )}
      </div>
    )
  }

  return (
    <div style={{ padding: '40px 0' }}>
      <div className="checkout-wrap">
        {/* Form */}
        <div>
          <h1 className="form-title">{t('checkout.title')}</h1>

          {[
            { key: 'name', label: t('checkout.name'), type: 'text', required: true },
            { key: 'phone', label: t('checkout.phone'), type: 'tel', required: true },
            { key: 'email', label: t('checkout.email'), type: 'email', required: true },
            { key: 'line_id', label: t('checkout.line_id'), type: 'text', required: true, placeholder: t('checkout.line_id_placeholder') },
            // 匯款後五碼只有匯款流程需要，信用卡／貨到付款不顯示這欄
            ...(form.payment_method === 'remittance'
              ? [{ key: 'remittance_last5', label: t('checkout.remittance_last5'), type: 'text', required: true, placeholder: t('checkout.remittance_last5_placeholder'), maxLength: 5, inputMode: 'numeric' }]
              : []),
          ].map(({ key, label, type, required, placeholder, maxLength, inputMode }) => (
            <div className="form-group" key={key}>
              <label className="form-label">{label}{required ? ' *' : ''}</label>
              <input
                className="form-input"
                type={type}
                value={form[key]}
                onChange={e => set(key, e.target.value)}
                placeholder={placeholder || ''}
                maxLength={maxLength}
                inputMode={inputMode}
                style={errors[key] ? { borderColor: 'var(--red)' } : {}}
              />
              {errors[key] && <div className="form-error">{errors[key]}</div>}
            </div>
          ))}

          {/* 付款方式：沒接綠界的店家只有匯款一種，不顯示只能單選的選擇區，
              維持接綠界之前的樣子 */}
          {payOptions.length > 1 && (
            <div className="form-group">
              <label className="form-label">{lang === 'zh' ? '付款方式' : 'Payment method'} *</label>
              <div className="opt-list" role="radiogroup"
                   aria-label={lang === 'zh' ? '付款方式' : 'Payment method'}>
                {payOptions.map(opt => {
                  const on = form.payment_method === opt.value
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      className="opt-row"
                      onClick={() => set('payment_method', opt.value)}
                    >
                      <span className="opt-mark" aria-hidden="true" />
                      <span className="opt-body">
                        <span className="opt-title">{lang === 'zh' ? opt.zh : opt.en}</span>
                        <span className="opt-desc">{lang === 'zh' ? opt.descZh : opt.descEn}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
              {errors.payment_method && <div className="form-error">{errors.payment_method}</div>}
            </div>
          )}

          {/* 取貨門市：物流就緒時，credit／cod 走綠界電子地圖選店（自動建立物流單需要綠界
              認得的門市代碼）；物流未就緒（只設了金流）或走匯款，則維持現行手填店名/店號 ——
              這是沒設綠界物流金鑰的店家唯一的取貨路徑，不可拿掉 */}
          {cvsPickupAvailable ? (
            <div style={{ marginBottom: 16 }}>
              <label className="form-label">{lang === 'zh' ? '取貨門市' : 'Pickup store'} *</label>
              <div className="cvs-grid" role="radiogroup" style={{ marginBottom: 8 }}
                   aria-label={lang === 'zh' ? '超商通路' : 'Convenience store chain'}>
                {CVS_SUBTYPES.map(sub => (
                  <button
                    key={sub}
                    type="button"
                    role="radio"
                    aria-checked={form.shipping_subtype === sub}
                    className="cvs-chip"
                    onClick={() => setShippingSubtype(sub)}
                  >
                    {CVS_SUBTYPE_LABELS[sub]?.[lang] || sub}
                  </button>
                ))}
              </div>
              {form.cvs_store_id ? (
                <div className="store-picked">
                  <span className="opt-body" style={{ flex: 1 }}>
                    <span className="sp-name">{form.cvs_store_name}</span>
                    {form.cvs_address && <span className="sp-addr">{form.cvs_address}</span>}
                  </span>
                  <button type="button" className="store-change" onClick={goPickStore}>
                    {lang === 'zh' ? '更換' : 'Change'}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="btn-outline"
                  onClick={goPickStore}
                  style={{ width: '100%', ...(errors.cvs_store_id ? { borderColor: 'var(--red)' } : {}) }}>
                  {lang === 'zh' ? '選擇取貨門市' : 'Choose a pickup store'}
                </button>
              )}
              {errors.cvs_store_id && <div className="form-error">{errors.cvs_store_id}</div>}
            </div>
          ) : (
            <div style={{ marginBottom: 16 }}>
              <label className="form-label">{t('checkout.store_section')} *</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <input
                    className="form-input"
                    type="text"
                    value={form.store_name}
                    onChange={e => set('store_name', e.target.value)}
                    placeholder={t('checkout.store_name_placeholder')}
                    style={errors.store_name ? { borderColor: 'var(--red)' } : {}}
                  />
                  {errors.store_name && <div className="form-error">{errors.store_name}</div>}
                </div>
                <div>
                  <input
                    className="form-input"
                    type="text"
                    value={form.store_number}
                    onChange={e => set('store_number', e.target.value)}
                    placeholder={t('checkout.store_number_placeholder')}
                    style={errors.store_number ? { borderColor: 'var(--red)' } : {}}
                  />
                  {errors.store_number && <div className="form-error">{errors.store_number}</div>}
                </div>
              </div>
            </div>
          )}

          <div className="form-group">
            <label className="form-label">{t('checkout.note')}</label>
            <textarea
              className="form-input"
              style={{ minHeight: 80, resize: 'vertical' }}
              placeholder={t('checkout.note_placeholder')}
              value={form.note}
              onChange={e => set('note', e.target.value)}
            />
          </div>

          <button className="btn-primary" onClick={submit} disabled={submitting} style={{ marginTop: 8 }}>
            {submitting ? t('checkout.submitting') : t('checkout.submit')}
          </button>
        </div>

        {/* Order Summary */}
        <div>
          {/* 庫存不夠或 place_order 打回票時，把話講在購物車摘要上方 ——
              客人要處理的東西就在下面那張清單裡。 */}
          {(stockIssues.length > 0 || placeError) && (
            <div className="checkout-stock-issue" ref={issueRef}>
              <div className="checkout-stock-title">
                {stockIssues.length > 0
                  ? (lang === 'zh' ? '有商品的庫存不夠了' : 'Some items are no longer available')
                  : (lang === 'zh' ? '這筆訂單沒有送出' : 'Your order was not placed')}
              </div>
              {stockIssues.length > 0 ? (
                <>
                  <ul className="checkout-stock-list">
                    {stockIssues.map(s => (
                      <li key={s.key}>
                        {s.name}{s.variantLabel ? `（${s.variantLabel}）` : ''}{'　'}
                        {lang === 'zh'
                          ? `你要 ${s.want} 件，只剩 ${s.left} 件`
                          : `you want ${s.want}, only ${s.left} left`}
                      </li>
                    ))}
                  </ul>
                  <div className="checkout-stock-actions">
                    <button type="button" className="btn-outline" onClick={dropShortItems}>
                      {lang === 'zh' ? '移除這幾件' : 'Remove them'}
                    </button>
                    <button type="button" className="btn-primary" onClick={clampShortItems}>
                      {lang === 'zh' ? '改成剩餘數量' : 'Use remaining quantity'}
                    </button>
                  </div>
                </>
              ) : (
                <div className="checkout-stock-list" style={{ paddingLeft: 0, marginBottom: 0 }}>{placeError}</div>
              )}
            </div>
          )}

          <div className="order-summary-card">
            <div className="order-summary-title">{t('checkout.order_summary')}</div>
            {cart.map(item => (
              <div className="order-summary-item" key={cartLineKey(item)}>
                <div className="order-summary-item-name">
                  {item.name}
                  {item.bundleName && (
                    <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                      {lang === 'zh' ? '組合：' : 'Bundle: '}{item.bundleName}
                    </div>
                  )}
                  {item.variantLabel && (
                    <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{item.variantLabel}</div>
                  )}
                  <div style={{ fontSize: 12, color: 'var(--text-3)' }}>× {item.qty}</div>
                </div>
                <div className="order-summary-item-price">NT${(item.price * item.qty).toLocaleString()}</div>
              </div>
            ))}
            <hr className="order-summary-divider" />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, color: 'var(--text-2)', marginBottom: 8 }}>
              <span>{lang === 'zh' ? '小計' : 'Subtotal'}</span>
              <span>NT${subtotal.toLocaleString()}</span>
            </div>

            {/* 套裝價折抵：組合齊全時成立，寫進訂單的 discount_amount */}
            {bundleDiscount > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, color: '#1a7a3c', marginBottom: 8 }}>
                <span>{lang === 'zh' ? '套裝價折抵' : 'Bundle discount'}</span>
                <span>-NT${bundleDiscount.toLocaleString()}</span>
              </div>
            )}

            {/* 優惠碼輸入。套裝價視為最終價，不與優惠券併用（ADR-0004）。 */}
            {hasBundlePrice ? (
              <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.7, marginBottom: 10, background: 'var(--border-light)', padding: '8px 12px', borderRadius: 8 }}>
                {lang === 'zh'
                  ? '套裝價已是優惠價，不能再疊加優惠券或會員等級折扣。想改用優惠碼的話，回購物車把套裝拆開即可，各件會以原價計算。'
                  : 'The bundle price is already discounted and cannot be combined with coupons or member-level discounts. Break up the bundle in your cart to use a code instead.'}
              </div>
            ) : !couponPreview ? (
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    className="form-input"
                    style={{ flex: 1, fontSize: 14, textTransform: 'uppercase', fontFamily: 'monospace' }}
                    placeholder={lang === 'zh' ? '輸入優惠碼' : 'Coupon code'}
                    value={couponCode}
                    onChange={e => { setCouponCode(e.target.value); setCouponError('') }}
                    onKeyDown={e => !isComposing(e) && e.key === 'Enter' && applyCoupon()}
                  />
                  <button
                    onClick={applyCoupon}
                    disabled={couponLoading || !couponCode.trim()}
                    style={{
                      padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border)',
                      background: 'var(--surface)', fontSize: 14, cursor: 'pointer',
                      opacity: couponLoading || !couponCode.trim() ? 0.5 : 1,
                    }}
                  >{couponLoading ? '...' : (lang === 'zh' ? '套用' : 'Apply')}</button>
                </div>
                {couponError && (
                  <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 4 }}>{couponError}</div>
                )}
              </div>
            ) : (
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                fontSize: 14, color: '#1a7a3c', marginBottom: 8,
                background: '#e8f7ee', padding: '8px 12px', borderRadius: 8,
              }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{couponPreview.name}</div>
                  <div style={{ fontSize: 12 }}>-NT${couponPreview.discount_amount.toLocaleString()}</div>
                </div>
                <button
                  onClick={removeCoupon}
                  style={{ background: 'none', border: 'none', fontSize: 16, cursor: 'pointer', color: '#999' }}
                >×</button>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, color: 'var(--text-2)', marginBottom: 8 }}>
              <span>{lang === 'zh' ? '運費' : 'Shipping'}</span>
              <span>{shippingFee === 0
                ? (lang === 'zh' ? '免運費' : 'Free')
                : `NT$${shippingFee}`
              }</span>
            </div>
            {shippingFee > 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 8 }}>
                {lang === 'zh'
                  ? `滿 NT$${FREE_SHIPPING_THRESHOLD.toLocaleString()} 免運費，還差 NT$${(FREE_SHIPPING_THRESHOLD - subtotal).toLocaleString()}`
                  : `Free shipping over NT$${FREE_SHIPPING_THRESHOLD.toLocaleString()}, NT$${(FREE_SHIPPING_THRESHOLD - subtotal).toLocaleString()} away`
                }
              </div>
            )}
            <div className="order-summary-total">
              <span>{t('cart.total')}</span>
              <span>NT${total.toLocaleString()}</span>
            </div>
            <div style={{ marginTop: 16, fontSize: 12, color: 'var(--text-3)', lineHeight: 1.6 }}>
              {lang === 'zh'
                ? '下單後我們將聯繫您確認付款方式'
                : 'We will contact you after order to confirm payment'
              }
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
