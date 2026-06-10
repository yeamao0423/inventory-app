-- ============================================================
-- Migration: 客製化商品規格系統
-- ============================================================

-- 1. 規格類型表（例：顏色、鞋子尺碼、性別）
CREATE TABLE IF NOT EXISTS variant_option_types (
  id         bigserial PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  sort_order integer DEFAULT 0,
  created_at timestamptz DEFAULT NOW()
);
ALTER TABLE variant_option_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read variant_option_types"  ON variant_option_types FOR SELECT USING (true);
CREATE POLICY "auth write variant_option_types"   ON variant_option_types FOR ALL    USING (auth.role() = 'authenticated');
GRANT SELECT ON variant_option_types TO anon;
GRANT ALL    ON variant_option_types TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE variant_option_types_id_seq TO authenticated;

-- 2. 規格值表（例：黑色、白色、26、27、男款、女款）
CREATE TABLE IF NOT EXISTS variant_option_values (
  id             bigserial PRIMARY KEY,
  option_type_id bigint REFERENCES variant_option_types(id) ON DELETE CASCADE,
  value          text NOT NULL,
  sort_order     integer DEFAULT 0,
  created_at     timestamptz DEFAULT NOW(),
  UNIQUE (option_type_id, value)
);
ALTER TABLE variant_option_values ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read variant_option_values"  ON variant_option_values FOR SELECT USING (true);
CREATE POLICY "auth write variant_option_values"   ON variant_option_values FOR ALL    USING (auth.role() = 'authenticated');
GRANT SELECT ON variant_option_values TO anon;
GRANT ALL    ON variant_option_values TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE variant_option_values_id_seq TO authenticated;

-- 3. 更新 product_variants：新增 options 欄位，移除舊固定欄位
--    options 格式：{"<option_type_id>": <option_value_id>}
--    例：{"1": 3, "2": 7} = 類型ID:1 的值是 值ID:3，類型ID:2 的值是 值ID:7
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS options jsonb DEFAULT '{}';
ALTER TABLE product_variants DROP COLUMN IF EXISTS color;
ALTER TABLE product_variants DROP COLUMN IF EXISTS size;
ALTER TABLE product_variants DROP COLUMN IF EXISTS dimensions;
