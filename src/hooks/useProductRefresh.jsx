import { createContext, useContext, useState, useCallback } from 'react'

// 快速／批量上架移到全域置頂欄後，觸發者不再是商品頁本身，
// 沒辦法像以前那樣直接呼叫 fetchProducts()。
// 這裡用一個遞增的 version 當「商品資料已變動」的訊號：
// 置頂欄存檔後 bump()，商品頁把 version 放進 fetch 的 deps 就會重抓。
const ProductRefreshContext = createContext({ version: 0, bump: () => {} })

export function ProductRefreshProvider({ children }) {
  const [version, setVersion] = useState(0)
  const bump = useCallback(() => setVersion(v => v + 1), [])
  return (
    <ProductRefreshContext.Provider value={{ version, bump }}>
      {children}
    </ProductRefreshContext.Provider>
  )
}

export const useProductRefresh = () => useContext(ProductRefreshContext)
