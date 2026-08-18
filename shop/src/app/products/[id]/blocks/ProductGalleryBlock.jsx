'use client'
// 商品圖庫。可調長寬比與要不要顯示縮圖列。
import { useProductState } from '../ProductStateProvider'

export default function ProductGalleryBlock({ block }) {
  const { visibleImages, name, galleryIndex, setGalleryIndex } = useProductState()
  // 一張圖都沒有就整塊不出現。空的圖框比沒有圖更糟：客人會以為圖沒載出來。
  if (!visibleImages.length) return null
  // current 是 ProductStateProvider 管的 galleryIndex，換規格時 setOption 會直接
  // 把它跳到該規格對應的那一張，不再靠 remount 歸零到 0。
  return (
    <Gallery
      images={visibleImages}
      current={galleryIndex}
      setCurrent={setGalleryIndex}
      name={name}
      ratio={block.ratio}
      thumbs={block.thumbs}
    />
  )
}

function Gallery({ images, current, setCurrent, name, ratio, thumbs }) {
  const many = images.length > 1

  return (
    <div className="pp-gallery">
      <div className="pp-gallery-main" style={{ '--pp-ratio': ratio }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={images[current].url} alt={name} className="pp-gallery-img" />
        {many && (
          <>
            <button type="button" className="pp-gallery-nav pp-gallery-prev" aria-label="上一張"
              onClick={() => setCurrent((current - 1 + images.length) % images.length)}>‹</button>
            <button type="button" className="pp-gallery-nav pp-gallery-next" aria-label="下一張"
              onClick={() => setCurrent((current + 1) % images.length)}>›</button>
            {/* 縮圖列關掉時，圓點是唯一「還有幾張」的線索，所以不跟著關 */}
            <div className="pp-gallery-dots">
              {images.map((img, i) => (
                <button key={img.id ?? i} type="button" aria-label={`第 ${i + 1} 張`}
                  className={`pp-gallery-dot${i === current ? ' is-on' : ''}`}
                  onClick={() => setCurrent(i)} />
              ))}
            </div>
          </>
        )}
      </div>

      {thumbs && many && (
        <div className="pp-gallery-thumbs">
          {images.map((img, i) => (
            <button key={img.id ?? i} type="button" onClick={() => setCurrent(i)}
              className={`pp-thumb${i === current ? ' is-on' : ''}`} aria-label={`第 ${i + 1} 張`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt="" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
