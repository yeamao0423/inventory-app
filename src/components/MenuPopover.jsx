import { useState } from 'react'

// 工具列控制項：搜尋框內的圖示鈕 → 點開浮出小卡（點外面關閉）。
// 手機只顯示圖示；桌機（≥768px）顯示圖示＋文字標籤＋箭頭（由 .lt-ctrl CSS 控制）。

export function SortIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h12M3 12h9M3 18h6" /><path d="M17 8l4-4 4 4" transform="translate(-3 1)" />
    </svg>
  )
}

export function FilterIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </svg>
  )
}

// 圖示鈕 + 浮出卡。children 可為一般節點，或 (close) => node。
export function MenuPopover({ label, icon, active = false, width = 260, children }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ position: 'relative' }}>
      <button className={`lt-ctrl${active ? ' is-active' : ''}`} onClick={() => setOpen(v => !v)}>
        {icon}
        <span className="lt-ctrl__label">{label}</span>
        <svg className="lt-ctrl__chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ transition: 'transform .2s', transform: open ? 'rotate(180deg)' : '' }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 19 }} />
          <div style={{
            position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 20, width,
            background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14,
            boxShadow: '0 8px 24px rgba(0,0,0,.12)', padding: 14,
            display: 'flex', flexDirection: 'column', gap: 12,
          }}>
            {typeof children === 'function' ? children(() => setOpen(false)) : children}
          </div>
        </>
      )}
    </div>
  )
}

export function Pill({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 12px', borderRadius: 20, border: '1px solid var(--border)',
        background: active ? 'var(--text)' : 'var(--card)',
        color: active ? '#fff' : 'var(--text-2)',
        fontSize: 13, fontWeight: active ? 700 : 400, cursor: 'pointer', whiteSpace: 'nowrap',
      }}
    >{children}</button>
  )
}

export function PillSection({ title, children }) {
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-3)', marginBottom: 8 }}>{title}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{children}</div>
    </div>
  )
}

// 排序選單：options = [{ group, items: [{ value, label }] }]
export function SortMenu({ options, value, onChange }) {
  const flat = options.flatMap(g => g.items)
  const current = flat.find(o => o.value === value)
  const isDefault = value === flat[0]?.value
  return (
    <MenuPopover label={current?.label || '排序'} icon={<SortIcon />} active={!isDefault} width={240}>
      {(close) => options.map(g => (
        <PillSection key={g.group} title={g.group}>
          {g.items.map(o => (
            <Pill key={o.value} active={value === o.value} onClick={() => { onChange(o.value); close() }}>
              {o.label}
            </Pill>
          ))}
        </PillSection>
      ))}
    </MenuPopover>
  )
}
