// 底部彈出面板的外框。訂單頁與客服收件匣共用。
//
// 樣式（.sheet-overlay / .sheet / .sheet-handle）在全站 CSS 裡，這裡不重新定義 ——
// 兩份樣式遲早漂移，而這個外框全站到處都在用。
export default function Sheet({ title, onClose, children }) {
  return (
    <div className="sheet-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <div className="sheet-handle" />
        <div className="row-sb" style={{marginBottom:20}}>
          <div className="sheet-title" style={{margin:0}}>{title}</div>
          <button onClick={onClose} style={{background:'none',border:'none',fontSize:22,cursor:'pointer',color:'var(--text-3)'}}>×</button>
        </div>
        {children}
      </div>
    </div>
  )
}
