import { useState } from 'react'
import { BRAND_PRESETS, normalizeHex, brandVars, contrastRatio } from '../lib/brandColor'

// 品牌主色選擇器：8–10 個預設色 + 自訂 hex。
//
// 重點是那個「按鈕預覽」：店主選了淺黃色時，白字會看不見，所以前景色是算出來的，不是寫死白色。
// 預覽直接用商城會用的同一組計算（brandVars），所見即所得。
export default function BrandColorPicker({ value, onChange }) {
  const current = normalizeHex(value)
  const [custom, setCustom] = useState(current || '')

  const vars = brandVars(current)
  // 連結／價格是畫在白底上的文字，主色太淺時商城會自動壓深；這裡把壓深前後都講清楚
  const softened = vars && vars['--brand-text'] !== vars['--brand']

  function pick(hex) {
    onChange(hex)
    setCustom(hex)
  }

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {/* 不設定＝維持平台預設外觀（黑），商城端一個位元組的樣式都不會注入 */}
        <Swatch hex={null} active={!current} onClick={() => { onChange(''); setCustom('') }} title="不設定（平台預設）" />
        {BRAND_PRESETS.map(p => (
          <Swatch key={p.hex} hex={p.hex} active={current === p.hex} onClick={() => pick(p.hex)} title={p.name} />
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>自訂</span>
        <input type="color" value={current || '#1a1a1a'}
          onChange={e => pick(e.target.value)}
          style={{ width: 38, height: 30, padding: 0, border: '1px solid var(--border)', borderRadius: 6, background: 'none', cursor: 'pointer' }} />
        <input className="form-input" value={custom} placeholder="#1a1a1a"
          onChange={e => {
            setCustom(e.target.value)
            const hex = normalizeHex(e.target.value)
            if (hex) onChange(hex)
          }}
          style={{ width: 120, fontSize: 13 }} />
        {custom && !normalizeHex(custom) && (
          <span style={{ fontSize: 12, color: 'var(--red)' }}>色碼格式要像 #1a1a1a</span>
        )}
      </div>

      {vars && (
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{
            display: 'inline-block', padding: '9px 18px', borderRadius: 10,
            background: vars['--brand'], color: vars['--brand-fg'], fontSize: 13.5, fontWeight: 600,
          }}>
            按鈕預覽
          </span>
          <span style={{ color: vars['--brand-text'], fontSize: 13.5, fontWeight: 600 }}>連結／價格</span>
          <span style={{
            display: 'inline-block', padding: '3px 10px', borderRadius: 20,
            background: vars['--brand-soft'], color: vars['--brand-text'], fontSize: 11.5, fontWeight: 600,
          }}>
            標籤
          </span>
          <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
            按鈕文字對比 {contrastRatio(vars['--brand'], vars['--brand-fg']).toFixed(1)}:1
            {softened && '｜主色偏淺，連結與價格會自動壓深才看得清楚'}
          </span>
        </div>
      )}
    </div>
  )
}

function Swatch({ hex, active, onClick, title }) {
  return (
    <button type="button" onClick={onClick} title={title} aria-label={title}
      style={{
        width: 30, height: 30, borderRadius: '50%', cursor: 'pointer',
        background: hex || 'linear-gradient(135deg, #fff 45%, var(--border) 45%, var(--border) 55%, #fff 55%)',
        border: active ? '2px solid var(--text)' : '1px solid var(--border)',
        boxShadow: active ? '0 0 0 2px var(--bg), 0 0 0 3px var(--text)' : 'none',
      }} />
  )
}
