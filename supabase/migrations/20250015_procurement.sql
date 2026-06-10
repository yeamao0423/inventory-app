-- ============================================================
-- 統一 Migration：variant_price + 採購批次系統
-- 可安全重複執行（IF NOT EXISTS / IF NOT EXISTS policy check）
-- ============================================================

BEGIN;

-- ============================================================
-- Part 1: Add variant_price to product_variants
-- ============================================================

ALTER TABLE public.product_variants
ADD COLUMN IF NOT EXISTS variant_price numeric(10,2) DEFAULT NULL;

UPDATE public.product_variants pv
SET variant_price = sp.shop_price + pv.price_adjustment
FROM public.storefront_products sp
WHERE sp.product_id = pv.product_id
  AND pv.price_adjustment != 0
  AND pv.variant_price IS NULL;

-- ============================================================
-- Part 2: 採購批次 + 墊付追蹤系統
-- buyer_id / manager_id / paid_by 直接參考 profiles (uuid)
-- ============================================================

-- 清除舊版表（如有）
DROP TABLE IF EXISTS procurement_items CASCADE;
DROP TABLE IF EXISTS procurement_batches CASCADE;
DROP TABLE IF EXISTS procurement_members CASCADE;

-- 採購批次
CREATE TABLE procurement_batches (
    id bigserial PRIMARY KEY,
    store_id bigint DEFAULT 1 REFERENCES stores(id) ON DELETE CASCADE,
    batch_date date NOT NULL,
    source text,                                                -- 採購來源（UNIQLO, ABC-MART…）
    buyer_id uuid REFERENCES profiles(id),                      -- 預設付款人（墊錢）
    manager_id uuid REFERENCES profiles(id),                    -- 負責人
    status text DEFAULT 'draft'
        CHECK (status IN ('draft','in_progress','done','settled')),
    inventory_synced boolean DEFAULT false,                     -- 是否已同步庫存
    note text,
    created_at timestamptz DEFAULT now()
);

-- 採購品項明細
CREATE TABLE procurement_items (
    id bigserial PRIMARY KEY,
    batch_id bigint NOT NULL REFERENCES procurement_batches(id) ON DELETE CASCADE,
    product_id bigint REFERENCES products(id),
    variant_id bigint REFERENCES product_variants(id),
    quantity integer NOT NULL DEFAULT 1,                        -- 預計採購數量
    actual_qty integer,                                        -- 實際買到數量（null = 未回報）
    unit_cost numeric(10,2),                                   -- 實際採購單價（預設帶 products.cost）
    currency text DEFAULT 'TWD',
    paid_by uuid REFERENCES profiles(id),                      -- 實際付款人（可覆蓋批次預設）
    status text DEFAULT 'pending'
        CHECK (status IN ('pending','bought','partial','missed')),
    note text,
    created_at timestamptz DEFAULT now()
);

-- RLS policies
ALTER TABLE procurement_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE procurement_items ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'procurement_batches' AND policyname = 'authenticated full access') THEN
    CREATE POLICY "authenticated full access" ON procurement_batches FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'procurement_items' AND policyname = 'authenticated full access') THEN
    CREATE POLICY "authenticated full access" ON procurement_items FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMIT;
