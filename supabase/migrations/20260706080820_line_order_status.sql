-- ⚠️ 從 remote 追蹤表撈回存檔（2026-08-04），不是在這裡寫完才上去的。
-- 完整緣由見 20260702164417_line_search_products_fuzzy.sql 的檔頭。
-- 內容與 remote 上實際跑過的一字不差，請勿順手整理。

create or replace function public.line_get_order_status(
  p_store_id bigint,
  p_order_no text,
  p_phone text
)
returns jsonb
language sql
stable
as $$
  with q as (
    select
      regexp_replace(coalesce(p_order_no, ''), '\D', '', 'g')                    as ono,
      right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9)             as ph9,
      length(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'))              as ph_len
  )
  select case when o.id is null then null else jsonb_build_object(
    'store_order_no',  o.store_order_no,
    'status',          o.status,
    'payment_status',  o.payment_status,
    'tracking_number', o.tracking_number,
    'total_amount',    o.total_amount,
    'items',           left(coalesce(o.items, ''), 300),
    'created_at',      o.created_at
  ) end
  from q
  left join public.consumer_orders o
    on o.store_id = p_store_id
   and q.ono <> ''
   and q.ph_len >= 6
   and regexp_replace(o.store_order_no::text, '\D', '', 'g') = q.ono
   and right(regexp_replace(coalesce(o.phone, ''), '\D', '', 'g'), 9) like '%' || q.ph9
  limit 1;
$$;

revoke all on function public.line_get_order_status(bigint, text, text) from public, anon, authenticated;
grant execute on function public.line_get_order_status(bigint, text, text) to service_role;
