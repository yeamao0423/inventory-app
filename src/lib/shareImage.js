// 把商品圖做成「2 欄拼圖」並透過 Web Share API 分享（手機可直接帶圖進 Line/社群）。
// 純瀏覽器工具：用 fetch→blob→createImageBitmap，畫到 canvas 後 toBlob，
// 走 object URL 故 canvas 不會被污染（避免 toBlob SecurityError）。

// 以 cover 方式把圖置中裁切填滿格子
function drawCover(ctx, bmp, dx, dy, dw, dh) {
  const ir = bmp.width / bmp.height
  const cr = dw / dh
  let sx, sy, sw, sh
  if (ir > cr) { sh = bmp.height; sw = sh * cr; sx = (bmp.width - sw) / 2; sy = 0 }
  else { sw = bmp.width; sh = sw / cr; sx = 0; sy = (bmp.height - sh) / 2 }
  ctx.drawImage(bmp, sx, sy, sw, sh, dx, dy, dw, dh)
}

async function fetchBitmap(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error('圖片下載失敗')
  const blob = await res.blob()
  return await createImageBitmap(blob)
}

// urls：商品圖網址陣列。cols 欄、每格 cell px 的方格拼圖。
// 偶數張剛好排滿；奇數張最後一格留白底。最多取 max 張避免檔案過大。
export async function buildCollageBlob(urls, { cols = 2, cell = 540, max = 8 } = {}) {
  const list = urls.slice(0, max)
  if (list.length === 0) throw new Error('此商品沒有圖片')
  const n = list.length
  const rows = Math.ceil(n / cols)
  const W = cols * cell
  const H = rows * cell

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, W, H)

  const bitmaps = await Promise.all(list.map(fetchBitmap))
  bitmaps.forEach((bmp, i) => {
    const c = i % cols
    const r = Math.floor(i / cols)
    drawCover(ctx, bmp, c * cell, r * cell, cell, cell)
  })

  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('產生圖片失敗'))), 'image/jpeg', 0.9))
  return blob
}

// 是否支援把檔案透過原生分享選單送出（手機）
export function canShareFile(file) {
  return typeof navigator !== 'undefined'
    && typeof navigator.canShare === 'function'
    && navigator.canShare({ files: [file] })
}

// 桌機退路：下載檔案
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
