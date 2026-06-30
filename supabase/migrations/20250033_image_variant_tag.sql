-- 規格對應圖片：每張圖可選擇性綁定到某些規格值
-- tag_filter 格式：{"<option_type_id>": [<value_id>, ...]}
--   null            → 共用圖（所有規格皆顯示）
--   某維度無 key     → 該維度不設限
--   存「允許的值」    → 後台某維度全勾時不寫該 key
ALTER TABLE public.product_images
  ADD COLUMN IF NOT EXISTS tag_filter jsonb DEFAULT NULL;
