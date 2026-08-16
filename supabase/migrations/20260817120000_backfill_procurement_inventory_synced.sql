-- ══════════════════════════════════════════════════════════════
-- 回填舊採購批次的 inventory_synced
--
-- 為什麼需要這支：20260812110000 加了 inventory_synced 欄位與
-- receive_batch_inventory() RPC，把批次「同步入庫」時才真正 +stock，
-- 並讓採購彙整（buildInTransitMap，見 src/lib/procurementNeed.js）
-- 只把「未同步」的批次品項算進在途量。
--
-- 但這支 RPC 上線之前建立的批次，全部沒機會走過它——當時根本沒有
-- 「同步入庫」這個動作，貨是用別的方式（人工調整商品頁庫存等）進帳
-- 的。這些批次的品項所屬商品/規格目前庫存皆非負值，可證實貨早就
-- 反映在庫存數字裡了。但因為 inventory_synced 永遠是 false，
-- buildInTransitMap() 會把它們永遠當成「在途未入庫」，疊加去扣抵
-- 待採購量——這些商品未來若又缺貨，待採購清單會被這筆幽靈在途量
-- 誤導而低估，甚至顯示 0。
--
-- 回填規則：inventory_synced 上線前建立、且狀態已經是 done 或
-- settled（batch 本身流程上算完成）的批次，直接標記
-- inventory_synced = true。cutoff 抓 2026-08-12 之前——目前最新一批
-- 建立於 2026-08-07，留了緩衝，且往後任何人若重跑這支也不會誤傷
-- 上線後才建立、真正還在途中的批次。
--
-- 刻意不動 products / product_variants 的 stock 數字，也不寫
-- history 表：這支只是承認「這些貨早就算進現有庫存了」，不是真的
-- 入庫動作，跟 receive_batch_inventory() 的語意不同，沒有實際庫存
-- 異動可記。
--
-- 已知殘留（另案處理，這支不解）：ProcurementBatchTab.jsx 的
-- settle() 標記已結清時沒檢查是否已同步，「同步庫存入庫」按鈕又只在
-- !isSettled 時顯示——批次一旦被結清但還沒同步，UI 上永遠沒有入口能
-- 再同步。這支順便解掉現有 4 筆卡在這個狀態的歷史批次，但前端這個
-- 洞本身還在，之後若有新批次踩到會重新卡住。
-- ══════════════════════════════════════════════════════════════

UPDATE public.procurement_batches
   SET inventory_synced = true
 WHERE inventory_synced IS NOT TRUE
   AND status IN ('done', 'settled')
   AND created_at < '2026-08-12 00:00:00+00'::timestamptz;
