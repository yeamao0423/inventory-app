-- ============================================
-- Migration: Coupon system
-- Run this in Supabase Dashboard → SQL Editor
-- ============================================

-- ── Tables ──────────────────────────────────

-- 優惠券活動主表
CREATE TABLE IF NOT EXISTS public.coupons (
    id            bigserial PRIMARY KEY,

    -- 基本資訊
    name          text NOT NULL,
    type          text NOT NULL CHECK (type IN ('shared', 'unique')),

    -- shared 型：通用優惠碼
    code          text UNIQUE,
    max_usage     integer,

    -- 折扣設定
    discount_type text NOT NULL CHECK (discount_type IN ('fixed', 'percentage')),
    discount_value numeric(10,2) NOT NULL,
    min_amount    numeric(10,2) DEFAULT 0,
    max_discount  numeric(10,2),

    -- 適用範圍（預留擴充）
    scope         text NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'product', 'category', 'combo')),
    scope_config  jsonb DEFAULT '{}',

    -- 使用限制
    per_consumer_limit integer DEFAULT 1,
    usage_count   integer DEFAULT 0,

    -- 有效期間
    starts_at     timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz,

    -- 狀態
    is_active     boolean DEFAULT true,

    created_at    timestamptz DEFAULT now(),
    updated_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coupons_code ON public.coupons (code) WHERE code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_coupons_active ON public.coupons (is_active, starts_at, expires_at);

-- 特殊代碼表（unique 型專用）
CREATE TABLE IF NOT EXISTS public.coupon_codes (
    id          bigserial PRIMARY KEY,
    coupon_id   bigint NOT NULL REFERENCES public.coupons(id) ON DELETE CASCADE,
    code        text NOT NULL UNIQUE,
    is_used     boolean DEFAULT false,
    used_by     text,
    used_at     timestamptz,
    order_id    bigint REFERENCES public.consumer_orders(id),

    created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coupon_codes_code ON public.coupon_codes (code);
CREATE INDEX IF NOT EXISTS idx_coupon_codes_coupon_id ON public.coupon_codes (coupon_id);

-- 使用紀錄表
CREATE TABLE IF NOT EXISTS public.coupon_usage (
    id              bigserial PRIMARY KEY,
    coupon_id       bigint NOT NULL REFERENCES public.coupons(id),
    coupon_code_id  bigint REFERENCES public.coupon_codes(id),
    order_id        bigint NOT NULL REFERENCES public.consumer_orders(id),
    consumer_email  text,
    discount_amount numeric(10,2) NOT NULL,

    created_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coupon_usage_coupon_id ON public.coupon_usage (coupon_id);
CREATE INDEX IF NOT EXISTS idx_coupon_usage_consumer ON public.coupon_usage (coupon_id, consumer_email);
CREATE INDEX IF NOT EXISTS idx_coupon_usage_order ON public.coupon_usage (order_id);

-- consumer_orders 新增欄位
ALTER TABLE public.consumer_orders
    ADD COLUMN IF NOT EXISTS coupon_id bigint REFERENCES public.coupons(id),
    ADD COLUMN IF NOT EXISTS discount_amount numeric(10,2) DEFAULT 0;

-- ── Triggers ────────────────────────────────

CREATE TRIGGER coupons_updated_at BEFORE UPDATE ON public.coupons
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ── RLS ─────────────────────────────────────

ALTER TABLE public.coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coupon_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coupon_usage ENABLE ROW LEVEL SECURITY;

-- coupons: 公開可讀（前端預覽用），後台可寫
CREATE POLICY "public read coupons" ON public.coupons FOR SELECT USING (true);
CREATE POLICY "auth write coupons" ON public.coupons USING (auth.role() = 'authenticated');

-- coupon_codes: 公開可讀（前端查碼用），後台可寫
CREATE POLICY "public read coupon_codes" ON public.coupon_codes FOR SELECT USING (true);
CREATE POLICY "auth write coupon_codes" ON public.coupon_codes USING (auth.role() = 'authenticated');

-- coupon_usage: 公開可 insert（結帳時寫入），後台可讀可刪（退還時）
CREATE POLICY "public insert coupon_usage" ON public.coupon_usage FOR INSERT WITH CHECK (true);
CREATE POLICY "public read coupon_usage" ON public.coupon_usage FOR SELECT USING (true);
CREATE POLICY "auth delete coupon_usage" ON public.coupon_usage FOR DELETE USING (auth.role() = 'authenticated');

-- ── RPC Functions ───────────────────────────

-- 兌換優惠券（transaction，防 race condition）
CREATE OR REPLACE FUNCTION public.redeem_coupon(
    p_code        text,
    p_subtotal    numeric,
    p_consumer_email text,
    p_order_id    bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_coupon          record;
    v_coupon_code     record;
    v_coupon_code_id  bigint := NULL;
    v_discount        numeric;
    v_usage_count     integer;
    v_is_unique       boolean := false;
BEGIN
    -- 1. 查詢 shared 型優惠碼並鎖定
    SELECT * INTO v_coupon
        FROM public.coupons
        WHERE code = p_code AND type = 'shared'
        FOR UPDATE;

    -- 找不到則查 unique 型
    IF v_coupon IS NULL THEN
        SELECT * INTO v_coupon_code
            FROM public.coupon_codes
            WHERE code = p_code
            FOR UPDATE;

        IF v_coupon_code IS NULL THEN
            RETURN jsonb_build_object('ok', false, 'error', '優惠碼不存在');
        END IF;

        SELECT * INTO v_coupon
            FROM public.coupons
            WHERE id = v_coupon_code.coupon_id
            FOR UPDATE;

        v_is_unique := true;
        v_coupon_code_id := v_coupon_code.id;
    END IF;

    -- 2. 檢查活動狀態
    IF NOT v_coupon.is_active THEN
        RETURN jsonb_build_object('ok', false, 'error', '此優惠活動已停用');
    END IF;

    IF now() < v_coupon.starts_at THEN
        RETURN jsonb_build_object('ok', false, 'error', '此優惠尚未開始');
    END IF;

    IF v_coupon.expires_at IS NOT NULL AND now() > v_coupon.expires_at THEN
        RETURN jsonb_build_object('ok', false, 'error', '此優惠碼已過期');
    END IF;

    -- 3. 檢查使用次數
    IF v_is_unique THEN
        IF v_coupon_code.is_used THEN
            RETURN jsonb_build_object('ok', false, 'error', '此優惠碼已被使用');
        END IF;
    ELSE
        IF v_coupon.max_usage IS NOT NULL AND v_coupon.usage_count >= v_coupon.max_usage THEN
            RETURN jsonb_build_object('ok', false, 'error', '此優惠碼已達使用上限');
        END IF;
    END IF;

    -- 4. 檢查個人使用限制
    IF v_coupon.per_consumer_limit IS NOT NULL THEN
        SELECT COUNT(*) INTO v_usage_count
            FROM public.coupon_usage
            WHERE coupon_id = v_coupon.id
              AND consumer_email = p_consumer_email;

        IF v_usage_count >= v_coupon.per_consumer_limit THEN
            RETURN jsonb_build_object('ok', false, 'error', '您已使用過此優惠');
        END IF;
    END IF;

    -- 5. 檢查滿額門檻
    IF p_subtotal < v_coupon.min_amount THEN
        RETURN jsonb_build_object('ok', false, 'error',
            '未達最低消費 $' || v_coupon.min_amount::text);
    END IF;

    -- 6. 計算折扣金額
    IF v_coupon.discount_type = 'fixed' THEN
        v_discount := LEAST(v_coupon.discount_value, p_subtotal);
    ELSE
        v_discount := p_subtotal * (v_coupon.discount_value / 100.0);
        IF v_coupon.max_discount IS NOT NULL THEN
            v_discount := LEAST(v_discount, v_coupon.max_discount);
        END IF;
        v_discount := LEAST(v_discount, p_subtotal);
    END IF;

    v_discount := ROUND(v_discount);

    -- 7. 扣額度 + 寫紀錄
    UPDATE public.coupons
        SET usage_count = usage_count + 1, updated_at = now()
        WHERE id = v_coupon.id;

    IF v_is_unique THEN
        UPDATE public.coupon_codes
            SET is_used = true, used_by = p_consumer_email,
                used_at = now(), order_id = p_order_id
            WHERE id = v_coupon_code_id;
    END IF;

    INSERT INTO public.coupon_usage (coupon_id, coupon_code_id, order_id, consumer_email, discount_amount)
        VALUES (v_coupon.id, v_coupon_code_id, p_order_id, p_consumer_email, v_discount);

    -- 8. 更新訂單
    UPDATE public.consumer_orders
        SET coupon_id = v_coupon.id,
            discount_amount = v_discount,
            total_amount = total_amount - v_discount
        WHERE id = p_order_id;

    RETURN jsonb_build_object(
        'ok', true,
        'coupon_id', v_coupon.id,
        'coupon_name', v_coupon.name,
        'discount_amount', v_discount
    );
END;
$$;

-- 退還優惠券（後台手動觸發）
CREATE OR REPLACE FUNCTION public.refund_coupon(p_order_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_order    record;
    v_usage    record;
    v_coupon   record;
BEGIN
    -- 1. 取得訂單
    SELECT * INTO v_order
        FROM public.consumer_orders
        WHERE id = p_order_id;

    IF v_order IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', '訂單不存在');
    END IF;

    IF v_order.coupon_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', '此訂單未使用優惠券');
    END IF;

    -- 2. 取得使用紀錄
    SELECT * INTO v_usage
        FROM public.coupon_usage
        WHERE order_id = p_order_id
        LIMIT 1;

    -- 3. 取得優惠券
    SELECT * INTO v_coupon
        FROM public.coupons
        WHERE id = v_order.coupon_id
        FOR UPDATE;

    -- 4. 回復 usage_count
    UPDATE public.coupons
        SET usage_count = GREATEST(0, usage_count - 1), updated_at = now()
        WHERE id = v_coupon.id;

    -- 5. unique 型：回復 coupon_codes
    IF v_coupon.type = 'unique' AND v_usage.coupon_code_id IS NOT NULL THEN
        UPDATE public.coupon_codes
            SET is_used = false, used_by = NULL, used_at = NULL, order_id = NULL
            WHERE id = v_usage.coupon_code_id;
    END IF;

    -- 6. 刪除使用紀錄
    DELETE FROM public.coupon_usage WHERE order_id = p_order_id;

    -- 7. 更新訂單：移除折扣，重算 total
    UPDATE public.consumer_orders
        SET coupon_id = NULL,
            total_amount = total_amount + v_order.discount_amount,
            discount_amount = 0
        WHERE id = p_order_id;

    RETURN jsonb_build_object(
        'ok', true,
        'refunded_amount', v_order.discount_amount
    );
END;
$$;
