import { supabase } from './supabase'

const MAX_WIDTH = 1200
const MAX_HEIGHT = 1200
const QUALITY = 0.75

export function compressImage(file) {
  return new Promise((resolve) => {
    if (file.size < 100 * 1024) { resolve(file); return }

    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      let { width, height } = img
      if (width > MAX_WIDTH || height > MAX_HEIGHT) {
        const ratio = Math.min(MAX_WIDTH / width, MAX_HEIGHT / height)
        width = Math.round(width * ratio)
        height = Math.round(height * ratio)
      }
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      canvas.getContext('2d').drawImage(img, 0, 0, width, height)
      canvas.toBlob(
        (blob) => {
          if (blob && blob.size < file.size) {
            resolve(new File([blob], file.name.replace(/\.\w+$/, '.webp'), { type: 'image/webp' }))
          } else {
            resolve(file)
          }
        },
        'image/webp',
        QUALITY,
      )
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file) }
    img.src = url
  })
}

// 重新編碼為 webp（不限縮小條件、可控最長邊與品質）。
// 給「僅供 AI 辨識」的高解析照片用：格式不支援或檔案過大時轉檔，
// 與 compressImage 不同——不會因轉出檔比原檔大而退回原檔（重點是格式與尺寸合法）。
export function reencodeImage(file, maxDim, quality) {
  return new Promise((resolve) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      let { width, height } = img
      if (width > maxDim || height > maxDim) {
        const ratio = Math.min(maxDim / width, maxDim / height)
        width = Math.round(width * ratio)
        height = Math.round(height * ratio)
      }
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      canvas.getContext('2d').drawImage(img, 0, 0, width, height)
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(new File([blob], file.name.replace(/\.\w+$/, '.webp'), { type: 'image/webp' }))
          } else {
            resolve(file)
          }
        },
        'image/webp',
        quality,
      )
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file) }
    img.src = url
  })
}

// 清空商品在 Storage 的整個資料夾（{productId}/...）。
// best-effort：失敗只記 log 不丟錯，Storage 清理不該擋商品刪除本身。
export async function deleteProductStorage(productId) {
  try {
    const { data: files, error } = await supabase.storage
      .from('product-images').list(String(productId), { limit: 1000 })
    if (error || !files?.length) return
    await supabase.storage.from('product-images')
      .remove(files.map(f => `${productId}/${f.name}`))
  } catch (err) {
    console.error('Storage cleanup error:', err)
  }
}

// 依 public URL 刪除單一 Storage 檔案（best-effort，同上）。
export async function removeImageByUrl(url) {
  try {
    const path = url?.split('/product-images/')[1]
    if (!path) return
    await supabase.storage.from('product-images').remove([decodeURIComponent(path)])
  } catch (err) {
    console.error('Storage cleanup error:', err)
  }
}

export async function uploadImages(files, productId) {
  const results = []
  const errors = []
  for (let i = 0; i < files.length; i++) {
    const compressed = await compressImage(files[i])
    const ext = compressed.name.split('.').pop().toLowerCase()
    const path = `${productId}/${Date.now()}-${i}.${ext}`
    const { error } = await supabase.storage.from('product-images').upload(path, compressed)
    if (error) {
      console.error('Image upload error:', error)
      errors.push(error.message)
    } else {
      const { data: { publicUrl } } = supabase.storage.from('product-images').getPublicUrl(path)
      results.push(publicUrl)
    }
  }
  if (results.length > 0) {
    await supabase.from('product_images').insert(
      results.map((url, idx) => ({ product_id: productId, url, sort_order: idx }))
    )
  }
  if (errors.length > 0) {
    alert('部分圖片上傳失敗：' + errors.join(', '))
  }
}
