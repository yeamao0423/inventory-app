-- ══════════════════════════════════════════════
-- 行程訂單歸屬
--
-- 問題：行程報表的訂單來源完全是日期區間（TripsPage 的 depart_date ~ return_date），
--       區間內只要不是「已取消」就一律算進拆帳。但區間內可能混進其他行程的單
--       （兩趟時間重疊），也可能有根本不屬於任何行程的常規訂單。
--       使用者沒有任何辦法把它們踢出去。
--
-- 做法：區間降級成「預設建議」，人工覆寫存在訂單上。
--
--   trip_id = NULL, trip_excluded = false  → 沒人管過，落在誰的區間就算誰的
--                                            （既有訂單全是這狀態，行為不變）
--   trip_id = NULL, trip_excluded = true   → 人工標記為常規訂單，不進任何行程
--   trip_id = X                            → 人工釘在 X 趟，區間不符也算 X 趟的
--
-- 第三種狀態是給「兩趟區間重疊」用的：在 A 趟勾掉會標成常規訂單，
-- 到 B 趟的清單勾回來就寫 trip_id = B，A 趟自動排除、B 趟納入。搬單即完成。
--
-- 行程刪除時用 SET NULL 而不是 CASCADE —— 訂單本身跟行程無關，
-- 不能因為行程被刪掉就跟著消失。
-- ══════════════════════════════════════════════

BEGIN;

ALTER TABLE consumer_orders
  ADD COLUMN IF NOT EXISTS trip_id       bigint REFERENCES trips(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS trip_excluded boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN consumer_orders.trip_id IS
  '人工釘住的行程。非 NULL 時無視日期區間，只算這趟。';
COMMENT ON COLUMN consumer_orders.trip_excluded IS
  'true = 人工標記為常規訂單，不屬於任何行程。只在 trip_id 為 NULL 時有意義。';

CREATE INDEX IF NOT EXISTS idx_consumer_orders_trip
  ON consumer_orders(trip_id) WHERE trip_id IS NOT NULL;

COMMIT;
