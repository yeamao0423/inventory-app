-- ============================================================
-- LINE 智慧客服 Phase 1 補強：
--   (A) 限流用 log 表  (B) 搜尋只回已上架  (C) 庫存帶出預購旗標
-- ============================================================

-- (A) 限流計數表：每則進來的文字訊息記一筆，供每分鐘/每日計數
create table if not exists public.line_rate_log (
  id           bigserial primary key,
  line_user_id text not null,
  created_at   timestamptz not null default now()
);
create index if not exists line_rate_log_user_time_idx on public.line_rate_log (line_user_id, created_at);
create index if not exists line_rate_log_time_idx       on public.line_rate_log (created_at);
-- 只給 service role（edge function）用；擋掉 anon/authenticated
alter table public.line_rate_log enable row level security;

-- (B) 搜尋只回「商城已上架」的商品（避免對客人洩露未上架/草稿品）
create or replace function public.line_search_products(
  p_store_id bigint,
  p_query text
)
returns table (
  product_id   bigint,
  name         text,
  source       text,
  has_variants boolean,
  published    boolean,
  sold_out     boolean
)
language plpgsql
stable
set search_path = public, extensions
as $$
declare
  tokens text[];
begin
  tokens := array_remove(regexp_split_to_array(coalesce(trim(p_query), ''), '\s+'), '');

  return query
  with base as (
    select
      p.id,
      p.name,
      p.source,
      exists (select 1 from public.product_variants v where v.product_id = p.id) as has_variants,
      coalesce(sf.sold_out, false) as sold_out,
      coalesce(p.name, '') || ' ' || coalesce(p.source, '') || ' ' || coalesce(p.sku, '') as haystack
    from public.products p
    join public.storefront_products sf on sf.product_id = p.id   -- 只看有上架設定的
    where p.store_id = p_store_id
      and sf.published = true                                    -- 且已上架
  ),
  scored as (
    select
      b.*,
      (cardinality(tokens) > 0
        and (select bool_and(b.haystack ilike '%' || t || '%') from unnest(tokens) t)
      ) as token_match,
      similarity(b.name, coalesce(p_query, '')) as sim
    from base b
  )
  select s.id, s.name, s.source, s.has_variants, true as published, s.sold_out
  from scored s
  where coalesce(p_query, '') <> ''
    and (s.token_match or s.sim > 0.2)
  order by s.token_match desc, s.sim desc
  limit 8;
end;
$$;

-- (C) 庫存查詢帶出 published 與 skip_stock_check（預購/可超賣）
create or replace function public.line_get_stock(
  p_product_id bigint
)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'product_id',       p.id,
    'name',             p.name,
    'source',           p.source,
    'published',        coalesce(sf.published, false),
    'sold_out',         coalesce(sf.sold_out, false),
    'skip_stock_check', coalesce(sf.skip_stock_check, false),  -- true=預購/可預訂，庫存 0 仍可下單
    'on_sale',          coalesce(sf.on_sale, false),
    'shop_price',       sf.shop_price,
    'sale_price',       sf.sale_price,
    'has_variants',     exists (select 1 from public.product_variants v where v.product_id = p.id),
    'base_quantity',    p.quantity,
    'variants', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'label',      coalesce(vlabel.label, '（未命名規格）'),
          'stock',      v.stock,
          'price',      coalesce(v.variant_price, sf.shop_price),
          'sale_price', coalesce(v.sale_price, sf.sale_price)
        )
        order by v.id
      )
      from public.product_variants v
      left join lateral (
        select string_agg(t.name || '：' || ov.value, ' / ' order by t.sort_order) as label
        from jsonb_each_text(v.options) as o(type_id, value_id)
        join public.variant_option_types  t  on t.id  = o.type_id::bigint
        join public.variant_option_values ov on ov.id = o.value_id::bigint
      ) vlabel on true
      where v.product_id = p.id
    ), '[]'::jsonb)
  )
  from public.products p
  left join public.storefront_products sf on sf.product_id = p.id
  where p.id = p_product_id;
$$;

revoke all on function public.line_search_products(bigint, text) from public, anon, authenticated;
revoke all on function public.line_get_stock(bigint)           from public, anon, authenticated;
grant execute on function public.line_search_products(bigint, text) to service_role;
grant execute on function public.line_get_stock(bigint)            to service_role;
