import { useState, useEffect, useRef } from 'react'

/**
 * CustomSelect — mirrors shop's FilterDropdown style.
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
 */
export default function CustomSelect({
  label, value, options, onChange,
  compact = false, style, className = '', allowClear = true,
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', handleClick)
    return () => document.removeEventListener('pointerdown', handleClick)
  }, [open])

  const selected = options.find(o => o.value === value)

  return (
    <div
      className={`custom-dropdown${compact ? ' compact' : ''} ${className}`}
      ref={ref}
      style={style}
    >
      <button
        type="button"
        className="custom-dropdown-btn"
        onClick={() => setOpen(v => !v)}
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
      {open && (
        <div className="custom-dropdown-menu">
          {allowClear && (
            <div
              className={`custom-dropdown-item ${!value && value !== 0 ? 'active' : ''}`}
              onClick={() => { onChange(null); setOpen(false) }}
            >
              {label}
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
        </div>
      )}
    </div>
  )
}
