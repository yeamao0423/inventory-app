// 通用置中彈窗外框。與 Sheet.jsx（底部抽屜，行動裝置慣用）是不同視覺模式，不合併。
// 內容完全由呼叫端組裝——這裡只負責 backdrop 與卡片容器。
export default function Modal({ onClose, children }) {
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}
