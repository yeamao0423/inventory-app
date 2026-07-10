-- 20250045: line_get_stock 補 variant id + skip_stock_check
--
-- 背景：Phase D/E（以圖找商品／全對話下單）的 create_order 工具需要
--       知道每個規格的 id，才能把正確的 variant_id 傳給 place_order。
--       同時補上 skip_stock_check（預購商品下單判斷必要）。
--
-- 變動：variants 陣列每個物件加 "id" 欄位；頂層加 "skip_stock_check"。
--       GRANT/REVOKE 維持不變（service_role only）。

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
