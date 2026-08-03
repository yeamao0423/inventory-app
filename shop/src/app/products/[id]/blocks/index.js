// product_* 區塊的型別 → 元件對照表。
//
// 只有這張表決定「哪些動態區塊畫得出來」。contentBlocks.js 的 PRODUCT_BLOCK_TYPES
// 決定哪些存得進資料庫，兩邊都要有才會出現在頁面上 —— 少一邊就是靜靜地什麼都不畫。
import ProductGalleryBlock from './ProductGalleryBlock'
import ProductTitleBlock from './ProductTitleBlock'
import ProductPriceBlock from './ProductPriceBlock'
import ProductDescBlock from './ProductDescBlock'
import ProductOptionsBlock from './ProductOptionsBlock'
import ProductStatusBlock from './ProductStatusBlock'
import ProductQtyBlock from './ProductQtyBlock'
import ProductNoteBlock from './ProductNoteBlock'
import ProductCtaBlock from './ProductCtaBlock'

export const PRODUCT_RENDERERS = {
  product_gallery: ProductGalleryBlock,
  product_title: ProductTitleBlock,
  product_price: ProductPriceBlock,
  product_desc: ProductDescBlock,
  product_options: ProductOptionsBlock,
  product_status: ProductStatusBlock,
  product_qty: ProductQtyBlock,
  product_note: ProductNoteBlock,
  product_cta: ProductCtaBlock,
}
