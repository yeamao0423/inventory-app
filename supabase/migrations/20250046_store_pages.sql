-- ============================================================
-- 店家自訂靜態頁（服務條款 / FAQ / 隱私權 / 任意自訂頁）
--   * 每家店自己一份（多租戶）：靠 (store_id, slug) 唯一
--   * body 是「顯示用 Markdown」，為唯一真實來源（商城只渲染 body）
--   * template 模式另存 template_key + vars，讓後台可回頭重編表單；
--     custom 模式則直接編輯 body
--   * 商城以 anon 讀取，RLS 只露出 is_published = true 的頁
-- 前置：多租戶 Phase 3（20250020）的 helper 函式
--       is_store_member / has_store_role / is_platform_admin
-- ============================================================

create table if not exists public.store_pages (
  id           bigserial primary key,
  store_id     bigint not null references public.stores(id) on delete cascade,
  slug         text not null,                          -- 'terms' | 'privacy' | 'faq' | 自訂
  title        text not null default '',
  mode         text not null default 'template',       -- 'template' | 'custom'
  template_key text,                                    -- template 模式：對應 legalTemplates
  vars         jsonb not null default '{}'::jsonb,      -- template 模式的變數值
  body         text not null default '',                -- 顯示用 Markdown（唯一真實來源）
  is_published boolean not null default false,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (store_id, slug)
);

-- 商城列頁/取單頁用：同店、已發佈、依排序
create index if not exists store_pages_store_pub_idx
  on public.store_pages (store_id, is_published, sort_order);

alter table public.store_pages enable row level security;

-- ── 商城（anon）：只讀已發佈 ──
drop policy if exists "public read published store_pages" on public.store_pages;
create policy "public read published store_pages"
  on public.store_pages
  for select to anon
  using (is_published = true);

-- ── 後台（authenticated）：店家成員可讀全部（含草稿），非成員只看得到已發佈 ──
drop policy if exists "member read store_pages" on public.store_pages;
create policy "member read store_pages"
  on public.store_pages
  for select to authenticated
  using (is_published = true or public.is_store_member(store_id) or public.is_platform_admin());

-- ── 寫入：店主 / 管理員（或平台方）──
drop policy if exists "owner manage store_pages" on public.store_pages;
create policy "owner manage store_pages"
  on public.store_pages
  for all to authenticated
  using (public.has_store_role(store_id, ARRAY['super_admin','admin']) or public.is_platform_admin())
  with check (public.has_store_role(store_id, ARRAY['super_admin','admin']) or public.is_platform_admin());
