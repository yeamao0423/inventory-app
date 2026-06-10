-- ══════════════════════════════════════════════
-- 訂單履約流程 — Schema 擴充
-- 對應 IMPLEMENTATION_PLAN.md 修改二
-- ══════════════════════════════════════════════

-- consumer_orders 新增運費與履約類型欄位
-- 注意：item 層級的狀態（active / cancelled）直接存在 items_json 內的每個物件，
-- 不另外建欄位
ALTER TABLE consumer_orders
  ADD COLUMN IF NOT EXISTS shipping_fee integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fulfillment_type text;

-- fulfillment_type 可選值：
--   'full'      - 全數出貨
--   'partial'   - 部分出貨 + 部分取消
--   'cancelled' - 全數取消
-- 僅在訂單狀態切換至「已出貨」或「已取消」時由後台寫入，
-- 供通知 Email API 判斷模板用
