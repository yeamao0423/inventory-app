-- 允許已登入使用者刪除 product-images bucket 的檔案。
-- 沒有這條 policy 時，前端 storage.remove() 會靜默失敗（RLS 擋 DELETE），
-- 導致刪除商品/刪除圖片後 Storage 留下孤兒檔案。
CREATE POLICY "auth delete" ON storage.objects
  FOR DELETE USING (bucket_id = 'product-images' AND auth.role() = 'authenticated');
