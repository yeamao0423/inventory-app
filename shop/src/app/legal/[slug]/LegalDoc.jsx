'use client'
import { useEffect, useState } from 'react'

// 靜態頁桌機閱讀版型：hero + 左側 sticky 目錄（scroll-spy 高亮）+ 右側內文欄。
// 內容為伺服器端已渲染好的 HTML（含各章節 id），這裡只負責版型與捲動高亮。
export default function LegalDoc({ title, html, toc, updatedAt }) {
  const [activeId, setActiveId] = useState(toc?.[0]?.id || '')

  useEffect(() => {
    const headings = Array.from(document.querySelectorAll('.legal-content h3'))
    if (!headings.length) return
    const obs = new IntersectionObserver(
      entries => {
        for (const e of entries) {
          if (e.isIntersecting) setActiveId(e.target.id)
        }
      },
      { rootMargin: '-20% 0px -70% 0px' },
    )
    headings.forEach(h => obs.observe(h))
    return () => obs.disconnect()
  }, [html])

  const updated = updatedAt
    ? new Date(updatedAt).toLocaleDateString('zh-TW', { year: 'numeric', month: 'long', day: 'numeric' })
    : ''

  return (
    <div className="legal-page">
      <div className="legal-hero">
        <div className="legal-eyebrow">法律與政策</div>
        <h1 className="legal-title">{title}</h1>
        {updated && <div className="legal-meta">最後更新：{updated}</div>}
      </div>

      <div className="legal-layout">
        {toc.length > 1 && (
          <nav className="legal-toc" aria-label="目錄">
            <div className="legal-toc-title">目錄</div>
            {toc.map(t => (
              <a key={t.id} href={`#${t.id}`}
                className={activeId === t.id ? 'active' : ''}>
                {t.text}
              </a>
            ))}
          </nav>
        )}
        <main className="legal-main">
          <div className="legal-content" dangerouslySetInnerHTML={{ __html: html }} />
        </main>
      </div>
    </div>
  )
}
