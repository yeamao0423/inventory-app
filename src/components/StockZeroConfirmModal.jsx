import { useState } from 'react'
import Modal from './Modal'

export default function StockZeroConfirmModal({ totalStock, onResolve }) {
  const [snoozeToday, setSnoozeToday] = useState(false)
  const resolve = shouldZero => onResolve(shouldZero, snoozeToday)

  return (
    <Modal onClose={() => resolve(false)}>
      <div className="fw600 fs15" style={{ marginBottom: 10 }}>切換為略過庫存</div>
      <div className="fs13" style={{ color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 16 }}>
        目前庫存 {totalStock} 件，切換後將不再檢查庫存。是否要將庫存歸零？
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 16, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={snoozeToday}
          onChange={e => setSnoozeToday(e.target.checked)}
        />
        <span className="fs12 muted">今天不再提醒</span>
      </label>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn btn-outline" onClick={() => resolve(false)} style={{ marginBottom: 0 }}>保留庫存</button>
        <button className="btn" onClick={() => resolve(true)} style={{ marginBottom: 0 }}>歸零並繼續</button>
      </div>
    </Modal>
  )
}
