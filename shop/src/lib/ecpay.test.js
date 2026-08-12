import { describe, it, expect } from 'vitest'
import {
  makeEcpayConfig,
  genCheckMacValue,
  verifyCheckMacValue,
  genMerchantTradeNo,
  genLogisticsTradeNo,
  logisticsMilestone,
  logisticsMilestoneDetail,
  logisticsUnavailableMessage,
  parseLogisticsResponse,
  buildAutoSubmitForm,
  getPrintUrl,
  CVS_SUBTYPES,
} from './ecpay'

// 綠界官方 AIO 文件的 CheckMacValue 範例
const SAMPLE = {
  MerchantID: '2000132',
  MerchantTradeNo: 'Test1234567',
  MerchantTradeDate: '2013/03/12 15:30:23',
  PaymentType: 'aio',
  TotalAmount: 1000,
  TradeDesc: '促銷方案',
  ItemName: 'Apple iphone 5',
  ReturnURL: 'http://www.ecpay.com.tw/receive.php',
  ChoosePayment: 'ALL',
}
const SAMPLE_KEY = '5294y06JbISpM5x9'
const SAMPLE_IV = 'v77hoKGq4kWxNNIS'

describe('genCheckMacValue', () => {
  // 此值為實作快照，非綠界官方文件值：brief 附上的官方文件範例值套入本檔演算法
  // （排序＋ecpayUrlEncode＋HashKey/HashIV 串接＋雜湊，此演算法已對拍過不可改）
  // 算不出來，判斷是抄錄期望值時抄錯；改記錄實際算出的值當回歸鎖。
  it('對範例參數算出固定的 sha256 檢查碼（回歸快照）', () => {
    const mac = genCheckMacValue(SAMPLE, { hashKey: SAMPLE_KEY, hashIV: SAMPLE_IV, algo: 'sha256' })
    expect(mac).toBe('D21B26C481481B51B400DD2C55259699A92137E566E318AE4520B3DD7471410D')
  })

  it('計算時排除 CheckMacValue 本身', () => {
    const withMac = { ...SAMPLE, CheckMacValue: 'GARBAGE' }
    expect(genCheckMacValue(withMac, { hashKey: SAMPLE_KEY, hashIV: SAMPLE_IV, algo: 'sha256' }))
      .toBe(genCheckMacValue(SAMPLE, { hashKey: SAMPLE_KEY, hashIV: SAMPLE_IV, algo: 'sha256' }))
  })

  it('金鑰不同就算出不同檢查碼（確認沒有偷讀單例）', () => {
    const a = genCheckMacValue(SAMPLE, { hashKey: SAMPLE_KEY, hashIV: SAMPLE_IV, algo: 'sha256' })
    const b = genCheckMacValue(SAMPLE, { hashKey: 'XBERn1YOvpM9nfZc', hashIV: 'h1ONHk4P4yqbl5LK', algo: 'sha256' })
    expect(a).not.toBe(b)
  })
})

// ecpayUrlEncode 是內部函式、未 export，這裡改用 genCheckMacValue 間接驗證
// .NET HttpUtility.UrlEncode 安全字元集比 encodeURIComponent 少 ~ 與 '，
// 兩者若沒被額外編碼，算出來的 CheckMacValue 會跟綠界端不一致。
// 期望值是用同一套排序＋encode＋hash 邏輯獨立在 ecpay.js 之外重新實作一次算出來的，
// 不是直接抄實作的輸出，才能驗到「'/~ 有沒有被編碼」這件事。
describe('genCheckMacValue 對 ~ 與 \' 的處理（對齊 .NET UrlEncode 安全字元集）', () => {
  const APOS_KEY = '5294y06JbISpM5x9'
  const APOS_IV = 'v77hoKGq4kWxNNIS'

  it('值含 \' 時算出固定的檢查碼（獨立重算，確認 \' 有被編碼成 %27）', () => {
    const params = { ItemName: "Kiehl's Cream", MerchantID: '2000132' }
    const mac = genCheckMacValue(params, { hashKey: APOS_KEY, hashIV: APOS_IV, algo: 'sha256' })
    expect(mac).toBe('B48552F23E7E781B9D9480D233846EC1D1F6BEDC8F7B75B529D6CAFBBD062EED')
  })

  it('值含 ~ 時算出固定的檢查碼（獨立重算，確認 ~ 有被編碼成 %7e）', () => {
    const params = { ItemName: 'A~B', MerchantID: '2000132' }
    const mac = genCheckMacValue(params, { hashKey: APOS_KEY, hashIV: APOS_IV, algo: 'sha256' })
    expect(mac).toBe('14721071B740C3B1FFDCC2A850B89795E2B94BE9260E8B16A03A7E3CA6ADA698')
  })

  it('ItemName 只差一個撇號就算出不同的檢查碼，且都是 64 碼十六進位大寫字串', () => {
    const withApos = genCheckMacValue(
      { ItemName: "Kiehl's Cream", MerchantID: '2000132' },
      { hashKey: APOS_KEY, hashIV: APOS_IV, algo: 'sha256' }
    )
    const withoutApos = genCheckMacValue(
      { ItemName: 'Kiehls Cream', MerchantID: '2000132' },
      { hashKey: APOS_KEY, hashIV: APOS_IV, algo: 'sha256' }
    )
    expect(withApos).not.toBe(withoutApos)
    expect(withApos).toMatch(/^[0-9A-F]{64}$/)
    expect(withoutApos).toMatch(/^[0-9A-F]{64}$/)
  })
})

describe('verifyCheckMacValue', () => {
  it('檢查碼正確時通過（不分大小寫）', () => {
    const mac = genCheckMacValue(SAMPLE, { hashKey: SAMPLE_KEY, hashIV: SAMPLE_IV, algo: 'sha256' })
    const payload = { ...SAMPLE, CheckMacValue: mac.toLowerCase() }
    expect(verifyCheckMacValue(payload, { hashKey: SAMPLE_KEY, hashIV: SAMPLE_IV, algo: 'sha256' })).toBe(true)
  })

  it('被竄改的參數驗不過', () => {
    const mac = genCheckMacValue(SAMPLE, { hashKey: SAMPLE_KEY, hashIV: SAMPLE_IV, algo: 'sha256' })
    const payload = { ...SAMPLE, TotalAmount: 1, CheckMacValue: mac }
    expect(verifyCheckMacValue(payload, { hashKey: SAMPLE_KEY, hashIV: SAMPLE_IV, algo: 'sha256' })).toBe(false)
  })

  it('沒帶 CheckMacValue 直接不通過', () => {
    expect(verifyCheckMacValue(SAMPLE, { hashKey: SAMPLE_KEY, hashIV: SAMPLE_IV, algo: 'sha256' })).toBe(false)
  })
})

describe('makeEcpayConfig', () => {
  it('沒設定時 fallback 到綠界公開測試金鑰與 stage 網址', () => {
    const cfg = makeEcpayConfig(null)
    expect(cfg.env).toBe('stage')
    expect(cfg.merchantId).toBe('2000132')
    expect(cfg.logisticsMerchantId).toBe('2000933')
    expect(cfg.urls.aio).toContain('payment-stage.ecpay.com.tw')
  })

  it('沒設定時 codMax fallback 到 COD_MAX_DEFAULT', () => {
    expect(makeEcpayConfig(null).codMax).toBe(20000)
  })

  it('env=production 時用正式網址與傳入的金鑰', () => {
    const cfg = makeEcpayConfig({
      env: 'production',
      merchant_id: '3000001', hash_key: 'K1', hash_iv: 'I1',
      logistics_merchant_id: '3000002', logistics_hash_key: 'K2', logistics_hash_iv: 'I2',
      sender_name: '王小明', sender_phone: '0912345678',
    })
    expect(cfg.env).toBe('production')
    expect(cfg.merchantId).toBe('3000001')
    expect(cfg.hashKey).toBe('K1')
    expect(cfg.logisticsHashKey).toBe('K2')
    expect(cfg.senderName).toBe('王小明')
    expect(cfg.urls.aio).toBe('https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5')
    expect(cfg.urls.logisticsCreate).toContain('logistics.ecpay.com.tw')
  })

  it('env 是未知值時當成 stage（避免誤打正式環境）', () => {
    expect(makeEcpayConfig({ env: 'PROD' }).env).toBe('stage')
  })

  // I5：正式環境若讓金鑰留白 fallback 到綠界「公開」測試金鑰，任何人都能自算
  // CheckMacValue 偽造付款成功通知白拿商品——所以 production 一律不 fallback。
  // 但檢查要依用途分組：金流缺就 throw（config 的核心），物流缺只標記不可用
  // （綠界金流與物流分開申請，「只申請金流」是合理狀態，不該連刷卡都被擋）。
  describe('env=production 缺金鑰的處理（絕不 fallback 到公開測試金鑰）', () => {
    const FULL = {
      env: 'production',
      merchant_id: '3000001', hash_key: 'K1', hash_iv: 'I1',
      logistics_merchant_id: '3000002', logistics_hash_key: 'K2', logistics_hash_iv: 'I2',
    }
    const PAYMENT_ONLY = {
      env: 'production',
      merchant_id: '3000001', hash_key: 'K1', hash_iv: 'I1',
    }

    it.each([
      ['merchant_id', '金流特店編號'],
      ['hash_key', '金流 HashKey'],
      ['hash_iv', '金流 HashIV'],
    ])('缺金流的 %s 就 throw，錯誤訊息指出缺哪一欄', (col, label) => {
      expect(() => makeEcpayConfig({ ...FULL, [col]: '' })).toThrow(label)
      expect(() => makeEcpayConfig({ ...FULL, [col]: null })).toThrow(label)
    })

    it('金流三欄全缺時一次列出所有缺漏欄位', () => {
      expect(() => makeEcpayConfig({ env: 'production' })).toThrow(/金流特店編號.*金流 HashIV/)
    })

    it.each([
      ['logistics_merchant_id', '物流特店編號'],
      ['logistics_hash_key', '物流 HashKey'],
      ['logistics_hash_iv', '物流 HashIV'],
    ])('缺物流的 %s 不 throw，但判定為物流不可用', (col, label) => {
      const secrets = { ...FULL, [col]: '' }
      expect(() => makeEcpayConfig(secrets)).not.toThrow()
      const cfg = makeEcpayConfig(secrets)
      expect(cfg.logisticsReady).toBe(false)
      expect(cfg.logisticsMissing).toContain(label)
      expect(logisticsUnavailableMessage(cfg)).toContain(label)
      // 金流那半邊完全不受影響——只申請金流的店照樣能刷卡
      expect(cfg.merchantId).toBe('3000001')
      expect(cfg.hashKey).toBe('K1')
    })

    it('只有金流金鑰：config 建得出來，物流欄位留 null 且標記不可用', () => {
      const cfg = makeEcpayConfig(PAYMENT_ONLY)
      expect(cfg.env).toBe('production')
      expect(cfg.hashKey).toBe('K1')
      expect(cfg.logisticsReady).toBe(false)
      expect(cfg.logisticsMerchantId).toBe(null)
      expect(cfg.logisticsHashKey).toBe(null)
      expect(cfg.logisticsHashIV).toBe(null)
      expect(cfg.logisticsMissing).toEqual(['物流特店編號', '物流 HashKey', '物流 HashIV'])
    })

    it('金鑰齊全就正常組出設定（不 throw），物流可用', () => {
      expect(() => makeEcpayConfig(FULL)).not.toThrow()
      const cfg = makeEcpayConfig(FULL)
      expect(cfg.hashKey).toBe('K1')
      expect(cfg.logisticsReady).toBe(true)
      expect(logisticsUnavailableMessage(cfg)).toBe(null)
    })

    it('production 下絕不會出現公開測試金鑰的值', () => {
      const cfg = makeEcpayConfig(FULL)
      expect(cfg.merchantId).not.toBe('2000132')
      expect(cfg.hashKey).not.toBe('5294y06JbISpM5x9')
      expect(cfg.hashIV).not.toBe('v77hoKGq4kWxNNIS')
      expect(cfg.logisticsMerchantId).not.toBe('2000933')
      expect(cfg.logisticsHashKey).not.toBe('XBERn1YOvpM9nfZc')
      expect(cfg.logisticsHashIV).not.toBe('h1ONHk4P4yqbl5LK')
    })

    it('物流金鑰缺漏時也不會退回公開測試金鑰', () => {
      const cfg = makeEcpayConfig(PAYMENT_ONLY)
      expect(cfg.logisticsMerchantId).not.toBe('2000933')
      expect(cfg.logisticsHashKey).not.toBe('XBERn1YOvpM9nfZc')
      expect(cfg.logisticsHashIV).not.toBe('h1ONHk4P4yqbl5LK')
    })

    it('stage 仍允許 fallback（測試金鑰的正當用途），且物流視為可用', () => {
      const cfg = makeEcpayConfig({ env: 'stage', merchant_id: '2000132' })
      expect(cfg.hashKey).toBe('5294y06JbISpM5x9')
      expect(cfg.logisticsHashKey).toBe('XBERn1YOvpM9nfZc')
      expect(cfg.logisticsReady).toBe(true)
      expect(logisticsUnavailableMessage(cfg)).toBe(null)
    })
  })
})

describe('logisticsUnavailableMessage', () => {
  it('沒有 cfg（該店根本沒設綠界）也回可讀訊息', () => {
    expect(logisticsUnavailableMessage(null)).toContain('尚未設定綠界金鑰')
  })

  it('物流可用時回 null', () => {
    expect(logisticsUnavailableMessage(makeEcpayConfig(null))).toBe(null)
  })
})

describe('genMerchantTradeNo', () => {
  it('長度不超過綠界上限 20 且只有英數', () => {
    const no = genMerchantTradeNo(114, 1786000000000, 'AB')
    expect(no.length).toBeLessThanOrEqual(20)
    expect(no).toMatch(/^[A-Z0-9]+$/)
  })

  it('同一訂單同一秒重複發起也不會撞號（隨機後綴）', () => {
    const a = genMerchantTradeNo(114, 1786000000000, 'AB')
    const b = genMerchantTradeNo(114, 1786000000000, 'CD')
    expect(a).not.toBe(b)
  })

  it('物流單號與金流單號命名空間不同', () => {
    expect(genLogisticsTradeNo(114, 1786000000000, 'AB'))
      .not.toBe(genMerchantTradeNo(114, 1786000000000, 'AB'))
  })
})

describe('logisticsMilestone', () => {
  it('用已知代碼判斷里程碑', () => {
    expect(logisticsMilestone('2073')).toBe('arrived')
    expect(logisticsMilestone('2067')).toBe('picked')
    expect(logisticsMilestone('2074')).toBe('returned')
    expect(logisticsMilestone('3018')).toBe('arrived')
    expect(logisticsMilestone('3022')).toBe('picked')
    expect(logisticsMilestone('3020')).toBe('returned')
  })

  it('未知代碼改用訊息關鍵字後援（涵蓋萊爾富/OK）', () => {
    expect(logisticsMilestone('9999', '消費者取件成功')).toBe('picked')
    expect(logisticsMilestone('9999', '商品已送達門市')).toBe('arrived')
    expect(logisticsMilestone('9999', '逾期未取退回')).toBe('returned')
  })

  it('都對不上時回 null，不要亂猜', () => {
    expect(logisticsMilestone('9999', '系統處理中')).toBe(null)
    expect(logisticsMilestone(null)).toBe(null)
  })
})

// 為什麼要分 source：關鍵字是猜的（萊爾富／OK 沒有官方代碼表）。一則「退貨」通知的訊息
// 只要含「取件成功」字樣就會被判成 picked，貨到付款訂單就會被自動記成已付清——
// 貨退回來了、系統卻認為錢收到了。呼叫端要靠 source 決定「猜的就不要自動動錢」。
describe('logisticsMilestoneDetail', () => {
  it('官方代碼判出來的 source 是 code', () => {
    expect(logisticsMilestoneDetail('2073')).toEqual({ milestone: 'arrived', source: 'code' })
    expect(logisticsMilestoneDetail('2067')).toEqual({ milestone: 'picked', source: 'code' })
    expect(logisticsMilestoneDetail('2074')).toEqual({ milestone: 'returned', source: 'code' })
    expect(logisticsMilestoneDetail('3018')).toEqual({ milestone: 'arrived', source: 'code' })
    expect(logisticsMilestoneDetail('3022')).toEqual({ milestone: 'picked', source: 'code' })
    expect(logisticsMilestoneDetail('3020')).toEqual({ milestone: 'returned', source: 'code' })
  })

  it('關鍵字命中的 source 是 keyword', () => {
    expect(logisticsMilestoneDetail('9999', '消費者取件成功')).toEqual({ milestone: 'picked', source: 'keyword' })
    expect(logisticsMilestoneDetail('9999', '商品已送達門市')).toEqual({ milestone: 'arrived', source: 'keyword' })
    expect(logisticsMilestoneDetail('9999', '逾期未取退回')).toEqual({ milestone: 'returned', source: 'keyword' })
  })

  it('官方代碼優先於關鍵字（代碼說退回、訊息寫取件成功時以代碼為準）', () => {
    expect(logisticsMilestoneDetail('2074', '退貨（原取件成功後退回）'))
      .toEqual({ milestone: 'returned', source: 'code' })
  })

  it('都不中時 milestone 與 source 都是 null', () => {
    expect(logisticsMilestoneDetail('9999', '系統處理中')).toEqual({ milestone: null, source: null })
    expect(logisticsMilestoneDetail(null)).toEqual({ milestone: null, source: null })
  })
})

describe('parseLogisticsResponse', () => {
  it('成功回應解析成參數物件', () => {
    const r = parseLogisticsResponse('1|AllPayLogisticsID=123&CVSPaymentNo=ABC&RtnCode=300')
    expect(r.ok).toBe(true)
    expect(r.params.AllPayLogisticsID).toBe('123')
    expect(r.params.CVSPaymentNo).toBe('ABC')
  })

  it('失敗回應帶出錯誤訊息', () => {
    const r = parseLogisticsResponse('0|MerchantID Error')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('MerchantID Error')
  })
})

describe('buildAutoSubmitForm', () => {
  it('把參數轉成 hidden input 並指向 action', () => {
    const html = buildAutoSubmitForm('https://x.test/pay', { A: '1', B: 'x' })
    expect(html).toContain('action="https://x.test/pay"')
    expect(html).toContain('name="A" value="1"')
    expect(html).toContain('name="B" value="x"')
  })

  it('跳脫引號，避免參數值破壞表單', () => {
    const html = buildAutoSubmitForm('https://x.test/pay', { A: '"><script>alert(1)</script>' })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&quot;')
  })

  it('略過 undefined/null 參數', () => {
    const html = buildAutoSubmitForm('https://x.test/pay', { A: '1', B: undefined, C: null })
    expect(html).not.toContain('name="B"')
    expect(html).not.toContain('name="C"')
  })
})

describe('getPrintUrl', () => {
  it('四大 C2C 各自有列印網址', () => {
    const cfg = makeEcpayConfig(null)
    for (const s of CVS_SUBTYPES) {
      expect(getPrintUrl(s, cfg)).toContain('logistics-stage.ecpay.com.tw')
    }
    expect(getPrintUrl('UNIMARTC2C', cfg)).toContain('PrintUniMartC2COrderInfo')
  })

  it('不支援的類型回 null', () => {
    expect(getPrintUrl('HOME', makeEcpayConfig(null))).toBe(null)
  })
})
