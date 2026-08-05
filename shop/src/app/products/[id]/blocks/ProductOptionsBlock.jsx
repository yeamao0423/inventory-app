'use client'
// 規格選擇。選了什麼會同時牽動價格、庫存、能不能買、圖庫顯示哪幾張圖 ——
// 那些連動全部住在 ProductStateProvider，這裡只負責畫按鈕與回報點了哪一個。
import { useProductState } from '../ProductStateProvider'
import { repImageFor } from '../../../../lib/variantImages'

export default function ProductOptionsBlock({ block }) {
  const {
    activeTypes, variants, selectedOptions, sortedImages, setOption, isValueSoldOut,
    autoSwitched, zh,
  } = useProductState()

  // 這件商品根本沒有規格 → 整塊不出現。範本是全店共用的，一定會遇到沒規格的商品，
  // 畫個空殼只會讓客人以為東西壞了。
  if (!activeTypes.length) return null

  return (
    <div className="pp-options">
      {activeTypes.map(type => {
        const valueIds = [...new Set(variants.map(v => v.options?.[String(type.id)]).filter(Boolean))]
        const values = valueIds
          .map(vid => type.variant_option_values?.find(v => v.id === vid))
          .filter(Boolean)
          .sort((a, b) => a.sort_order - b.sort_order)
        const selectedVid = selectedOptions[String(type.id)]
        const selectedVal = type.variant_option_values?.find(v => v.id === selectedVid)

        return (
          <div className="spec-group" key={type.id}>
            <div className="spec-label">
              {type.name}{selectedVal ? <>: <strong>{selectedVal.value}</strong></> : ''}
            </div>
            <div className="pp-chips">
              {values.map(val => {
                const isSelected = selectedVid === val.id
                const soldOut = isValueSoldOut(type.id, val.id)
                // chipStyle=text 時一律文字 chip；auto 才在有代表圖時改用圖片 chip
                //（圖片 chip 與 gallery 過濾互補：點了它就等於選了這個值）
                const rep = block.chipStyle === 'text' ? null : repImageFor(sortedImages, type.id, val.id)
                return (
                  <button
                    key={val.id}
                    type="button"
                    title={val.value}
                    disabled={soldOut}
                    onClick={() => !soldOut && setOption(type.id, val.id)}
                    className={[
                      'pp-chip',
                      rep ? 'pp-chip-img' : '',
                      isSelected ? 'is-selected' : '',
                      soldOut ? 'is-soldout' : '',
                    ].filter(Boolean).join(' ')}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {rep && <img src={rep.url} alt="" />}
                    {val.value}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}

      {/* 庫存補正把客人的選擇換掉時一定要講。默默改掉比不改更糟 ——
          他以為自己買的是 M，結帳單上卻是 L。 */}
      {autoSwitched && (
        <div className="pp-auto-switch">
          {zh ? `你剛才選的「${autoSwitched.from}」已售完，已改成「${autoSwitched.to}」。`
              : `“${autoSwitched.from}” just sold out, switched to “${autoSwitched.to}”.`}
        </div>
      )}
    </div>
  )
}
