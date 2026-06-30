import { MenuPopover, SortMenu, FilterIcon } from './MenuPopover'

// 統一工具列：搜尋 ＋（可選）排序 ＋（可選）篩選 ＋（可選）動作槽。
// 庫存/商城/訂單共用。省略某個 prop 就不顯示該控制項。
// RWD：手機版搜尋框獨佔一行、控制項換到第二行靠右；桌機（≥768px）全部同一行。
//   sort   = { options, value, onChange }            // 省略＝不顯示排序
//   filter = { active, label, width, onClear, children }
//   actions= node（額外動作，如訂單匯出，放最右）
export default function ListToolbar({
  search, onSearch, placeholder = '搜尋…',
  sort, filter, actions,
}) {
  return (
    <div className="list-toolbar">
      {/* 搜尋框（排序/篩選/匯出收成圖示放在框內右側）*/}
      <div className="list-toolbar__search">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          value={search}
          onChange={e => onSearch(e.target.value)}
          placeholder={placeholder}
          style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 14, color: 'var(--text)', minWidth: 0 }}
        />
        {search && (
          <button onClick={() => onSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--text-3)', fontSize: 16, lineHeight: 1, flexShrink: 0 }}>✕</button>
        )}

        {(sort || filter || actions) && (
          <div className="list-toolbar__ctrls">
            {sort && (
              <SortMenu options={sort.options} value={sort.value} onChange={sort.onChange} />
            )}
            {filter && (
              <MenuPopover label={filter.label || '篩選'} icon={<FilterIcon />} active={filter.active} width={filter.width || 260}>
                {filter.children}
                {filter.active && filter.onClear && (
                  <button
                    onClick={filter.onClear}
                    style={{ alignSelf: 'flex-start', fontSize: 12, color: 'var(--red, #ef4444)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0' }}
                  >清除全部篩選</button>
                )}
              </MenuPopover>
            )}
            {actions}
          </div>
        )}
      </div>
    </div>
  )
}
