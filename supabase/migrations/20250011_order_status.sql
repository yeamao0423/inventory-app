-- Migration: 自建訂單加入 status 欄位（軟刪除/狀態管理）
-- 對齊商城訂單的取消機制，不做硬刪除

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT '處理中';

ALTER TABLE orders
  ADD CONSTRAINT orders_status_check
  CHECK (status IN ('處理中', '完成', '已取消'));
