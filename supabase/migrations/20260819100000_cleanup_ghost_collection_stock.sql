-- 清理限時單幽靈庫存：只處理「完全沒有採購憑證」的限時商品，
-- 用 consumer_orders.stock_committed（訂單目前真實佔用庫存的正式記錄）反推正確庫存，
-- 而不是整批打成 0——有真實訂單在等的維持負庫存（正確標記還欠客人幾件，會進採購彙整），
-- 沒訂單的歸零。範圍限定 store_id=1（Daigogo）、限時單、完全無 procurement_items 紀錄。
--
-- 根因（限時單建立時沒強制庫存歸零）已在 7c2dbbc 修掉，這支只處理修復前留下的舊資料。
-- 這是一次性資料修正，不是可重複執行的機制；套用時 20260818100000~130000 的
-- history 帳本 trigger 應該已經在，這次的庫存變動會被自動記進 history。

create temp table t_ghost_candidates as
select p.id as product_id
from products p
join storefront_products sp on sp.product_id = p.id
where p.store_id = 1
  and sp.collection_end is not null
  and not exists (select 1 from procurement_items pi where pi.product_id = p.id);

create temp table t_committed as
select
  split_part(key, ':', 1)::bigint as product_id,
  nullif(split_part(key, ':', 2), '')::bigint as variant_id,
  sum(value::int) as committed_qty
from consumer_orders co, jsonb_each_text(co.stock_committed) kv(key, value)
where co.store_id = 1
group by 1, 2;

-- 有規格商品：逐規格重設（用 correlated subquery 代替 join，UPDATE target 不能在
-- FROM 子句的 join 條件裡被引用）
update product_variants v
set stock = -coalesce(
  (select committed_qty from t_committed c where c.product_id = v.product_id and c.variant_id = v.id), 0)
from t_ghost_candidates g
where v.product_id = g.product_id
  and v.stock is distinct from -coalesce(
    (select committed_qty from t_committed c where c.product_id = v.product_id and c.variant_id = v.id), 0);

-- 無規格商品：重設 quantity
update products p
set quantity = -coalesce(
  (select committed_qty from t_committed c where c.product_id = p.id and c.variant_id is null), 0)
from t_ghost_candidates g
where p.id = g.product_id
  and not exists (select 1 from product_variants v where v.product_id = p.id)
  and p.quantity is distinct from -coalesce(
    (select committed_qty from t_committed c where c.product_id = p.id and c.variant_id is null), 0);

drop table t_ghost_candidates;
drop table t_committed;
