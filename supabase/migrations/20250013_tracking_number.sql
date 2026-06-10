-- 新增物流追蹤單號欄位
ALTER TABLE consumer_orders ADD COLUMN IF NOT EXISTS tracking_number TEXT;
