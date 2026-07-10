-- 20250047: consumer_orders 補 ECPay 付款/物流欄位（remote 補課）
--
-- 背景：ECPay 開發期間這 5 個欄位是直接加在 local DB 的，repo 沒有對應
--       migration，remote 也從未套用。migration 20250036 的 place_order
--       （22 參數版）INSERT 會寫入這些欄位，套用前必須先補齊。
--       欄位皆 nullable / 有預設值，對既有資料與 17 參數呼叫完全無影響。
--
-- 套用順序：本檔 → 20250036（place_order 22 參數版 + public_token）。

ALTER TABLE public.consumer_orders
  ADD COLUMN IF NOT EXISTS payment_method  text NOT NULL DEFAULT 'remittance',
  ADD COLUMN IF NOT EXISTS shipping_subtype text,
  ADD COLUMN IF NOT EXISTS cvs_store_id    text,
  ADD COLUMN IF NOT EXISTS cvs_store_name  text,
  ADD COLUMN IF NOT EXISTS cvs_address     text;
