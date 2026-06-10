-- ══════════════════════════════════════════════
-- 行程管理 — trips + trip_expenses
-- 在 Supabase Dashboard > SQL Editor 執行此檔案
-- ══════════════════════════════════════════════

-- 1. 行程主表
create table if not exists trips (
  id           bigserial primary key,
  destination  text not null,
  depart_date  date not null,
  return_date  date not null,
  note         text,
  created_at   timestamptz default now()
);

-- 2. 行程費用明細
create table if not exists trip_expenses (
  id           bigserial primary key,
  trip_id      bigint not null references trips(id) on delete cascade,
  category     text not null
               check (category in ('flight', 'hotel', 'transport', 'luggage', 'other')),
  label        text not null,
  amount       numeric(10,2) not null default 0,
  note         text,
  created_at   timestamptz default now()
);

-- 3. RLS 政策（僅認證使用者可存取）
alter table trips enable row level security;
alter table trip_expenses enable row level security;

create policy "Authenticated users can manage trips"
  on trips for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

create policy "Authenticated users can manage trip_expenses"
  on trip_expenses for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');
