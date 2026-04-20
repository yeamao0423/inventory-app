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
