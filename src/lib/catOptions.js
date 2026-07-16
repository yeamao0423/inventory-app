// 分類下拉選項（含階層）：頂層在前、子分類跟在父後，label 顯示「父 › 子」。
// 後台 CustomSelect 共用；商城 FilterDropdown 有自己的縮排版（shop ProductList.jsx）。
export function buildCatOptions(categories) {
  const tops = categories.filter(c => !c.parent_id)
  // 父分類不在清單內的子分類（理論上不會發生）當頂層顯示，避免消失
  const orphans = categories.filter(c => c.parent_id && !categories.some(p => p.id === c.parent_id))
  return [...tops, ...orphans].flatMap(p => [
    { value: String(p.id), label: p.name },
    ...categories.filter(c => c.parent_id === p.id).map(k => ({ value: String(k.id), label: `${p.name} › ${k.name}` })),
  ])
}
