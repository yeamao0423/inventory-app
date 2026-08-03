-- ============================================================
-- 組合商品（Bundle）— 社群導購「一次買一套」
--   * 組合**不是商品**：不進庫存、不成為訂單品項（見 docs/adr/0004）
--     訂單品項仍是各件商品，套裝價與原價加總的差額寫進 consumer_orders.discount_amount
--   * 每家店自己一份（多租戶）：靠 (store_id, slug) 唯一
--   * 落地頁簡化版：hero_image_url 一張主圖 + description 一段純文字
--   * 商城以 anon 讀取，RLS 只露出 is_published = true 的組合
-- RLS 寫法完全比照 store_pages（20250046）
-- 前置：多租戶 Phase 3（20250020）的 helper 函式
--       is_store_member / has_store_role / is_platform_admin
-- ============================================================

create table if not exists public.bundles (
  id            bigserial primary key,
  store_id      bigint not null references public.stores(id) on delete cascade,
  name          text not null default '',
  slug          text not null,                        -- 網址裝飾段的正規值（解析仍以 id 為準）
  bundle_price  numeric(10,2) not null default 0,     -- 一口價；差額由系統反推
  hero_image_url text,
  description   text not null default '',
  is_published  boolean not null default false,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (store_id, slug)
);

-- 後台列表 / 商城列頁用：同店、已發佈、依排序
create index if not exists bundles_store_pub_idx
  on public.bundles (store_id, is_published, sort_order);

drop trigger if exists bundles_updated_at on public.bundles;
create trigger bundles_updated_at before update on public.bundles
  for each row execute function public.update_updated_at();

create table if not exists public.bundle_items (
  id         bigserial primary key,
  bundle_id  bigint not null references public.bundles(id) on delete cascade,
  product_id bigint not null references public.products(id) on delete cascade,
  sort_order integer not null default 0,
  -- 刻意不指定變體：消費者在落地頁自己選規格
  unique (bundle_id, product_id)
);

create index if not exists bundle_items_bundle_idx
  on public.bundle_items (bundle_id, sort_order);

alter table public.bundles enable row level security;
alter table public.bundle_items enable row level security;

-- ── 商城（anon）：只讀已發佈 ──
drop policy if exists "public read published bundles" on public.bundles;
create policy "public read published bundles"
  on public.bundles
  for select to anon
  using (is_published = true);

-- ── 後台（authenticated）：店家成員可讀全部（含草稿），非成員只看得到已發佈 ──
drop policy if exists "member read bundles" on public.bundles;
create policy "member read bundles"
  on public.bundles
  for select to authenticated
  using (is_published = true or public.is_store_member(store_id) or public.is_platform_admin());

-- ── 寫入：店主 / 管理員（或平台方）──
drop policy if exists "owner manage bundles" on public.bundles;
create policy "owner manage bundles"
  on public.bundles
  for all to authenticated
  using (public.has_store_role(store_id, ARRAY['super_admin','admin']) or public.is_platform_admin())
  with check (public.has_store_role(store_id, ARRAY['super_admin','admin']) or public.is_platform_admin());

-- ── bundle_items：能不能看到／改動，一律由所屬組合決定 ──
drop policy if exists "public read published bundle_items" on public.bundle_items;
create policy "public read published bundle_items"
  on public.bundle_items
  for select to anon
  using (exists (
    select 1 from public.bundles b
    where b.id = bundle_id and b.is_published = true
  ));

drop policy if exists "member read bundle_items" on public.bundle_items;
create policy "member read bundle_items"
  on public.bundle_items
  for select to authenticated
  using (exists (
    select 1 from public.bundles b
    where b.id = bundle_id
      and (b.is_published = true or public.is_store_member(b.store_id) or public.is_platform_admin())
  ));

drop policy if exists "owner manage bundle_items" on public.bundle_items;
create policy "owner manage bundle_items"
  on public.bundle_items
  for all to authenticated
  using (exists (
    select 1 from public.bundles b
    where b.id = bundle_id
      and (public.has_store_role(b.store_id, ARRAY['super_admin','admin']) or public.is_platform_admin())
  ))
  with check (exists (
    select 1 from public.bundles b
    where b.id = bundle_id
      and (public.has_store_role(b.store_id, ARRAY['super_admin','admin']) or public.is_platform_admin())
  ));
