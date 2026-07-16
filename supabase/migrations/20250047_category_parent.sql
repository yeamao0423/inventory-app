-- 分類階層（兩層專區選單）：parent_id 指向同店的父分類，NULL = 頂層。
-- 刪除父分類時子分類自動升為頂層（SET NULL），不連鎖刪除。
ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS parent_id bigint REFERENCES categories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_categories_parent_id ON categories(parent_id);
