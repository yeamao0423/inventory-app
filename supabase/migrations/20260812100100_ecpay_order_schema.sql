-- 綠界訂單端 schema
-- 註：payment_method / shipping_subtype / cvs_* 五欄已由 20260709053821 補過，這裡不重複加。

-- ========== 1) consumer_orders 補欄位 ==========
alter table public.consumer_orders
  -- 需要店家人工處理的付款異常（例如已付款但庫存不足無法補回）
  add column if not exists payment_alert            text,
  -- 物流單（Express/Create 後回填）
  add column if not exists ecpay_logistics_trade_no text,
  add column if not exists allpay_logistics_id      text,
  add column if not exists cvs_payment_no           text,
  add column if not exists cvs_validation_no        text,
  add column if not exists logistics_status         text,
  add column if not exists logistics_status_msg     text,
  add column if not exists logistics_status_at      timestamptz;

comment on column public.consumer_orders.payment_alert is
  '付款異常待人工處理的說明；null 表示正常。後台訂單詳情會顯示。';

create index if not exists consumer_orders_allpay_logistics_id_idx
  on public.consumer_orders(allpay_logistics_id);

-- 庫存釋放的冪等由 20260812100000 的 reconcile_order_stock() trigger 以 stock_committed 差額保證，
-- 不需要額外旗標。此欄位曾短暫存在於本機，一併移除避免誤用。
alter table public.consumer_orders drop column if exists stock_released_at;

-- ========== 2) ecpay_transactions：一次付款嘗試一列 ==========
-- 一張訂單可以有多筆（棄單後重付、加購後補差額），金額累加進 consumer_orders.paid_amount。
create table if not exists public.ecpay_transactions (
  id           bigint generated always as identity primary key,
  order_id     bigint not null references public.consumer_orders(id) on delete cascade,
  store_id     bigint not null references public.stores(id),
  trade_no     text not null unique,          -- 綠界 MerchantTradeNo，冪等鍵
  amount       numeric not null,
  status       text not null default 'pending', -- 'pending' | 'paid' | 'failed'
  payment_type text,                          -- 綠界回傳的實際付款方式
  paid_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists ecpay_transactions_order_id_idx on public.ecpay_transactions(order_id);

alter table public.ecpay_transactions enable row level security;
-- 消費者不需要讀這張表（訂單頁只看 consumer_orders）；後台走 service role 或另開 policy。
revoke all on public.ecpay_transactions from anon, authenticated;

-- ========== 3) ecpay_payment_logs：綠界原始通知留底 ==========
-- 驗章失敗也要留（對帳與查弊都靠它）。
create table if not exists public.ecpay_payment_logs (
  id         bigint generated always as identity primary key,
  order_id   bigint references public.consumer_orders(id) on delete set null,
  source     text not null,   -- 'payment_notify' | 'payment_result' | 'logistics_create' | 'logistics_reply' | 'map_reply'
  trade_no   text,
  rtn_code   text,
  rtn_msg    text,
  mac_valid  boolean,
  raw        jsonb,
  created_at timestamptz not null default now()
);
create index if not exists ecpay_payment_logs_order_id_idx on public.ecpay_payment_logs(order_id);
create index if not exists ecpay_payment_logs_trade_no_idx on public.ecpay_payment_logs(trade_no);

alter table public.ecpay_payment_logs enable row level security;
revoke all on public.ecpay_payment_logs from anon, authenticated;
