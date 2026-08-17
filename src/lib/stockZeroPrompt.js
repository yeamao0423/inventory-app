// 切換銷售模式到「略過庫存」時，是否要跳出「庫存歸零嗎」確認框。
// 決策邏輯（shouldShowStockZeroPrompt）是純函式方便測；localStorage 讀寫與「今天」的
// 定義另外包裝，不測（比照 pushNotify.js 的 evaluateSupport 拆法）。

export const STOCK_ZERO_SNOOZE_KEY = 'ppStockZeroSnoozeDate'

export function shouldShowStockZeroPrompt({ nextSkipStockCheck, totalStock, snoozedDate, today }) {
  if (!nextSkipStockCheck) return false
  if (!(Number(totalStock) > 0)) return false
  if (snoozedDate && snoozedDate === today) return false
  return true
}

export function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

export function readSnoozeDate() {
  return localStorage.getItem(STOCK_ZERO_SNOOZE_KEY)
}

export function writeSnoozeToday(today) {
  localStorage.setItem(STOCK_ZERO_SNOOZE_KEY, today)
}
