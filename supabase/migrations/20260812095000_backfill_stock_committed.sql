-- ══════════════════════════════════════════════════════════════
-- 回填既有訂單的 stock_committed
--
-- 為什麼需要這支：20260812100000 加了 stock_committed 欄位與 reconcile_stock trigger，
-- 但沒有回填既有訂單——它們的值是 '{}'，等於向 trigger 宣稱「這張單從沒佔用過庫存」。
-- 後果是任何一次狀態變更（處理中→已購買→已出貨→完成，日常操作）都會讓 trigger
-- 算出正的差額而「補扣」一次。實測：一張已完成的舊訂單只是把狀態改成「已購買」，
-- 規格庫存就從 1 掉到 0。remote 上有 39 張還在流程中的訂單會踩到，92 張非取消訂單
-- 只要被編輯也一樣。
--
-- 回填規則＝**trigger 自己會算出的目標**（見 reconcile_order_stock 的「1) 目標佔用量」）：
--   已取消的訂單 → 空（目標為 0）
--   其餘 → 所有未被標記 cancelled 的品項，鍵為 "productId:variantId"
--
-- 為什麼用 trigger 的目標，而不是「舊模型實際扣過的量」：
--   舊模型的實際佔用是「非 isCollection 且鍵存在的品項」（預購／限時被 place_order
--   跳過、後台自建單根本沒經過 place_order），與 trigger 的目標差了那些從沒扣過的品項。
--   照實際佔用回填的話，那些品項會在未來某人碰到訂單時被補扣成負庫存——本機實測
--   全量收斂是 35 個品項、-44 件。那個補扣在帳上說得通（新模型用負數表示欠客人幾件），
--   但它建立在一個無法從資料判斷的前提：店家這段期間有沒有實際盤點過、把數字調對了。
--   若調過，再扣一次就是低估。這正是設計文件決定「不做舊資料校正」的理由。
--
--   所以這裡選擇完全中性：套用當下零變動，之後任何操作也零漂移。
--   代價是設計文件已經記載並接受的——採購彙整看不到舊的預購需求，
--   切換前用 scripts/export-uncommitted-demand.mjs 留底。
--
-- 已知的殘留邊界：既有預購訂單日後若被取消，trigger 會「還回」它從沒扣過的庫存。
--   影響範圍是切換當下仍未完成的預購訂單（留底檔看得到是哪幾張），數量小且可控。
--
-- 只處理 stock_committed 仍為 '{}' 的列：trigger 上線後建立的訂單已經有正確值。
-- ══════════════════════════════════════════════════════════════

-- 先把欄位建起來（20260812100000 也有同一句、IF NOT EXISTS 可重複執行）。
-- 這支刻意排在 trigger 之前：回填完成時 reconcile_stock 還不存在，
-- 所以連「加了 trigger 但還沒回填」的空窗都不會出現。
ALTER TABLE public.consumer_orders
  ADD COLUMN IF NOT EXISTS stock_committed jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE public.consumer_orders co
   SET stock_committed = agg.committed
  FROM (
        SELECT c.id,
               jsonb_object_agg(x.k, x.q) AS committed
          FROM public.consumer_orders c
          CROSS JOIN LATERAL (
                SELECT (it->>'id')
                         || ':'
                         || COALESCE(NULLIF(it->>'variantId', ''), '') AS k,
                       SUM((it->>'qty')::integer)                      AS q
                  FROM jsonb_array_elements(COALESCE(c.items_json, '[]'::jsonb)) it
                 -- 與 reconcile_order_stock 的目標計算逐條對齊
                 WHERE COALESCE(it->>'status', 'active') <> 'cancelled'
                   AND COALESCE(it->>'id', '')  ~ '^-?[0-9]+$'
                   AND COALESCE(it->>'qty', '') ~ '^[0-9]+$'
                   AND (it->>'qty')::integer > 0
                   AND (COALESCE(NULLIF(it->>'variantId', ''), '') = ''
                        OR (it->>'variantId') ~ '^-?[0-9]+$')
                 GROUP BY 1
               ) x
         WHERE c.stock_committed = '{}'::jsonb
           AND COALESCE(c.status, '') <> '已取消'   -- 已取消的目標為 0，留空即中性
         GROUP BY c.id
       ) agg
 WHERE co.id = agg.id
   AND co.stock_committed = '{}'::jsonb;

-- 這支 UPDATE 不會觸發 reconcile_stock：trigger 掛在
-- AFTER INSERT OR DELETE OR UPDATE OF items_json, status，只監看那兩欄，
-- stock_committed 自己被改不在監看範圍內。
