-- ⚠️ 從 remote 追蹤表撈回存檔（2026-08-04），不是在這裡寫完才上去的。
-- 完整緣由見 20260702164417_line_search_products_fuzzy.sql 的檔頭。
-- 內容與 remote 上實際跑過的一字不差，請勿順手整理。

CREATE OR REPLACE FUNCTION public.line_get_stock(p_product_id bigint)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT jsonb_build_object(
    'product_id',       p.id,
    'name',             p.name,
    'source',           p.source,
    'published',        COALESCE(sf.published, false),
    'sold_out',         COALESCE(sf.sold_out, false),
    'on_sale',          COALESCE(sf.on_sale, false),
    'skip_stock_check', COALESCE(sf.skip_stock_check, false),
    'shop_price',       sf.shop_price,
    'sale_price',       sf.sale_price,
    'has_variants',     EXISTS (SELECT 1 FROM public.product_variants v WHERE v.product_id = p.id),
    'base_quantity',    p.quantity,
    'variants', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id',         v.id,
          'label',      COALESCE(vlabel.label, '（未命名規格）'),
          'stock',      v.stock,
          'price',      COALESCE(v.variant_price, sf.shop_price),
          'sale_price', COALESCE(v.sale_price, sf.sale_price)
        )
        ORDER BY v.id
      )
      FROM public.product_variants v
      LEFT JOIN LATERAL (
        SELECT string_agg(t.name || '：' || ov.value, ' / ' ORDER BY t.sort_order) AS label
        FROM jsonb_each_text(v.options) AS o(type_id, value_id)
        JOIN public.variant_option_types  t  ON t.id  = o.type_id::bigint
        JOIN public.variant_option_values ov ON ov.id = o.value_id::bigint
      ) vlabel ON true
      WHERE v.product_id = p.id
    ), '[]'::jsonb)
  )
  FROM public.products p
  LEFT JOIN public.storefront_products sf ON sf.product_id = p.id
  WHERE p.id = p_product_id;
$$;
