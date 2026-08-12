// 結帳表單草稿：去綠界選門市要整頁導轉，離開前把表單存起來，回來再還原。
// （不用彈窗——LINE 內建瀏覽器與手機常擋彈窗，被擋就是結帳直接卡死。）
import { CVS_SUBTYPES } from './ecpay'

export const CHECKOUT_DRAFT_KEY = 'daigogo-checkout-draft'

export function saveCheckoutDraft(storage, form) {
  try {
    storage?.setItem(CHECKOUT_DRAFT_KEY, JSON.stringify(form))
  } catch {
    // 隱私模式或配額滿：選門市仍可進行，只是回來要重填，不該讓整頁爆掉
  }
}

/** 讀取並清除草稿（一次性，避免下次結帳被舊資料汙染） */
export function readCheckoutDraft(storage) {
  try {
    const raw = storage?.getItem(CHECKOUT_DRAFT_KEY)
    if (!raw) return null
    storage.removeItem(CHECKOUT_DRAFT_KEY)
    return JSON.parse(raw)
  } catch {
    try { storage?.removeItem(CHECKOUT_DRAFT_KEY) } catch {}
    return null
  }
}

/** 從導回的 query 解析門市資訊；沒有門市代碼就回 null */
export function cvsFromSearchParams(searchParams) {
  const id = searchParams.get('cvs_store_id')
  if (!id) return null
  const subtype = searchParams.get('cvs_subtype')
  return {
    cvs_store_id: id,
    cvs_store_name: searchParams.get('cvs_store_name') || '',
    cvs_address: searchParams.get('cvs_address') || '',
    shipping_subtype: CVS_SUBTYPES.includes(subtype) ? subtype : null,
  }
}
