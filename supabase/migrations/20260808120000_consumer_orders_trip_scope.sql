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
-- 判定優先序（唯一實作在 src/lib/tripScope.js 的 isOrderInTrip）：
--
--   trip_excluded = true   → 人工勾掉，優先於一切，不進任何行程
--   trip_excluded = false  且 trip_id = X     → 人工釘在 X 趟，區間不符也算 X 趟的
--   trip_excluded = false  且 trip_id = NULL  → 沒人管過，落在誰的區間就算誰的
--                                               （既有訂單全是這狀態，行為不變）
--
-- trip_excluded 優先於 trip_id，而且勾掉時「不清空 trip_id」。
-- 原因：行程報表的候撈範圍是「日期區間內 ∪ trip_id = 本趟」，一旦勾掉時把
-- trip_id 也清成 NULL，一張 created_at 落在區間外、只靠 trip_id 被撈進來的單
-- 會同時離開兩個集合 → 從清單上永遠消失，沒有任何入口可以把它勾回來。
-- 保留 trip_id 等於保留「曾經釘進哪一趟」的痕跡，讓它還撈得回清單。
--
-- 搬單（兩趟區間重疊）：在 A 趟勾掉 → trip_excluded = true；到 B 趟的清單勾回來
-- 就寫 trip_id = B、trip_excluded = false，A 趟自動排除、B 趟納入。
--
-- 行程刪除時用 SET NULL 而不是 CASCADE —— 訂單本身跟行程無關，
-- 不能因為行程被刪掉就跟著消失。
-- ══════════════════════════════════════════════

BEGIN;

ALTER TABLE consumer_orders
  ADD COLUMN IF NOT EXISTS trip_id       bigint REFERENCES trips(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS trip_excluded boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN consumer_orders.trip_id IS
  '人工釘住的行程。trip_excluded = false 時無視日期區間，只算這趟；'
  '被勾掉（trip_excluded = true）也不清空，痕跡留著讓這張單還撈得回該趟清單。';
COMMENT ON COLUMN consumer_orders.trip_excluded IS
  'true = 人工勾掉，不屬於任何行程。優先於 trip_id：兩者同時存在時以此為準。';

CREATE INDEX IF NOT EXISTS idx_consumer_orders_trip
  ON consumer_orders(trip_id) WHERE trip_id IS NOT NULL;

COMMIT;
