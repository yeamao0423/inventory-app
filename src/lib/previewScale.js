// 預覽畫布的裝置寬度與縮放比例。
//
// 為什麼 iframe 要真的渲染在 1280px 而不是直接把它塞進 650px 的欄位：
// iframe 裡的 media query 量的是 iframe 自己的寬度，不是螢幕寬度。
// 商城的桌機斷點在 901px / 1024px，欄位再怎麼寬也只有幾百 px，
// 所以「縮小 iframe」等於對商城說「你在小螢幕上」—— 預覽永遠會是手機版。
// 正解是讓 iframe 在裝置寬度渲染，再用 transform 縮到欄位放得下（Elementor、
// WordPress 自訂器、Webflow 都是這個做法）。
//
// 這支檔案只做算術，沒有 DOM，所以測得到；量測容器寬度是 LivePreview 的事。

export const DEVICES = {
  desktop: { label: '桌機', width: 1280 },
  tablet:  { label: '平板', width: 834 },
  mobile:  { label: '手機', width: 390 },
}

/**
 * 容器放得下就原尺寸（1），放不下才等比縮小。
 *
 * 永遠不回 0 或負數：呼叫端用 `height: calc(100% / var(--lp-scale))` 把縮放後
 * 少掉的高度補回去，除以零會讓整個畫布崩掉。ResizeObserver 第一次回報、
 * 元素還沒佈局時 containerWidth 就是 0，那是常態不是例外，退回 1 讓畫面先出來。
 */
export function computeScale(containerWidth, deviceWidth) {
  // 只認真正的數字。字串寬度（'650px'、'650'）代表呼叫端量錯了東西，
  // 悄悄幫它轉型只會把錯誤藏到更難查的地方。
  if (typeof containerWidth !== 'number' || !Number.isFinite(containerWidth)) return 1
  if (typeof deviceWidth !== 'number' || !Number.isFinite(deviceWidth)) return 1
  if (containerWidth <= 0 || deviceWidth <= 0) return 1
  return Math.min(1, containerWidth / deviceWidth)
}
