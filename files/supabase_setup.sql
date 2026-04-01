-- ══════════════════════════════════════════════
-- 庫存管理 App — Supabase 資料庫初始化腳本
-- 在 Supabase Dashboard > SQL Editor 執行此檔案
-- ══════════════════════════════════════════════

-- 1. 使用者個人資料（含角色）
create table if not exists profiles (
  id         uuid references auth.users on delete cascade primary key,
  name       text not null,
  role       text not null default 'viewer'
             check (role in ('admin', 'editor', 'viewer')),
  created_at timestamptz default now()
);

-- 新使用者自動建立 profile（預設 viewer）
create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, name, role)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', new.email), 'viewer');
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();


-- 2. 商品庫存
create table if not exists products (
  id         bigserial primary key,
  name       text not null,
  sku        text not null unique,
  quantity   integer not null default 0,
  unit       text not null default '個',
  cost       numeric(10,2) default 0,
  currency   text default 'TWD',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 庫存異動時自動更新 updated_at
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists products_updated_at on products;
create trigger products_updated_at
  before update on products
  for each row execute procedure update_updated_at();


-- 3. 庫存異動紀錄
create table if not exists history (
  id         bigserial primary key,
  sku        text not null,
  change     integer not null,
  reason     text,
  created_at timestamptz default now()
);


-- 4. 訂單
create table if not exists orders (
  id             bigserial primary key,
  customer       text not null,
  items          text not null,
  total_amount   numeric(10,2),
  deposit        numeric(10,2) default 0,
  payment_status text not null default '未付'
                 check (payment_status in ('未付', '已付訂金', '已付清')),
  note           text,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

drop trigger if exists orders_updated_at on orders;
create trigger orders_updated_at
  before update on orders
  for each row execute procedure update_updated_at();


-- 5. 匯率
create table if not exists exchange_rates (
  currency   text primary key,
  rate       numeric(10,4) not null,
  updated_at timestamptz default now()
);

-- 預設匯率（可在 App 內修改）
insert into exchange_rates (currency, rate) values
  ('USD', 32.5),
  ('JPY', 0.218),
  ('EUR', 35.2)
on conflict (currency) do nothing;


-- ══════════════════════════════════════════════
-- Row Level Security（RLS）—— 角色權限控制
-- ══════════════════════════════════════════════

alter table profiles       enable row level security;
alter table products       enable row level security;
alter table history        enable row level security;
alter table orders         enable row level security;
alter table exchange_rates enable row level security;

-- profiles：本人可讀自己；admin 可讀全部
create policy "users read own profile" on profiles
  for select using (auth.uid() = id);

create policy "admin read all profiles" on profiles
  for select using (
    exists (select 1 from profiles where id = auth.uid() and role = 'admin')
  );

-- products：所有登入者可讀；editor + admin 可寫
create policy "auth read products" on products
  for select using (auth.role() = 'authenticated');

create policy "editor insert products" on products
  for insert with check (
    exists (select 1 from profiles where id = auth.uid() and role in ('admin','editor'))
  );

create policy "editor update products" on products
  for update using (
    exists (select 1 from profiles where id = auth.uid() and role in ('admin','editor'))
  );

create policy "admin delete products" on products
  for delete using (
    exists (select 1 from profiles where id = auth.uid() and role = 'admin')
  );

-- history：所有登入者可讀寫
create policy "auth read history" on history
  for select using (auth.role() = 'authenticated');

create policy "auth insert history" on history
  for insert with check (auth.role() = 'authenticated');

-- orders：所有登入者可讀；editor + admin 可寫
create policy "auth read orders" on orders
  for select using (auth.role() = 'authenticated');

create policy "editor write orders" on orders
  for insert with check (
    exists (select 1 from profiles where id = auth.uid() and role in ('admin','editor'))
  );

create policy "editor update orders" on orders
  for update using (
    exists (select 1 from profiles where id = auth.uid() and role in ('admin','editor'))
  );

-- exchange_rates：所有人可讀；admin 可寫
create policy "auth read rates" on exchange_rates
  for select using (auth.role() = 'authenticated');

create policy "admin write rates" on exchange_rates
  for all using (
    exists (select 1 from profiles where id = auth.uid() and role = 'admin')
  );
