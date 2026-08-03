// 中文輸入法選字中按 Enter，只是在確認候選字，不該被當成「送出」。
//
// React 的合成事件要看 nativeEvent.isComposing；keyCode 229 是部分 IME 與舊版 Safari
// 在組字期間統一回報的值，兩個都判才擋得乾淨。
//
// 用法：onKeyDown={e => { if (isComposing(e)) return; if (e.key === 'Enter') save() }}
//
// shop/src/lib/imeSafeEnter.js 是這支的複本（shop 是獨立 npm 專案，跨 package 匯入不划算）。
// 與 pricing.js ↔ salePrice.js 同一種關係：**改一邊記得改另一邊。**
export function isComposing(e) {
  if (!e) return false
  const composing = e.nativeEvent?.isComposing ?? e.isComposing
  return Boolean(composing) || e.keyCode === 229
}
