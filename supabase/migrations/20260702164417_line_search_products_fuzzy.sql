-- ⚠️ 這支是從 remote 追蹤表撈回來的，不是在這裡寫完才上去的。
--
-- 它與同批的另外四支（line_order_status、line_get_stock_with_variant_ids、
-- line_pending_orders、consumer_orders_ecpay_columns）曾經只存在於 remote 的
-- supabase_migrations.schema_migrations.statements 欄位，repo 完全沒有備份 ——
-- 一旦有人為了讓 `supabase db push` 通過而跑 `migration repair --status reverted`，
-- 這些 SQL 就永久消失了。2026-08-04 撈回存檔。
--
-- 檔名刻意用 remote 記錄的時間戳版本（而非 repo 慣用的 20250NNN 序號），
-- 這樣 `supabase migration list` 會把它認成「local 與 remote 都有」，漂移少五支。
-- 內容與 remote 上實際跑過的一字不差，請勿「順手整理」——那會讓存檔失去對照價值。

-- 改良 line_search_products：斷詞比對(每個詞都要出現) + pg_trgm 相似度後援
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

revoke all on function public.line_search_products(bigint, text) from public, anon, authenticated;
grant execute on function public.line_search_products(bigint, text) to service_role;
