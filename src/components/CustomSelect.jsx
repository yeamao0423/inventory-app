import { useState, useEffect, useRef, useLayoutEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'

/**
 * CustomSelect — mirrors shop's FilterDropdown style.
 *
 * 選單以 Portal + position:fixed 渲染到 <body>，依按鈕的位置即時計算座標，
 * 因此不會被任何祖先的 overflow:hidden（.card）或 overflow:auto（.sheet）裁切。
 *
 * Props:
 *   label       – placeholder text when nothing selected (e.g. "— 選擇來源 —")
 *   value       – currently selected value (null/undefined/"" = none)
 *   options     – [{ value, label }]
 *   onChange    – (value) => void   (passes null when "all/none" is chosen)
 *   compact     – boolean, smaller variant for filter bars
 *   style       – optional style on wrapper
 *   className   – optional extra class on wrapper
 *   allowClear  – if true, show the label option to clear selection (default true)
 *   emptyText   – shown when options is empty and there is no clear row，
 *                 否則選單會渲染成一條看不見的空框（曾被誤判為選單被遮住）
 */
export default function CustomSelect({
  label, value, options, onChange,
  compact = false, style, className = '', allowClear = true,
  emptyText = '沒有可選的項目',
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null) // { left, width, top?, bottom?, maxHeight, placement }
  const ref = useRef(null)      // wrapper（含按鈕）
  const menuRef = useRef(null)  // portal 出去的選單

  const updatePosition = useCallback(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const vh = window.innerHeight
    const spaceBelow = vh - rect.bottom
    const spaceAbove = rect.top
    const GAP = 6
    const MARGIN = 12
    const up = spaceBelow < 240 && spaceAbove > spaceBelow
    if (up) {
      setPos({
        left: rect.left, width: rect.width, placement: 'up',
        bottom: vh - rect.top + GAP,
        maxHeight: Math.max(120, spaceAbove - MARGIN),
      })
    } else {
      setPos({
        left: rect.left, width: rect.width, placement: 'down',
        top: rect.bottom + GAP,
        maxHeight: Math.max(120, spaceBelow - MARGIN),
      })
    }
  }, [])

  // 開啟時在 paint 前先算好位置，避免閃爍
  useLayoutEffect(() => {
    if (open) updatePosition()
  }, [open, updatePosition])

  useEffect(() => {
    if (!open) return
    function handleClick(e) {
      if (ref.current?.contains(e.target)) return
      if (menuRef.current?.contains(e.target)) return
      setOpen(false)
    }
    function reposition() { updatePosition() }
    document.addEventListener('click', handleClick, true)
    // capture：捕捉任何捲動容器（含 .sheet）的捲動，讓選單跟著按鈕
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      document.removeEventListener('click', handleClick, true)
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open, updatePosition])

  const selected = options.find(o => o.value === value)

  const handleToggle = () => setOpen(v => !v)

  return (
    <div
      className={`custom-dropdown${compact ? ' compact' : ''} ${className}`}
      ref={ref}
      style={style}
    >
      <button
        type="button"
        className="custom-dropdown-btn"
        onClick={handleToggle}
      >
        <span className={selected ? 'custom-dropdown-selected' : ''}>
          {selected ? selected.label : label}
        </span>
        <svg
          width="14" height="14" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2.5"
          style={{ flexShrink: 0, transition: 'transform .2s', transform: open ? 'rotate(180deg)' : '' }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          className={`custom-dropdown-menu${pos.placement === 'up' ? ' dropup' : ''}${compact ? ' compact' : ''}`}
          style={{
            position: 'fixed',
            left: pos.left,
            width: pos.width,
            right: 'auto',
            top: pos.top ?? 'auto',
            bottom: pos.bottom ?? 'auto',
            maxHeight: pos.maxHeight,
            zIndex: 1000,
          }}
        >
          {allowClear && (
            <div
              className={`custom-dropdown-item ${!value && value !== 0 ? 'active' : ''}`}
              onClick={() => { onChange(null); setOpen(false) }}
            >
              {label}
            </div>
          )}
          {!allowClear && options.length === 0 && (
            <div className="custom-dropdown-item" style={{ color: 'var(--text-3)', cursor: 'default' }}>
              {emptyText}
            </div>
          )}
          {options.map(opt => (
            <div
              key={opt.value}
              className={`custom-dropdown-item ${value === opt.value ? 'active' : ''}`}
              onClick={() => { onChange(opt.value); setOpen(false) }}
            >
              {opt.label}
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}
