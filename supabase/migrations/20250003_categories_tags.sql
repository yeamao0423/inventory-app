-- ============================================================
-- Migration: 商品分類 & 標籤系統
-- ============================================================

-- 1. 分類表
create table if not exists categories (
  id         bigserial primary key,
  name       text not null unique,
  name_en    text,
  sort_order integer default 0,
  created_at timestamptz default now()
);
alter table categories enable row level security;
create policy "public read categories"  on categories for select using (true);
create policy "auth write categories"   on categories for all    using (auth.role() = 'authenticated');
grant select on categories to anon;
grant all    on categories to authenticated;
grant usage, select on sequence categories_id_seq to authenticated;

-- 2. products 加上 category_id
alter table products add column if not exists category_id bigint references categories(id) on delete set null;

-- 3. 標籤表
create table if not exists tags (
  id         bigserial primary key,
  name       text not null unique,
  name_en    text,
  sort_order integer default 0,
  created_at timestamptz default now()
);
alter table tags enable row level security;
create policy "public read tags"  on tags for select using (true);
create policy "auth write tags"   on tags for all    using (auth.role() = 'authenticated');
grant select on tags to anon;
grant all    on tags to authenticated;
grant usage, select on sequence tags_id_seq to authenticated;

-- 4. 商品 ↔ 標籤 多對多
create table if not exists product_tags (
  product_id bigint references products(id) on delete cascade,
  tag_id     bigint references tags(id)     on delete cascade,
  primary key (product_id, tag_id)
);
alter table product_tags enable row level security;
create policy "public read product_tags" on product_tags for select using (true);
create policy "auth write product_tags"  on product_tags for all    using (auth.role() = 'authenticated');
grant select on product_tags to anon;
grant all    on product_tags to authenticated;
