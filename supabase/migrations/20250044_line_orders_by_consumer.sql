-- ============================================================
-- LINE 智慧客服 Phase B：查「本人」訂單（綁定範圍）
--   取代舊的「編號＋手機」版：只吃 consumer_id 與本人手機（由綁定反查而來），
--   使用者無法自行輸入他人編號/電話 → 杜絕查到別人訂單。
-- ============================================================

create or replace function public.line_get_orders_by_consumer(
  p_store_id    bigint,
  p_consumer_id uuid,
  p_phone       text
)
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb)
  from (
    select
      o.store_order_no,
      o.status,
      o.payment_status,
      o.tracking_number,
      o.total_amount,
      left(coalesce(o.items, ''), 200) as items,
      o.created_at
    from public.consumer_orders o
    where o.store_id = p_store_id
      and (
        o.consumer_id = p_consumer_id
        or (
          coalesce(p_phone, '') <> ''
          and right(regexp_replace(coalesce(o.phone, ''), '\D', '', 'g'), 9)
            = right(regexp_replace(p_phone, '\D', '', 'g'), 9)
        )
      )
    order by o.created_at desc
    limit 10
  ) x;
$$;

revoke all on function public.line_get_orders_by_consumer(bigint, uuid, text) from public, anon, authenticated;
grant execute on function public.line_get_orders_by_consumer(bigint, uuid, text) to service_role;
