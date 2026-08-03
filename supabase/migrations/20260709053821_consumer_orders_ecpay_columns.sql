-- ⚠️ 從 remote 追蹤表撈回存檔（2026-08-04），不是在這裡寫完才上去的。
-- 完整緣由見 20260702164417_line_search_products_fuzzy.sql 的檔頭。
-- 內容與 remote 上實際跑過的一字不差，請勿順手整理。
--
-- 這五支裡唯一動 schema（而非只定義函式）的一支。原始註解自稱「20250047」，
-- 但 repo 的 20250047 是 category_parent —— 那個編號與 repo 對不上，保留原樣不修。
--
-- 這幾個欄位服務的綠界串接主體還在 feature/ecpay-integration 分支上沒合併
-- （見 docs/TODO.md）；也就是說 remote 有欄位、main 沒有寫它們的程式碼。

-- 20250047: consumer_orders 補 ECPay 付款/物流欄位（remote 補課）
ALTER TABLE public.consumer_orders
  ADD COLUMN IF NOT EXISTS payment_method  text NOT NULL DEFAULT 'remittance',
  ADD COLUMN IF NOT EXISTS shipping_subtype text,
  ADD COLUMN IF NOT EXISTS cvs_store_id    text,
  ADD COLUMN IF NOT EXISTS cvs_store_name  text,
  ADD COLUMN IF NOT EXISTS cvs_address     text;
