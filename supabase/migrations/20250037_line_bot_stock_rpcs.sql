-- ============================================================
-- LINE 智慧客服 Phase 1：庫存查詢 RPC
-- 供 supabase/functions/line-webhook 以 service role 呼叫
-- 設計原則：只回「商城可見」的庫存與售價，絕不回成本(cost/variant_cost)
-- ============================================================

-- 1) 模糊搜尋商品：使用者提到某商品但還不知道 product_id 時用
--    斷詞比對（每個詞都要出現在 名稱/品牌/SKU）+ pg_trgm 相似度後援（容錯空白/錯字/順序）
create extension if not exists pg_trgm with schema extensions;

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
  -- 以空白斷詞，去掉空字串
  tokens := array_remove(regexp_split_to_array(coalesce(trim(p_query), ''), '\s+'), '');

  return query
  with base as (
    select
      p.id,
      p.name,
      p.source,
      exists (select 1 from public.product_variants v where v.product_id = p.id) as has_variants,
      coalesce(sf.published, false) as published,
      coalesce(sf.sold_out, false)  as sold_out,
      coalesce(p.name, '') || ' ' || coalesce(p.source, '') || ' ' || coalesce(p.sku, '') as haystack
    from public.products p
    left join public.storefront_products sf on sf.product_id = p.id
    where p.store_id = p_store_id
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
  select s.id, s.name, s.source, s.has_variants, s.published, s.sold_out
  from scored s
  where coalesce(p_query, '') <> ''
    and (s.token_match or s.sim > 0.2)
  order by s.token_match desc, s.published desc, s.sim desc
  limit 8;
end;
$$;

-- 2) 查單一商品的即時庫存與售價（含各規格）
--    有規格 → variants 陣列列出每個規格的庫存/售價；無規格 → 看 base_quantity
--    回傳 jsonb，方便 edge function 直接丟給 Claude 當工具結果
create or replace function public.line_get_stock(
  p_product_id bigint
)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'product_id',    p.id,
    'name',          p.name,
    'source',        p.source,
    'published',     coalesce(sf.published, false),
    'sold_out',      coalesce(sf.sold_out, false),
    'on_sale',       coalesce(sf.on_sale, false),
    'shop_price',    sf.shop_price,
    'sale_price',    sf.sale_price,
    'has_variants',  exists (select 1 from public.product_variants v where v.product_id = p.id),
    'base_quantity', p.quantity,
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

-- 只允許 service role 呼叫（edge function 身分）；不開放 anon/authenticated
revoke all on function public.line_search_products(bigint, text) from public, anon, authenticated;
revoke all on function public.line_get_stock(bigint)           from public, anon, authenticated;
grant execute on function public.line_search_products(bigint, text) to service_role;
grant execute on function public.line_get_stock(bigint)            to service_role;
