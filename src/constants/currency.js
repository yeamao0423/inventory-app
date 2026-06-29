// 幣別集中定義（單一來源）
// 新增/調整幣別只改這個檔案，全站清單與符號自動同步。

// 幣別符號對應表
export const CURRENCY_SYMBOLS = {
  TWD: 'NT$',  // 新台幣（基準幣）
  JPY: '¥',    // 日圓
  KRW: '₩',    // 韓元
  THB: '฿',    // 泰銖
  VND: '₫',    // 越南盾
  IDR: 'Rp',   // 印尼盾
  CNY: 'CN¥',  // 人民幣（刻意與日圓 ¥ 區分）
  HKD: 'HK$',  // 港幣
  MYR: 'RM',   // 馬來西亞令吉
  PHP: '₱',    // 菲律賓披索
  SGD: 'S$',   // 新加坡幣
  USD: '$',    // 美元
  EUR: '€',    // 歐元
}

// 下拉選單顯示順序：基準幣 → 亞洲常見 → 歐美
export const SUPPORTED_CURRENCIES = [
  'TWD',
  'JPY', 'KRW', 'THB', 'VND', 'IDR', 'CNY', 'HKD', 'MYR', 'PHP', 'SGD',
  'USD', 'EUR',
]

// 取得幣別符號，未知幣別退回新台幣符號
export const getCurrencySymbol = (cur) => CURRENCY_SYMBOLS[cur] || 'NT$'
