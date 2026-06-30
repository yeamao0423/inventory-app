// 排序比較器（單一來源）。共同規則：null/undefined/NaN/空字串 一律沉底（不論升降）。

function isNullish(v) {
  return v == null || (typeof v === 'number' && Number.isNaN(v)) || v === ''
}

// 數值比較
export function cmpNum(getVal, dir = 'asc') {
  return (a, b) => {
    const va = getVal(a), vb = getVal(b)
    const na = isNullish(va), nb = isNullish(vb)
    if (na && nb) return 0
    if (na) return 1
    if (nb) return -1
    return dir === 'asc' ? va - vb : vb - va
  }
}

// 字串比較（繁中 locale）
export function cmpStr(getVal, dir = 'asc') {
  return (a, b) => {
    const va = getVal(a), vb = getVal(b)
    const na = isNullish(va), nb = isNullish(vb)
    if (na && nb) return 0
    if (na) return 1
    if (nb) return -1
    const r = String(va).localeCompare(String(vb), 'zh-Hant')
    return dir === 'asc' ? r : -r
  }
}

// 日期字串（ISO）比較
export function cmpDate(getVal, dir = 'asc') {
  return cmpNum(x => { const v = getVal(x); return v ? Date.parse(v) : null }, dir)
}
