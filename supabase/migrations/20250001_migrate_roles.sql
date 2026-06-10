-- ══════════════════════════════════════════════
-- 角色系統升級 Migration
-- 執行環境：Supabase Studio > SQL Editor
-- ══════════════════════════════════════════════


-- ── Step 1：移除依賴 profiles.role 的 RLS policies ──

drop policy if exists "users read own profile"       on profiles;
drop policy if exists "admin read all profiles"      on profiles;
drop policy if exists "admin update profiles"        on profiles;

drop policy if exists "auth read products"           on products;
drop policy if exists "editor insert products"       on products;
drop policy if exists "editor update products"       on products;
drop policy if exists "admin delete products"        on products;

drop policy if exists "auth read history"            on history;
drop policy if exists "auth insert history"          on history;

drop policy if exists "auth read orders"             on orders;
drop policy if exists "editor write orders"          on orders;
drop policy if exists "editor update orders"         on orders;

drop policy if exists "auth read rates"              on exchange_rates;
drop policy if exists "admin write rates"            on exchange_rates;


-- ── Step 2：修改 profiles（移除 role、加入 email）──

alter table profiles add column if not exists email text;
alter table profiles drop column if exists role;


-- ── Step 3：建立 stores table ──

create table if not exists stores (
  id         bigserial primary key,
  name       text not null,
  created_at timestamptz default now()
);

insert into stores (id, name) values (1, '預設店家')
  on conflict (id) do nothing;


-- ── Step 4：建立 user_store_roles table ──

create table if not exists user_store_roles (
  id         bigserial primary key,
  user_id    uuid references auth.users on delete cascade not null,
  store_id   bigint references stores on delete cascade not null default 1,
  role       text not null default 'viewer'
             check (role in ('super_admin', 'admin', 'editor', 'viewer')),
  created_at timestamptz default now(),
  unique (user_id, store_id)
);


-- ── Step 5：更新 trigger ──

create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', new.email),
    new.email
  )
  on conflict (id) do nothing;

  insert into public.user_store_roles (user_id, store_id, role)
  values (new.id, 1, 'viewer')
  on conflict (user_id, store_id) do nothing;

  return new;
end;
$$;


-- ── Step 6：RLS 暫時開放（功能優先，安全性之後再補）──

-- profiles
alter table profiles enable row level security;
drop policy if exists "allow all authenticated profiles" on profiles;
create policy "allow all authenticated profiles" on profiles
  for all using (auth.role() = 'authenticated');

-- stores
alter table stores enable row level security;
drop policy if exists "allow all authenticated stores" on stores;
create policy "allow all authenticated stores" on stores
  for all using (auth.role() = 'authenticated');

-- user_store_roles
alter table user_store_roles enable row level security;
drop policy if exists "allow all authenticated user_store_roles" on user_store_roles;
create policy "allow all authenticated user_store_roles" on user_store_roles
  for all using (auth.role() = 'authenticated');

-- products
alter table products enable row level security;
drop policy if exists "allow all authenticated products" on products;
create policy "allow all authenticated products" on products
  for all using (auth.role() = 'authenticated');

-- history
alter table history enable row level security;
drop policy if exists "allow all authenticated history" on history;
create policy "allow all authenticated history" on history
  for all using (auth.role() = 'authenticated');

-- orders
alter table orders enable row level security;
drop policy if exists "allow all authenticated orders" on orders;
create policy "allow all authenticated orders" on orders
  for all using (auth.role() = 'authenticated');

-- exchange_rates
alter table exchange_rates enable row level security;
drop policy if exists "allow all authenticated exchange_rates" on exchange_rates;
create policy "allow all authenticated exchange_rates" on exchange_rates
  for all using (auth.role() = 'authenticated');


-- ══════════════════════════════════════════════
-- 補充指令（Migration 後執行）
-- ══════════════════════════════════════════════

-- ── Backfill：既有使用者補上 viewer ──
insert into user_store_roles (user_id, store_id, role)
select id, 1, 'viewer'
from auth.users
where id not in (
  select user_id from user_store_roles where store_id = 1
)
on conflict (user_id, store_id) do nothing;


-- ── 手動設定指定使用者為 super_admin ──
-- 步驟 1：查詢所有使用者的 id 與 email
-- select id, email from auth.users;

-- 步驟 2：將目標使用者升為 super_admin（把下方的 YOUR_USER_ID 換成實際 id）
-- update user_store_roles
-- set role = 'super_admin'
-- where user_id = 'YOUR_USER_ID'
--   and store_id = 1;
