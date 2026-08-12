-- ══════════════════════════════════════════════
-- 行程匯率
--
-- 問題：exchange_rates 是全平台一份的「現在」匯率。但每趟出國實際換到的
--       價格不一樣 —— 同一件日圓標價的貨，這趟換 0.21、下趟換 0.25，
--       用全域匯率算出來的行程成本跟老闆真的付出去的錢對不上。
--
-- 做法：行程自己可以覆寫匯率，只填有換過的幣別。
--       {} 代表這趟沒特別設，成本照舊走全域匯率／下單當下的成本快照。
--       {"JPY": 0.2150} 代表這趟的日圓貨一律用 0.215 重算。
--
-- 刻意用 jsonb 而不是 currency + rate 兩欄：一趟行程可能在免稅店刷卡買日貨、
-- 又在轉機時補了韓國的貨，一個行程要吃得下多種幣別。
--
-- 注意這是「重算」而不是「凍結」：改行程匯率會連帶改寫該趟所有訂單的歷史
-- 毛利與客戶金額。已經拆過帳的行程要先 void_trip_settlement 再重算，
-- 否則拆賬單上的快照金額跟報告上的數字會對不起來。這是刻意的取捨 ——
-- 老闆要的是「這趟真的花了多少」，不是「下單那天的匯率是多少」。
-- ══════════════════════════════════════════════

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS exchange_rates jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.trips.exchange_rates IS
  '本趟行程的匯率覆寫 {幣別: 1 外幣兌台幣}，只填有覆寫的幣別；空物件代表沿用全域 exchange_rates';

-- 只放 {"XXX": 正數} 這種形狀，擋掉 0/負數/字串 —— 匯率 0 會讓成本整批變成
-- 0 元、毛利虛高到爆，比沒設還危險。
--
-- 走 IMMUTABLE 函式而不是把條件直接寫進 CHECK：展開 jsonb 一定要 jsonb_each，
-- 那是子查詢，CHECK 不收。代價是日後改這支函式不會回頭重驗既有列，
-- 要改規則就得連同 constraint 一起重建。
CREATE OR REPLACE FUNCTION public.trip_exchange_rates_valid(p jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
  SELECT p IS NULL OR (
    jsonb_typeof(p) = 'object'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(p) AS e(k, v)
      WHERE jsonb_typeof(v) <> 'number' OR (v)::numeric <= 0
    )
  );
$$;

COMMENT ON FUNCTION public.trip_exchange_rates_valid(jsonb) IS
  'trips.exchange_rates 的形狀檢查：物件、值為正數';

ALTER TABLE public.trips
  DROP CONSTRAINT IF EXISTS trips_exchange_rates_valid;
ALTER TABLE public.trips
  ADD CONSTRAINT trips_exchange_rates_valid
  CHECK (public.trip_exchange_rates_valid(exchange_rates));
