'use client'
// 客製備註。商品有設 custom_options 就照它的標題／提示字畫，沒有就給一個通用備註欄
// —— 與 ProductDetail 一致：這一欄任何商品都該有，不是有設定才有。
//
// 注意：多個 custom_options 共用同一個 customNote 狀態（打在哪一格，每一格都跟著變）。
// 這是既有行為，搬過來時原樣保留；要修的話是另一件事，而且要連 ProductDetail 一起修。
import { useProductState } from '../ProductStateProvider'

export default function ProductNoteBlock() {
  const { t, customOptions, customNote, setCustomNote } = useProductState()

  const fields = customOptions.length
    ? customOptions.map(opt => ({
      key: opt.id,
      label: opt.label + (opt.required ? ' *' : ''),
      placeholder: opt.placeholder || t('product.custom_placeholder'),
    }))
    : [{ key: 'default', label: t('product.custom_note'), placeholder: t('product.custom_placeholder') }]

  return (
    <>
      {fields.map(f => (
        <div className="spec-group" key={f.key}>
          <div className="spec-label">{f.label}</div>
          <textarea
            className="custom-textarea"
            placeholder={f.placeholder}
            value={customNote}
            onChange={e => setCustomNote(e.target.value)}
          />
        </div>
      ))}
    </>
  )
}
