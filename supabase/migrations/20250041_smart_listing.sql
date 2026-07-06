-- ============================================================
-- 智慧上架（AI 補齊）：
--   (A) ai_usage_log 用量紀錄表（限流＋保留率抽樣）
--   (B) products.ai_log_id 關聯欄位（哪些商品用過 AI）
-- ============================================================

-- (A) 每次呼叫 smart-listing Edge Function 記一筆；
--     只有後端（service role）讀寫，比照 line_rate_log：RLS enable、無 policy
create table if not exists public.ai_usage_log (
  id         bigserial primary key,
  store_id   bigint not null references public.stores(id) on delete cascade,
  model      text not null,
  ai_output  jsonb,                -- AI 原始 JSON，供草稿保留率抽樣
  created_at timestamptz not null default now()
);
create index if not exists ai_usage_log_store_time_idx on public.ai_usage_log (store_id, created_at);
alter table public.ai_usage_log enable row level security;

-- (B) 商品建立時帶入最後一次 AI 補齊的 log id；純手動上架為 null
alter table public.products
  add column if not exists ai_log_id bigint references public.ai_usage_log(id) on delete set null;
