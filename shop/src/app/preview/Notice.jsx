// 預覽頁畫不出內容時的提示（權限、憑證、設定問題都走這個）。
// 刻意只講狀況、不吐任何草稿內容。
export default function Notice({ title, detail }) {
  return (
    <div className="container" style={{ padding: '80px 20px', textAlign: 'center', color: 'var(--text-2)' }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>{title}</div>
      <div style={{ fontSize: 14 }}>{detail}</div>
    </div>
  )
}
