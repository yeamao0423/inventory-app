-- ============================================================
-- 補丁：procurement 表加入 store_id
-- ============================================================

BEGIN;

-- procurement_members 加 store_id
ALTER TABLE procurement_members
ADD COLUMN IF NOT EXISTS store_id bigint DEFAULT 1 REFERENCES stores(id) ON DELETE CASCADE;

-- procurement_batches 加 store_id
ALTER TABLE procurement_batches
ADD COLUMN IF NOT EXISTS store_id bigint DEFAULT 1 REFERENCES stores(id) ON DELETE CASCADE;

COMMIT;
