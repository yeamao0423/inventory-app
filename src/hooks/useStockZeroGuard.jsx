import { useState } from 'react'
import StockZeroConfirmModal from '../components/StockZeroConfirmModal'
import { shouldShowStockZeroPrompt, readSnoozeDate, writeSnoozeToday, todayStr } from '../lib/stockZeroPrompt'

export function useStockZeroGuard({ totalStock, skipStockCheck, onZero }) {
  const [pendingApply, setPendingApply] = useState(null) // 待套用的切換動作，或 null

  function guard(nextSkipStockCheck, apply) {
    const alreadySkip = !!skipStockCheck
    if (!alreadySkip && shouldShowStockZeroPrompt({
      nextSkipStockCheck,
      totalStock,
      snoozedDate: readSnoozeDate(),
      today: todayStr(),
    })) {
      setPendingApply(() => apply)
      return
    }
    apply()
  }

  const modal = pendingApply ? (
    <StockZeroConfirmModal
      totalStock={totalStock}
      onResolve={(shouldZero, snoozeToday) => {
        if (snoozeToday) writeSnoozeToday(todayStr())
        if (shouldZero) onZero()
        pendingApply()
        setPendingApply(null)
      }}
    />
  ) : null

  return { guard, modal }
}
