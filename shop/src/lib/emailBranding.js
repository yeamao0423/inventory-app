// 給 email API 共用：依 storeId 撈出寄信要用的店家品牌、匯款與聯絡資訊。
// 用 anon key（stores 對 anon 可讀）；撈不到 storeId 時退回平台預設，確保信仍寄得出去。
// 注意：找到店家但未填的欄位一律留空（不沿用平台預設），避免把某店的帳號/LINE 露給別店。
import { supabase } from './supabase'

// storeId 完全缺漏 / 撈不到店家時的平台預設（沿用舊行為，避免回歸）
const PLATFORM_DEFAULT = {
  name: 'Daigogo',
  bank: null,
  contactLine: 'https://line.me/R/ti/p/@705wgspe',
  contactEmail: 'daigogosg@gmail.com',
  notifyEmail: 'daigogosg@gmail.com',
}

export async function getStoreEmailBranding(storeId) {
  if (!storeId || !supabase) return PLATFORM_DEFAULT

  const { data } = await supabase
    .from('stores').select('name, slug, settings')
    .eq('id', storeId).maybeSingle()

  if (!data) return PLATFORM_DEFAULT

  const s = data.settings || {}
  const bank = s.bank_account
    ? {
        name: s.bank_name || '',
        code: s.bank_code || '',
        account: s.bank_account,
        holder: s.bank_account_holder || '',
      }
    : null

  return {
    name: data.name || PLATFORM_DEFAULT.name,
    bank,
    // 店家未填則留空，由信件模板自行決定隱藏該段（不沿用平台預設，避免跨店洩漏）
    contactLine: s.contact_line_url || '',
    contactEmail: s.contact_email || '',
    notifyEmail: s.order_notify_email || s.contact_email || s.sender_email || '',
  }
}
