// 消費者訂單的完整詳情與編輯：收付款、折讓、品項取消、運費與物流單號、狀態變更信。
//
// 訂單頁與客服收件匣共用。這支碰的是金流與寄信，改動前先想清楚兩邊都會受影響。
import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import CustomSelect from './CustomSelect'
import Sheet from './Sheet'

const notifyBtn = { padding: '8px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }

const PAYMENT_METHOD_LABEL = { credit: '信用卡', cod: '貨到付款', remittance: '銀行匯款' }
// 超商代碼 → 中文店名（cvs_store_id/cvs_store_name 是綠界超商取貨欄位，跟舊的 store_name/store_number 不同）
const CVS_TYPE_LABEL = { UNIMARTC2C: '7-11', FAMIC2C: '全家', HILIFEC2C: '萊爾富', OKMARTC2C: 'OK' }

export default function ConsumerOrderDetailSheet({ order: o, onClose, onSaved, canEdit }) {
  const { storeId, store } = useAuth()
  // 運費規則以店家設定為準，與 append_to_order（商城加購）用同一組數字，
  // 否則同一筆訂單在後台與商城會算出不同運費
  const FREE_SHIPPING_THRESHOLD = store?.settings?.free_shipping_threshold ?? 3800
  const DEFAULT_SHIPPING_FEE = store?.settings?.shipping_fee ?? 60

  const [status, setStatus] = useState(o.status || '待確認')
  const [saving, setSaving] = useState(false)

  // 收付款明細：payment_status 不再手動指定，由已收金額對應付金額推導
  const [payments, setPayments] = useState([])
  const [payInput, setPayInput] = useState('')
  const [payNote, setPayNote] = useState('')
  const [payBusy, setPayBusy] = useState(false)
  // 登記收款/退款：點開後帶入建議金額（有待補款/待退款時自動預填），可自行覆蓋
  const [payAction, setPayAction] = useState(null) // null | 'in' | 'out'

  // 折讓金額：total_amount 在資料庫裡存的是「小計+運費-折讓」後的淨額（見 place_order），
  // 有優惠券時折讓由優惠券機制管理（鎖住不可編輯，避免疊加）；沒有優惠券則開放手動輸入議價/服務補償折讓。
  // 失焦即時寫回 DB，確保之後點「已付款/部分付款」快捷鍵時，付款狀態 trigger 算的 total_amount 已經是最新值。
  const [discountAmount, setDiscountAmount] = useState(Number(o.discount_amount) || 0)
  const [discountBusy, setDiscountBusy] = useState(false)

  const loadPayments = useCallback(async () => {
    const { data } = await supabase
      .from('order_payments').select('*').eq('order_id', o.id).order('id')
    setPayments(data || [])
  }, [o.id])
  useEffect(() => { loadPayments() }, [loadPayments])

  const paidAmount = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0)

  // 從 items_json 初始化，已有 status: 'cancelled' 的保留取消狀態
  const [itemStatuses, setItemStatuses] = useState(
    (Array.isArray(o.items_json) ? o.items_json : []).map(item => ({
      ...item,
      _cancelled: item.status === 'cancelled',
      _originalQty: item.originalQty || item.qty,
    }))
  )
  const [shippingFee, setShippingFee] = useState(o.shipping_fee || DEFAULT_SHIPPING_FEE)
  const [trackingNumber, setTrackingNumber] = useState(o.tracking_number || '')

  // 綠界物流：ecpay_transactions 有 RLS 但沒開 policy，後台讀不到交易編號，
  // 這裡只用 consumer_orders 上讀得到的欄位。onSaved 只會刷新列表、不會換掉這個
  // sheet 拿到的 order prop，所以建單成功後要用本地 state 記住，按鈕才會馬上換成「列印」。
  const SHOP_URL = import.meta.env.VITE_SHOP_URL || 'http://localhost:3000'
  const [logiBusy, setLogiBusy] = useState(false)
  const [logiInfo, setLogiInfo] = useState({
    allpay_logistics_id: o.allpay_logistics_id || null,
    cvs_payment_no: o.cvs_payment_no || null,
    cvs_validation_no: o.cvs_validation_no || null,
    logistics_status: o.logistics_status || null,
    logistics_status_msg: o.logistics_status_msg || null,
  })

  // 物流兩支端點都需驗證後台身分＋店家角色，呼叫時要帶目前登入者的 Supabase JWT
  async function getAccessToken() {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token || null
  }

  async function handleCreateLogistics() {
    if (!o.cvs_store_id || logiInfo.allpay_logistics_id) return
    // 這一按會真的跟綠界要物流單，物流費從綠界帳戶餘額扣除，不可誤按
    if (!window.confirm('確定向綠界建立物流單？建立後物流費將從綠界帳戶餘額扣除。')) return
    setLogiBusy(true)
    try {
      const accessToken = await getAccessToken()
      if (!accessToken) { alert('登入狀態已失效，請重新登入後再試'); setLogiBusy(false); return }
      const res = await fetch(`${SHOP_URL}/api/ecpay/logistics/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ orderId: o.id }),
      })
      const data = await res.json()
      if (!data.ok) { alert('建立失敗：' + (data.error || '未知錯誤')); setLogiBusy(false); return }
      setLogiInfo({
        allpay_logistics_id: data.allPayLogisticsID || null,
        cvs_payment_no: data.cvsPaymentNo || null,
        cvs_validation_no: data.cvsValidationNo || null,
        logistics_status: data.rtnCode || null,
        logistics_status_msg: data.rtnMsg || null,
      })
      alert('物流單建立成功，綠界物流編號：' + data.allPayLogisticsID)
      onSaved()
    } catch (e) {
      alert('呼叫失敗：' + e.message)
    }
    setLogiBusy(false)
  }

  // 印託運單一定要開新分頁，用 iframe 會被綠界的導轉頁擋下。
  // 端點需驗證後台身分＋店家角色（回應的 hidden input 就是寄件編號與驗證碼），
  // GET 帶不了 Authorization，所以改成 fetch POST 拿 HTML，再寫進自己開的新分頁——
  // 那個分頁仍是頂層視窗（不是 iframe），綠界的導轉阻擋不會觸發。
  // 新分頁必須在點擊當下同步開啟，等 fetch 回來才 open 會被瀏覽器的彈窗阻擋擋掉。
  async function handlePrintLabel() {
    const win = window.open('', '_blank')
    if (!win) { alert('瀏覽器擋下了新分頁，請允許此網站開啟彈出視窗後再試'); return }
    try {
      const accessToken = await getAccessToken()
      if (!accessToken) { win.close(); alert('登入狀態已失效，請重新登入後再試'); return }
      const res = await fetch(`${SHOP_URL}/api/ecpay/logistics/print/${o.id}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        win.close()
        alert('無法列印：' + (data.error || `HTTP ${res.status}`))
        return
      }
      const html = await res.text()
      win.document.open()
      win.document.write(html) // 綠界的自動送出表單，寫進去就會自己 POST 出去
      win.document.close()
    } catch (e) {
      win.close()
      alert('呼叫失敗：' + e.message)
    }
  }

  // 優惠券退還
  const [refundingCoupon, setRefundingCoupon] = useState(false)
  const [couponMinAmount, setCouponMinAmount] = useState(0)

  useEffect(() => {
    if (o.coupon_id) {
      supabase.from('coupons').select('min_amount').eq('id', o.coupon_id).single()
        .then(({ data }) => { if (data) setCouponMinAmount(Number(data.min_amount) || 0) })
    }
  }, [o.coupon_id])

  async function handleRefundCoupon() {
    if (!window.confirm('確定退還此訂單的優惠券？折抵金額將加回訂單總額。')) return
    setRefundingCoupon(true)
    const { data, error } = await supabase.rpc('refund_coupon', { p_order_id: o.id })
    setRefundingCoupon(false)
    if (error || !data?.ok) {
      alert('退還失敗：' + (data?.error || error?.message))
      return
    }
    alert(`已退還優惠券，折抵金額 NT$${Number(data.refunded_amount).toLocaleString()} 已加回訂單`)
    onSaved()
    onClose()
  }

  // 加購商品：商品庫選擇器
  const [addProducts, setAddProducts] = useState([])
  const [addVariants, setAddVariants] = useState({})
  const [addSpMap, setAddSpMap] = useState({})
  const [addValueMap, setAddValueMap] = useState({}) // option_value_id → value string
  const [showAddPicker, setShowAddPicker] = useState(false)
  const [addSearch, setAddSearch] = useState('')
  const [addPickerStep, setAddPickerStep] = useState('product') // 'product' | 'variant'
  const [addSelectedProd, setAddSelectedProd] = useState(null)
  useEffect(() => {
    if (!storeId) return
    Promise.all([
      supabase.from('products').select('id, name, sku, quantity').eq('store_id', storeId),
      supabase.from('product_variants').select('*').eq('store_id', storeId),
      supabase.from('storefront_products').select('product_id, shop_price').eq('store_id', storeId),
      supabase.from('variant_option_values').select('id, value'),
    ]).then(([{ data: prods }, { data: vars }, { data: sp }, { data: vals }]) => {
      setAddProducts(prods || [])
      const vm = {}
      ;(vals || []).forEach(v => { vm[v.id] = v.value })
      setAddValueMap(vm)
      const vMap = {}
      ;(vars || []).forEach(v => { if (!vMap[v.product_id]) vMap[v.product_id] = []; vMap[v.product_id].push(v) })
      setAddVariants(vMap)
      const sm = {}
      ;(sp || []).forEach(s => { sm[s.product_id] = s })
      setAddSpMap(sm)
    })
  }, [storeId])

  function closePicker() {
    setShowAddPicker(false)
    setAddSearch('')
    setAddPickerStep('product')
    setAddSelectedProd(null)
  }

  function pickProduct(prod, variant) {
    const basePrice = addSpMap[prod.id] ? Number(addSpMap[prod.id].shop_price) : 0
    const price = variant?.variant_price != null
      ? Number(variant.variant_price)
      : basePrice + (variant ? Number(variant.price_adjustment) || 0 : 0)
    const vLabel = variant
      ? Object.values(variant.options || {}).map(valId => addValueMap[valId]).filter(Boolean).join(' / ')
      : ''
    // 庫存上限：規格用 variant.stock，無規格用 product.quantity（從 addProducts 找）
    const stockLimit = variant
      ? (variant.stock ?? 999)
      : (addProducts.find(p => p.id === prod.id)?.quantity ?? 999)

    setItemStatuses(prev => {
      // 同商品 + 同規格已存在 → 合併（數量 +1，不超過庫存）
      const existing = prev.findIndex(it =>
        it.id === prod.id &&
        (it.variantId ?? null) === (variant?.id ?? null) &&
        !it._cancelled
      )
      if (existing !== -1) {
        return prev.map((it, idx) => idx === existing
          ? { ...it, qty: Math.min(it.qty + 1, it._stock ?? stockLimit) }
          : it
        )
      }
      return [...prev, {
        id: prod.id,
        name: prod.name,
        sku: prod.sku,
        variantId: variant?.id || null,
        variantLabel: vLabel || null,
        price,
        qty: 1,
        _cancelled: false,
        _added: true,
        _originalQty: 1,
        _stock: stockLimit,   // 供 + 按鈕用
      }]
    })
    closePicker()
  }

  function selectProdForVariant(prod) {
    const pvs = addVariants[prod.id]
    if (!pvs || pvs.length === 0) {
      pickProduct(prod, null)
    } else {
      setAddSelectedProd(prod)
      setAddPickerStep('variant')
    }
  }

  // 加購商品：手動輸入（自訂品項用）
  const [addItemName, setAddItemName] = useState('')
  const [addItemPrice, setAddItemPrice] = useState('')
  const [addItemQty, setAddItemQty] = useState(1)
  const [showManualAdd, setShowManualAdd] = useState(false)

  // 計算邏輯
  const activeItems = itemStatuses.filter(i => !i._cancelled)
  const cancelledItems = itemStatuses.filter(i => i._cancelled)
  const activeSubtotal = activeItems.reduce((sum, i) => sum + (Number(i.price) || 0) * (Number(i.qty) || 0), 0)
  const hasAnyCancel = cancelledItems.length > 0
  const hasQtyChange = activeItems.some(i => i.qty < i._originalQty)
  const hasAddedItems = itemStatuses.some(i => i._added)
  const hasAnyChange = hasAnyCancel || hasQtyChange || hasAddedItems
  const meetsThreshold = activeSubtotal >= FREE_SHIPPING_THRESHOLD
  const effectiveShippingFee = !hasAnyChange ? shippingFee : (meetsThreshold ? 0 : shippingFee)
  // 折扣前金額（小計+運費，尚未扣折讓）
  const preDiscountTotal = activeSubtotal + effectiveShippingFee
  // 應付＝折扣前金額扣掉折讓，跟 place_order/append_to_order 存進 total_amount 的淨額算法一致
  const newTotal = Math.max(0, preDiscountTotal - discountAmount)
  // 正 = 消費者要補匯、負 = 要退款給消費者
  const balanceDue = newTotal - paidAmount
  // 即時推導付款狀態，邏輯對齊 sync_payment_status（DB trigger）：
  // 已付清的訂單如果只是退款（total 沒變），狀態鎖住不退回部分付款；
  // 加購讓 total 變大才會真的落到部分付款
  const wasFullyPaid = o.payment_status === '已付清'
  const totalUnchanged = newTotal === (Number(o.total_amount) || 0)
  const lockedAsPaid = wasFullyPaid && totalUnchanged && paidAmount < newTotal
  const derivedPaymentStatus = lockedAsPaid ? '已付清' :
    paidAmount <= 0 ? '未付' :
    paidAmount < newTotal ? '部分付款' :
    paidAmount === newTotal ? '已付清' : '待退款'

  // 收款卡片頂部狀態色塊的顏色與白話說明
  const heroInfo =
    lockedAsPaid ? {
      bg: 'var(--green-bg)', color: 'var(--green)', title: '已付清',
      sub: `已收 NT$${paidAmount.toLocaleString()}（已鎖定，退款不會退回部分付款）`,
    } :
    derivedPaymentStatus === '已付清' ? {
      bg: 'var(--green-bg)', color: 'var(--green)', title: '已付清', sub: '已收足額，無需再收款',
    } :
    derivedPaymentStatus === '部分付款' ? {
      bg: 'var(--amber-bg)', color: 'var(--amber)', title: '部分付款',
      sub: `還差 NT$${balanceDue.toLocaleString()}，記得跟消費者收款`,
    } :
    derivedPaymentStatus === '待退款' ? {
      bg: 'var(--red-bg)', color: 'var(--red)', title: '待退款',
      sub: `多收了 NT$${Math.abs(balanceDue).toLocaleString()}，記得退給消費者`,
    } :
    // 貨到付款未收款是正常狀態（取件時才代收），顯示「未付款」會誤導成訂單有問題
    o.payment_method === 'cod' ? {
      bg: 'var(--bg)', color: 'var(--text-2)', title: '貨到付款', sub: '取貨時由物流代收，尚未收款',
    } : {
      bg: 'var(--bg)', color: 'var(--text-2)', title: '未付款', sub: '尚未收到款項',
    }

  const hasItems = itemStatuses.length > 0

  // 折讓金額失焦即存：只更新 discount_amount / total_amount 這兩欄，
  // 不動品項與狀態，避免跟下面整批儲存的 save() 互相覆蓋、也讓快捷收款按鈕能立刻用到最新應付金額
  async function applyDiscount() {
    if (o.coupon_id) return // 有優惠券時折讓鎖住，由優惠券機制管理
    const amt = Math.max(0, Number(discountAmount) || 0)
    setDiscountBusy(true)
    const { error } = await supabase.from('consumer_orders')
      .update({ discount_amount: amt, total_amount: Math.max(0, preDiscountTotal - amt) })
      .eq('id', o.id)
    setDiscountBusy(false)
    if (error) { alert('更新折讓失敗：' + error.message); return }
    onSaved()
  }

  async function triggerStatusEmail({ activeItems, cancelledItems, shippingFee, newTotal, fulfillment_type, trackingNumber }) {
    try {
      const shopUrl = import.meta.env.VITE_SHOP_URL || 'http://localhost:3000'
      // 端點需驗證後台身分＋店家角色（P0-1）：帶上目前登入者的 Supabase JWT
      const { data: { session } } = await supabase.auth.getSession()
      const accessToken = session?.access_token
      if (!accessToken) { console.error('[triggerStatusEmail] 無登入 session，略過寄信'); return }
      console.log(`[triggerStatusEmail] type=${fulfillment_type} email=${o.email} url=${shopUrl}/api/send-status-email`)
      const res = await fetch(`${shopUrl}/api/send-status-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          order: {
            id: o.id,
            email: o.email,
            name: o.customer_name,
            phone: o.phone,
            address: o.address,
            note: o.note,
          },
          activeItems,
          cancelledItems,
          shippingFee,
          newTotal,
          fulfillment_type,
          trackingNumber,
          lang: 'zh',
          storeId,
        }),
      })
      console.log(`[triggerStatusEmail] response status=${res.status}`, await res.json().catch(() => ''))
    } catch (e) {
      console.error('[triggerStatusEmail] failed:', e)
    }
  }

  // Build email payload helper
  function buildEmailPayload(type) {
    const active = itemStatuses.filter(i => !i._cancelled)
    const cancelled = itemStatuses.filter(i => i._cancelled)
    const qtyReduced = active.some(i => i.qty < i._originalQty)

    let fulfillment_type = type
    if (type === 'shipped') {
      if (cancelled.length === 0 && !qtyReduced) fulfillment_type = 'full'
      else if (active.length > 0) fulfillment_type = 'partial'
      else fulfillment_type = 'cancelled'
    }

    const cleanItem = ({ _cancelled, _added, _originalQty, _stock, ...item }) => item
    // 全數取消時，所有品項（含未逐件標記的）都應出現在取消清單裡
    const cancelledForEmail = fulfillment_type === 'cancelled'
      ? itemStatuses.map(cleanItem)
      : cancelled.map(cleanItem)

    return {
      activeItems: fulfillment_type === 'cancelled'
        ? []
        : active.map(({ _cancelled, _added, _originalQty, _stock, ...item }) => ({
            ...item,
            ...(item.qty < _originalQty ? { note: `原訂 ${_originalQty}，到貨 ${item.qty}` } : {}),
          })),
      cancelledItems: cancelledForEmail,
      shippingFee: effectiveShippingFee,
      newTotal: activeItems.length > 0 && fulfillment_type !== 'cancelled' ? newTotal : 0,
      fulfillment_type,
      trackingNumber: trackingNumber || null,
    }
  }

  // Manual email triggers
  async function sendPaymentReceivedEmail() {
    if (!window.confirm('確定寄出「已收款」通知 Email 給消費者？')) return
    await triggerStatusEmail(buildEmailPayload('payment_received'))
    alert('已收款通知已寄出')
  }

  async function sendOrderModifiedEmail() {
    if (!window.confirm('確定寄出「訂單修改」通知 Email 給消費者？')) return
    await triggerStatusEmail(buildEmailPayload('order_modified'))
    alert('訂單修改通知已寄出')
  }

  // 登記一筆收款或退款。付款狀態不再手動選，由這些金額加總推導出來。
  async function addPayment(kind, amount = payInput, note = payNote) {
    const amt = Math.abs(Number(amount))
    if (!amt || Number.isNaN(amt)) { alert('請輸入金額'); return false }
    setPayBusy(true)
    const { error } = await supabase.from('order_payments').insert({
      store_id: o.store_id ?? storeId,
      order_id: o.id,
      amount: kind === 'refund' ? -amt : amt,
      method: 'remittance',
      note: note?.trim() || null,
    })
    setPayBusy(false)
    if (error) { alert('登記失敗：' + error.message); return false }
    setPayInput(''); setPayNote('')
    await loadPayments()
    onSaved()
    return true
  }

  function openPayAction(kind) {
    setPayAction(kind)
    setPayNote('')
    if (kind === 'in') setPayInput(balanceDue > 0 ? String(balanceDue) : '')
    else setPayInput(balanceDue < 0 ? String(Math.abs(balanceDue)) : '')
  }

  function cancelPayAction() {
    setPayAction(null)
    setPayInput('')
    setPayNote('')
  }

  async function confirmPayAction() {
    const ok = await addPayment(payAction === 'out' ? 'refund' : 'payment')
    if (ok) setPayAction(null)
  }

  async function removePayment(id) {
    if (!window.confirm('確定刪除這筆收付款紀錄？')) return
    setPayBusy(true)
    const { error } = await supabase.from('order_payments').delete().eq('id', id)
    setPayBusy(false)
    if (error) { alert('刪除失敗：' + error.message); return }
    await loadPayments()
    onSaved()
  }

  async function save() {
    // 取消已收款訂單前先提醒：系統不會自動退款，退款管道依付款方式不同。
    // 用 paid_amount（DB 實收金額，等同 payment_status !== '未付'）判斷，
    // 貨到付款訂單如果還沒代收（paid_amount = 0）就不用打擾店家。
    if (status === '已取消' && o.status !== '已取消' && Number(o.paid_amount || 0) > 0) {
      const amt = Number(o.paid_amount || 0).toLocaleString()
      const how = o.payment_method === 'credit'
        ? '信用卡刷卡，需至綠界後台辦理「退刷」'
        : o.payment_method === 'cod'
          ? '貨到付款已代收，需自行處理現金退還'
          : '銀行匯款，需手動匯款退還客人'
      if (!window.confirm(`此訂單已收款 NT$${amt}，取消後系統不會自動退款（${how}）。\n確定要取消這筆訂單嗎？`)) {
        return
      }
    }

    const active = itemStatuses.filter(i => !i._cancelled)
    const cancelled = itemStatuses.filter(i => i._cancelled)
    const qtyReduced = active.some(i => i.qty < i._originalQty)

    setSaving(true)

    // 加購品項的庫存不在這裡處理。consumer_orders 的 reconcile_stock trigger
    // 會在下面寫入 items_json 時算出差額並扣減，庫存不足就中止整筆儲存。
    //
    // 這裡原本先呼叫 deduct_items_stock 做一次前置檢查，現在移除：它的判準是
    // 購物車帶進來的 isCollection，trigger 的判準是 storefront_products 當下的
    // skip_stock_check / collection_end。兩者不同源，限時單商品庫存為 0 時
    // 前置檢查會誤擋，但 trigger 其實該放行為負。留著只會擋掉合法操作。

    // 判斷 fulfillment_type
    let fulfillment_type = o.fulfillment_type || null
    if (status === '已出貨') {
      if (cancelled.length === 0 && !qtyReduced) fulfillment_type = 'full'
      else if (active.length > 0) fulfillment_type = 'partial'
      else fulfillment_type = 'cancelled'
    } else if (status === '已取消') {
      fulfillment_type = 'cancelled'
    }

    const updatedTotal = active.length > 0 ? newTotal : 0

    const updatedItemsJson = itemStatuses.map(({ _cancelled, _added, _originalQty, _stock, ...item }) => ({
      ...item,
      originalQty: _originalQty,
      status: _cancelled ? 'cancelled' : 'active',
    }))

    // payment_status 不在此寫入：它由 paid_amount 對 total_amount 推導，
    // 這裡改了 total_amount，trigger 會自動把付款狀態調成待補款或待退款
    // total_amount 已經扣過 discount_amount（見 newTotal 算法），跟 place_order/append_to_order 的淨額慣例一致，
    // 避免品項/狀態編輯把折讓洗掉
    const { error: updErr } = await supabase.from('consumer_orders').update({
      status,
      items_json: updatedItemsJson,
      shipping_fee: effectiveShippingFee,
      total_amount: updatedTotal,
      discount_amount: discountAmount,
      fulfillment_type,
      tracking_number: trackingNumber || null,
    }).eq('id', o.id)

    // 庫存不足時 reconcile_stock trigger 會擋下這筆 update，訂單根本沒改到。
    // 一定要在寄信之前中止，否則客人會收到「訂單已更新」卻什麼都沒變。
    if (updErr) {
      setSaving(false)
      alert('儲存失敗：' + updErr.message)
      return
    }

    // 半自動出貨通知：已收款 + 狀態改為已出貨 → 詢問是否寄出貨通知
    if (status === '已出貨' && paidAmount >= updatedTotal && updatedTotal > 0) {
      if (window.confirm('訂單已標記為「已出貨」且「已收款」，是否寄出出貨通知 Email 給消費者？')) {
        await triggerStatusEmail(buildEmailPayload('shipped'))
      }
    }

    // 全數取消 → 自動退還優惠券 + 詢問寄信
    if (status === '已取消') {
      if (o.coupon_id) {
        await supabase.rpc('refund_coupon', { p_order_id: o.id })
      }
      if (window.confirm('訂單已標記為「已取消」，是否寄出取消通知 Email 給消費者？')) {
        await triggerStatusEmail(buildEmailPayload('cancelled'))
      }
    }

    setSaving(false)
    onSaved()
    onClose()
  }

  return (
    <Sheet title={`${o.customer_name} 的訂單`} onClose={onClose}>
      {/* payment_alert：已收款但庫存不足等需要人工處理的異常，這是唯一入口，不能藏在下面 */}
      {o.payment_alert && (
        <div style={{
          background: 'var(--red-bg)', borderRadius: 12, padding: '12px 16px', marginBottom: 12,
          fontSize: 13, color: 'var(--red)', lineHeight: 1.6, fontWeight: 600,
        }}>
          ⚠️ {o.payment_alert}
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-row row-sb">
          <span className="muted fs13">訂單編號</span>
          <span className="fw600 fs13">#{o.id?.toString().slice(-6)}</span>
        </div>
        <div className="card-row row-sb">
          <span className="muted fs13">下單時間</span>
          <span className="fs13">{new Date(o.created_at).toLocaleString('zh-TW')}</span>
        </div>
        {o.payment_method && (
          <div className="card-row row-sb">
            <span className="muted fs13">付款方式</span>
            <span className="fs13">{PAYMENT_METHOD_LABEL[o.payment_method] || o.payment_method}</span>
          </div>
        )}
        <div className="card-row row-sb">
          <span className="muted fs13">{discountAmount > 0 ? '折扣前金額' : '總金額'}</span>
          <span className="fw600">NT${Number(hasAnyChange ? preDiscountTotal : (Number(o.total_amount || 0) + Number(o.discount_amount || 0))).toLocaleString()}</span>
        </div>
        {discountAmount > 0 && (
          <>
            <div className="card-row row-sb">
              <span className="muted fs13">{o.coupon_id ? '優惠券折抵' : '折讓金額'}</span>
              <span className="fs13" style={{ color: 'var(--green)' }}>-NT${discountAmount.toLocaleString()}</span>
            </div>
            <div className="card-row row-sb" style={{ borderTop: '0.5px solid var(--border)', marginTop: 4, paddingTop: 8 }}>
              <span className="fw600 fs13">實付金額</span>
              <span className="fw600">NT${Number(hasAnyChange ? newTotal : (o.total_amount || 0)).toLocaleString()}</span>
            </div>
          </>
        )}
      </div>

      {/* 優惠券退還提示 */}
      {o.coupon_id && canEdit && hasAnyChange && activeSubtotal < (couponMinAmount || 0) && (
        <div style={{
          background: 'var(--amber-bg)', borderRadius: 12, padding: '12px 16px', marginBottom: 12,
          fontSize: 13, color: 'var(--amber)', lineHeight: 1.6,
        }}>
          ⚠️ 修改後小計 NT${activeSubtotal.toLocaleString()} 未達此優惠券門檻，建議退還優惠券
        </div>
      )}

      {o.coupon_id && canEdit && (
        <button
          onClick={handleRefundCoupon}
          disabled={refundingCoupon}
          style={{
            width: '100%', padding: 10, marginBottom: 12,
            background: 'none', border: '1px solid var(--amber)',
            borderRadius: 10, color: 'var(--amber)', fontSize: 13,
            fontWeight: 600, cursor: 'pointer',
          }}
        >{refundingCoupon ? '退還中…' : `退還優惠券（折抵 NT$${Number(o.discount_amount || 0).toLocaleString()}）`}</button>
      )}

      <div className="sec" style={{ marginTop: 0 }}>聯絡資訊</div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-row row-sb">
          <span className="muted fs13">姓名</span><span className="fs13">{o.customer_name}</span>
        </div>
        <div className="card-row row-sb">
          <span className="muted fs13">電話</span><span className="fs13">{o.phone}</span>
        </div>
        <div className="card-row row-sb">
          <span className="muted fs13">Email</span><span className="fs13">{o.email}</span>
        </div>
        {o.line_id && (
          <div className="card-row row-sb">
            <span className="muted fs13">LINE</span><span className="fs13">{o.line_id}</span>
          </div>
        )}
        {(o.store_name || o.store_number) ? (
          <div className="card-row row-sb">
            <span className="muted fs13">取貨門市</span>
            <span className="fs13">{o.store_name}{o.store_number ? ` (${o.store_number})` : ''}</span>
          </div>
        ) : o.address ? (
          <div className="card-row row-sb">
            <span className="muted fs13">地址</span><span className="fs13" style={{ textAlign: 'right', maxWidth: '65%' }}>{o.address}</span>
          </div>
        ) : null}
        {o.remittance_last5 && (
          <div className="card-row row-sb">
            <span className="muted fs13">匯款末五碼</span><span className="fw600 fs13">{o.remittance_last5}</span>
          </div>
        )}
        {o.note && (
          <div className="card-row"><span className="muted fs13">備註：{o.note}</span></div>
        )}
      </div>

      <div className="sec" style={{ marginTop: 0 }}>訂購商品</div>
      <div className="card" style={{ marginBottom: 16 }}>
        {hasItems ? itemStatuses.map((item, i) => (
          <div key={i} className="card-row" style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
            opacity: item._cancelled ? 0.4 : 1,
            background: item._cancelled ? '#fff5f5' : undefined,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="fs13 fw600" style={{
                textDecoration: item._cancelled ? 'line-through' : 'none',
              }}>
                {item.name}
                {item._added && <span style={{ fontSize: 10, color: 'var(--blue)', marginLeft: 4 }}>(加購)</span>}
              </div>
              {(item.variantLabel || item.color || item.size) && (
                <div className="muted fs12">{item.variantLabel || [item.color, item.size].filter(Boolean).join(' / ')}</div>
              )}
              {item.customNote && <div className="muted fs12">備註：{item.customNote}</div>}
              {item._cancelled && (
                <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 2 }}>✕ 缺貨取消</div>
              )}
            </div>
            <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0, marginLeft: 8 }}>
              {/* 數量：可編輯時顯示調整器，否則僅顯示 */}
              {canEdit && !item._cancelled ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <button style={{
                    width: 22, height: 22, borderRadius: 6, border: '1px solid var(--border)',
                    background: 'var(--bg)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0,
                  }} onClick={() => setItemStatuses(prev => prev.map((it, idx) =>
                    idx === i ? { ...it, qty: Math.max(1, it.qty - 1) } : it
                  ))}>-</button>
                  <span className="fs13 fw600" style={{ minWidth: 20, textAlign: 'center' }}>{item.qty}</span>
                  <button style={{
                    width: 22, height: 22, borderRadius: 6, border: '1px solid var(--border)',
                    background: 'var(--bg)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0,
                  }} onClick={() => setItemStatuses(prev => prev.map((it, idx) => {
                    if (idx !== i) return it
                    // 加購品項上限 = 庫存（_stock）；原始品項上限 = 原訂數量
                    const max = it._added ? (it._stock ?? 999) : it._originalQty
                    return { ...it, qty: Math.min(max, it.qty + 1) }
                  }))}>+</button>
                </div>
              ) : (
                <div className="fs13">× {item.qty}</div>
              )}
              <div className="muted fs12">NT${((Number(item.price) || 0) * (Number(item.qty) || 0)).toLocaleString()}</div>
              {/* 加購品項數量接近庫存時提示 */}
              {item._added && item._stock != null && item.qty >= item._stock && (
                <div style={{ fontSize: 10, color: 'var(--amber)' }}>已達庫存上限（{item._stock} 件）</div>
              )}
              {/* 原始品項數量被調低時提示 */}
              {!item._added && !item._cancelled && item.qty < item._originalQty && (
                <div style={{ fontSize: 10, color: 'var(--amber)' }}>原訂 {item._originalQty}，到貨 {item.qty}</div>
              )}
              {canEdit && (
                <button
                  style={{
                    fontSize: 11, padding: '2px 8px', borderRadius: 6, border: 'none', cursor: 'pointer',
                    background: item._cancelled ? 'var(--green)' : 'var(--red)',
                    color: '#fff',
                  }}
                  onClick={() => setItemStatuses(prev => prev.map((it, idx) =>
                    idx === i ? { ...it, _cancelled: !it._cancelled, qty: it._cancelled ? it._originalQty : it.qty } : it
                  ))}
                >
                  {item._cancelled ? '恢復' : '缺貨取消'}
                </button>
              )}
            </div>
          </div>
        )) : (
          <div className="card-row"><span className="fs13">{o.items}</span></div>
        )}
      </div>

      {/* 加購商品區塊 */}
      {canEdit && activeItems.length > 0 && (
        <>
          <div className="sec" style={{ marginTop: 0 }}>加購商品（選填）</div>

          {/* 商品庫選擇器：兩步驟 */}
          {!showAddPicker ? (
            <button style={{
              width: '100%', padding: '10px 0', borderRadius: 10,
              border: '1px dashed var(--border)', background: 'none', cursor: 'pointer',
              fontSize: 13, color: 'var(--text-2)', marginBottom: 8,
            }} onClick={() => { setShowAddPicker(true); setAddPickerStep('product') }}>
              + 從商品庫選擇
            </button>
          ) : (
            <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 10, marginBottom: 8, background: 'var(--surface)' }}>

              {/* Step 1：選商品 */}
              {addPickerStep === 'product' && (<>
                <input
                  className="form-input"
                  placeholder="搜尋商品名稱或 SKU…"
                  value={addSearch}
                  onChange={e => setAddSearch(e.target.value)}
                  autoFocus
                  style={{ marginBottom: 8 }}
                />
                <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                  {(() => {
                    const filtered = addProducts.filter(p =>
                      !addSearch || p.name.toLowerCase().includes(addSearch.toLowerCase()) || (p.sku || '').toLowerCase().includes(addSearch.toLowerCase())
                    )
                    if (filtered.length === 0) return <div className="muted fs12" style={{ padding: 10 }}>找不到商品</div>
                    return filtered.slice(0, 30).map(p => {
                      const pvs = addVariants[p.id]
                      const basePrice = addSpMap[p.id] ? Number(addSpMap[p.id].shop_price) : 0
                      const hasVariants = pvs && pvs.length > 0
                      return (
                        <div key={p.id} onClick={() => selectProdForVariant(p)}
                          style={{ padding: '9px 10px', cursor: 'pointer', borderRadius: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--bg)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        >
                          <div>
                            <div className="fs13 fw600">{p.name}</div>
                            <div className="muted fs12">
                              {hasVariants ? `${pvs.length} 種規格` : (basePrice > 0 ? `NT$${basePrice.toLocaleString()}` : '未定價')}
                              {p.sku ? ` · ${p.sku}` : ''}
                            </div>
                          </div>
                          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{hasVariants ? '▶' : ''}</span>
                        </div>
                      )
                    })
                  })()}
                </div>
              </>)}

              {/* Step 2：選規格 */}
              {addPickerStep === 'variant' && addSelectedProd && (<>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <button onClick={() => { setAddPickerStep('product'); setAddSelectedProd(null) }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: 'var(--text-3)', padding: 0, lineHeight: 1 }}>←</button>
                  <div>
                    <div className="fs13 fw600">{addSelectedProd.name}</div>
                    <div className="muted fs12">選擇規格</div>
                  </div>
                </div>
                <div style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {(addVariants[addSelectedProd.id] || []).map(v => {
                    const vLabel = Object.values(v.options || {}).map(valId => addValueMap[valId]).filter(Boolean).join(' / ')
                    const basePrice = addSpMap[addSelectedProd.id] ? Number(addSpMap[addSelectedProd.id].shop_price) : 0
                    const vPrice = v.variant_price != null ? Number(v.variant_price) : basePrice + (Number(v.price_adjustment) || 0)
                    const inStock = (v.stock ?? 0) > 0
                    return (
                      <div key={v.id} onClick={() => inStock ? pickProduct(addSelectedProd, v) : undefined}
                        style={{
                          padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)',
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          cursor: inStock ? 'pointer' : 'default',
                          opacity: inStock ? 1 : 0.4,
                          background: 'var(--bg)',
                        }}
                        onMouseEnter={e => { if (inStock) e.currentTarget.style.borderColor = 'var(--text)' }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
                      >
                        <div>
                          <div className="fs13 fw600">{vLabel || '（無規格標籤）'}</div>
                          <div className="muted fs12">庫存 {v.stock ?? 0} 件{!inStock ? ' · 缺貨' : ''}</div>
                        </div>
                        <span className="fs13 fw600">NT${vPrice.toLocaleString()}</span>
                      </div>
                    )
                  })}
                </div>
              </>)}

              <button style={{
                marginTop: 8, width: '100%', padding: '6px 0', borderRadius: 8,
                border: 'none', background: 'var(--bg)', cursor: 'pointer', fontSize: 13, color: 'var(--text-2)',
              }} onClick={closePicker}>取消</button>
            </div>
          )}

          {/* 手動輸入自訂品項（運費補差額、特殊費用等） */}
          <button style={{
            width: '100%', padding: '7px 0', borderRadius: 10, marginBottom: 8,
            border: '1px dashed var(--border)', background: 'none', cursor: 'pointer',
            fontSize: 12, color: 'var(--text-3)',
          }} onClick={() => setShowManualAdd(v => !v)}>
            {showManualAdd ? '▲ 收起手動輸入' : '▼ 手動輸入自訂品項（運費補差額等）'}
          </button>
          {showManualAdd && (
            <div className="card" style={{ marginBottom: 16, padding: 12 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8 }}>
                <input className="form-input" placeholder="品項名稱" value={addItemName}
                  onChange={e => setAddItemName(e.target.value)} style={{ fontSize: 13 }} />
                <input className="form-input" type="number" placeholder="單價" value={addItemPrice}
                  onChange={e => setAddItemPrice(e.target.value)} style={{ fontSize: 13 }} />
                <input className="form-input" type="number" min={1} placeholder="數量" value={addItemQty}
                  onChange={e => setAddItemQty(Number(e.target.value))} style={{ fontSize: 13 }} />
              </div>
              <button style={{
                marginTop: 8, width: '100%', padding: '6px 0', borderRadius: 8,
                border: '1px dashed var(--border)', background: 'none', cursor: 'pointer',
                fontSize: 13, color: 'var(--text-2)',
              }} onClick={() => {
                if (!addItemName || !addItemPrice) return
                setItemStatuses(prev => [...prev, {
                  name: addItemName,
                  price: Number(addItemPrice),
                  qty: addItemQty || 1,
                  _cancelled: false,
                  _added: true,
                  _originalQty: addItemQty || 1,
                }])
                setAddItemName('')
                setAddItemPrice('')
                setAddItemQty(1)
              }}>
                + 加入訂單
              </button>
            </div>
          )}
        </>
      )}

      {/* 免運門檻提示 */}
      {canEdit && hasAnyChange && activeItems.length > 0 && (
        <div style={{
          background: meetsThreshold ? '#f0fff4' : '#fff8e8',
          borderRadius: 12, padding: '14px 16px', marginBottom: 16,
          fontSize: 13, lineHeight: 1.6,
          color: meetsThreshold ? '#1a7a3a' : '#8a5c00',
        }}>
          {meetsThreshold
            ? `✅ 有貨商品小計 NT$${activeSubtotal.toLocaleString()}，符合免運門檻（NT$${FREE_SHIPPING_THRESHOLD.toLocaleString()}），運費 NT$0`
            : `⚠️ 有貨商品小計 NT$${activeSubtotal.toLocaleString()}，未達免運門檻（NT$${FREE_SHIPPING_THRESHOLD.toLocaleString()}）。請透過 Line / Email 聯繫消費者確認後，再更新運費或加購商品。`
          }
          {!meetsThreshold && (
            <div style={{ marginTop: 10 }}>
              <label className="form-label fs12">運費（NT$）</label>
              <input className="form-input" type="number" min={0} value={shippingFee}
                onChange={e => setShippingFee(Number(e.target.value))} style={{ fontSize: 13 }} />
            </div>
          )}
        </div>
      )}

      {/* 更新後金額摘要 */}
      {hasAnyChange && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-row row-sb">
            <span className="muted fs13">有貨商品小計</span>
            <span className="fs13">NT${activeSubtotal.toLocaleString()}</span>
          </div>
          {effectiveShippingFee > 0 && (
            <div className="card-row row-sb">
              <span className="muted fs13">運費</span>
              <span className="fs13">NT${effectiveShippingFee.toLocaleString()}</span>
            </div>
          )}
          {cancelledItems.length > 0 && (
            <div className="card-row row-sb">
              <span className="muted fs13" style={{ color: 'var(--red)' }}>取消商品（{cancelledItems.length} 件）</span>
              <span className="fs13" style={{ color: 'var(--red)', textDecoration: 'line-through' }}>
                -NT${cancelledItems.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.qty) || 0), 0).toLocaleString()}
              </span>
            </div>
          )}
          {discountAmount > 0 && (
            <div className="card-row row-sb">
              <span className="muted fs13" style={{ color: 'var(--green)' }}>{o.coupon_id ? '優惠券折抵' : '折讓金額'}</span>
              <span className="fs13" style={{ color: 'var(--green)' }}>-NT${discountAmount.toLocaleString()}</span>
            </div>
          )}
          <div className="card-row row-sb" style={{ borderTop: '1.5px solid var(--text)', paddingTop: 10 }}>
            <span className="fw600 fs13">更新後總金額</span>
            <span className="fw600">NT${newTotal.toLocaleString()}</span>
          </div>
        </div>
      )}

      {canEdit && (
        <>
          <div className="sec" style={{ marginTop: 0 }}>收款</div>
          <div className="card" style={{ marginBottom: 14, overflow: 'hidden' }}>
            {/* 狀態色塊：一眼看出目前狀態＋該做什麼，不可點擊（狀態由金額自動推導） */}
            <div style={{ padding: 14, background: heroInfo.bg }}>
              <div className="fw600" style={{ color: heroInfo.color, fontSize: 15 }}>{heroInfo.title}</div>
              <div className="fs12" style={{ color: 'var(--text-2)', marginTop: 2 }}>{heroInfo.sub}</div>
            </div>

            <div style={{ padding: 14 }}>
              <div className="card-row row-sb">
                <span className="muted fs13">折讓金額{o.coupon_id ? '（優惠券，鎖定）' : '（議價／服務補償）'}</span>
                {o.coupon_id ? (
                  <span className="fs13">NT${discountAmount.toLocaleString()}</span>
                ) : (
                  <input className="form-input" type="number" min={0}
                    style={{ width: 100, fontSize: 13, textAlign: 'right' }}
                    value={discountAmount || ''} placeholder="0" disabled={discountBusy}
                    onChange={e => setDiscountAmount(Math.max(0, Number(e.target.value) || 0))}
                    onBlur={applyDiscount} />
                )}
              </div>
              <div className="card-row row-sb">
                <span className="muted fs13">應付</span>
                <span className="fs13 fw600">NT${newTotal.toLocaleString()}</span>
              </div>
              <div className="card-row row-sb">
                <span className="muted fs13">已收</span>
                <span className="fs13">NT${paidAmount.toLocaleString()}</span>
              </div>
              {balanceDue !== 0 && !lockedAsPaid && (
                <div className="card-row row-sb">
                  <span className="fs13 fw600">差額</span>
                  <span className="fs13 fw600" style={{ color: balanceDue > 0 ? 'var(--amber)' : 'var(--red)' }}>
                    {balanceDue > 0 ? '+' : '−'}NT${Math.abs(balanceDue).toLocaleString()}
                    {balanceDue > 0 ? ' 待收' : ' 待退'}
                  </span>
                </div>
              )}

              {payments.length > 0 && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '0.5px solid var(--border)' }}>
                  {payments.map(p => (
                    <div key={p.id} className="row-sb" style={{ padding: '4px 0', gap: 8 }}>
                      <span className="muted fs12" style={{ flex: 1, minWidth: 0 }}>
                        {new Date(p.created_at).toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit' })}
                        {p.note ? ` · ${p.note}` : ''}
                      </span>
                      <span className="fs12 fw600" style={{ color: Number(p.amount) < 0 ? 'var(--red)' : 'var(--green)' }}>
                        {Number(p.amount) < 0 ? '−' : '+'}NT${Math.abs(Number(p.amount)).toLocaleString()}
                      </span>
                      <button onClick={() => removePayment(p.id)} disabled={payBusy}
                        style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', fontSize: 15, lineHeight: 1 }}>
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button onClick={() => openPayAction('in')} disabled={payBusy || discountBusy}
                  style={{ ...notifyBtn, flex: 1, background: '#e8f7ee', color: '#1a7a3a', border: '0.5px solid #c5e8d2' }}>
                  登記收款
                </button>
                <button onClick={() => openPayAction('out')} disabled={payBusy || discountBusy}
                  style={{ ...notifyBtn, flex: 1, background: 'var(--bg)', color: 'var(--text-2)', border: '0.5px solid var(--border)' }}>
                  登記退款
                </button>
              </div>

              {payAction && (
                <div style={{ background: 'var(--bg)', borderRadius: 10, padding: 10, marginTop: 10, border: '0.5px solid var(--border)' }}>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <input className="form-input" type="number" style={{ flex: 1, fontSize: 13 }}
                      autoFocus placeholder="金額"
                      value={payInput} onChange={e => setPayInput(e.target.value)} />
                    <input className="form-input" style={{ flex: 1.4, fontSize: 13 }}
                      placeholder="備註（選填）"
                      value={payNote} onChange={e => setPayNote(e.target.value)} />
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={cancelPayAction} disabled={payBusy}
                      style={{ ...notifyBtn, flex: 1, background: 'var(--surface)', color: 'var(--text-2)', border: '0.5px solid var(--border)' }}>
                      取消
                    </button>
                    <button onClick={confirmPayAction} disabled={payBusy || discountBusy}
                      style={{ ...notifyBtn, flex: 1, background: 'var(--text)', color: 'var(--bg)' }}>
                      確認{payAction === 'out' ? '退款' : '收款'}
                    </button>
                  </div>
                </div>
              )}

              <div className="muted fs12" style={{ marginTop: 10 }}>
                付款狀態由「已收」對「應付」自動判定，不需手動切換。
              </div>
            </div>
          </div>

          <div className="sec" style={{ marginTop: 0 }}>更新狀態</div>
          <div style={{ marginBottom: 14 }}>
            <label className="form-label fs12">訂單狀態</label>
            <CustomSelect
              label={status}
              value={status}
              options={['待確認', '處理中', '已購買', '已出貨', '完成', '已取消'].map(s => ({ value: s, label: s }))}
              onChange={v => v && setStatus(v)}
              allowClear={false}
            />
          </div>
          {(status === '已出貨' || status === '完成') && (
            <div style={{ marginBottom: 14 }}>
              <label className="form-label fs12">物流單號（選填）</label>
              <input className="form-input" placeholder="輸入物流追蹤單號" value={trackingNumber}
                onChange={e => setTrackingNumber(e.target.value)} style={{ fontSize: 13 }} />
            </div>
          )}
          <button className="btn" onClick={save} disabled={saving}>{saving ? '更新中…' : '儲存'}</button>

          {/* 綠界物流：cvs_store_id 有值才代表這筆是超商取貨訂單。
              交易編號讀不到（ecpay_transactions 沒開 RLS policy），這裡只顯示 consumer_orders 上的欄位。 */}
          {o.cvs_store_id && (
            <>
              <div className="sec" style={{ marginTop: 20 }}>綠界物流</div>
              <div className="card" style={{ marginBottom: 14, padding: 14 }}>
                <div className="card-row row-sb">
                  <span className="muted fs13">取貨門市</span>
                  <span className="fs13" style={{ textAlign: 'right' }}>
                    {o.shipping_subtype ? `${CVS_TYPE_LABEL[o.shipping_subtype] || o.shipping_subtype} ` : ''}
                    {o.cvs_store_name || '—'}（{o.cvs_store_id}）
                  </span>
                </div>
                <div className="card-row row-sb">
                  <span className="muted fs13">物流狀態</span>
                  <span className="fs13">{logiInfo.logistics_status_msg || logiInfo.logistics_status || '尚未建立物流單'}</span>
                </div>
                {logiInfo.allpay_logistics_id && (
                  <>
                    <div className="card-row row-sb">
                      <span className="muted fs13">綠界物流編號</span>
                      <span className="fs13">{logiInfo.allpay_logistics_id}</span>
                    </div>
                    {logiInfo.cvs_payment_no && (
                      <div className="card-row row-sb">
                        <span className="muted fs13">寄貨編號</span>
                        <span className="fs13">{logiInfo.cvs_payment_no}{logiInfo.cvs_validation_no ? `　驗證碼 ${logiInfo.cvs_validation_no}` : ''}</span>
                      </div>
                    )}
                  </>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
                {!logiInfo.allpay_logistics_id ? (
                  <button
                    onClick={handleCreateLogistics}
                    disabled={logiBusy}
                    style={{ ...notifyBtn, background: '#eef3ff', color: '#1e4d8c', border: '0.5px solid #bdd0f5' }}
                  >
                    {logiBusy ? '建立中…' : '📦 建立物流單'}
                  </button>
                ) : (
                  <button
                    onClick={handlePrintLabel}
                    style={{ ...notifyBtn, background: '#eef3ff', color: '#1e4d8c', border: '0.5px solid #bdd0f5' }}
                  >
                    🖨️ 列印託運單
                  </button>
                )}
              </div>
            </>
          )}

          {/* 手動寄信區塊 */}
          <div className="sec" style={{ marginTop: 20 }}>手動寄送通知</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              onClick={sendPaymentReceivedEmail}
              style={{ ...notifyBtn, background: '#e8f7ee', color: '#1a7a3a', border: '0.5px solid #c5e8d2' }}
            >
              ✉️ 寄出已收款通知
            </button>
            <button
              onClick={sendOrderModifiedEmail}
              style={{ ...notifyBtn, background: '#fff8e8', color: '#8a5c00', border: '0.5px solid #f0ddb0' }}
            >
              ✉️ 寄出訂單修改通知
            </button>
          </div>
          <div className="muted fs12" style={{ marginTop: 6 }}>
            出貨通知會在儲存時自動詢問（需已收款 + 狀態為已出貨）
          </div>
        </>
      )}
    </Sheet>
  )
}
