-- ══════════════════════════════════════════════
-- 進貨批次掛行程
--
-- 讓「進貨」批次（手動建立、不依賴顧客訂單需求）可以選擇性掛到某趟行程下，
-- 使行程總覽能呈現「本趟進貨成本」。純顯示用途，不影響淨利計算。
-- ══════════════════════════════════════════════

alter table procurement_batches
  add column trip_id bigint references trips(id) on delete set null;

create index idx_procurement_batches_trip_id on procurement_batches(trip_id);
