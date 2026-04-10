-- ============================================================
-- Daigogo Inventory + Storefront — Full Schema
-- 在 Supabase Cloud Dashboard → SQL Editor 中執行
-- ============================================================

-- ── Functions ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
AS $$
begin
  insert into public.profiles (id, name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', new.email),
    new.email
  )
  on conflict (id) do nothing;

  insert into public.user_store_roles (user_id, store_id, role)
  values (new.id, 1, 'viewer')
  on conflict (user_id, store_id) do nothing;

  return new;
end;
$$;

CREATE OR REPLACE FUNCTION public.update_updated_at() RETURNS trigger
    LANGUAGE plpgsql
AS $$
begin new.updated_at = now(); return new; end;
$$;

-- ── Tables ───────────────────────────────────────────────────

-- Stores
CREATE TABLE IF NOT EXISTS public.stores (
    id bigserial PRIMARY KEY,
    name text NOT NULL,
    created_at timestamptz DEFAULT now()
);

-- Profiles (admin users)
CREATE TABLE IF NOT EXISTS public.profiles (
    id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    name text NOT NULL,
    email text,
    created_at timestamptz DEFAULT now()
);

-- User store roles
CREATE TABLE IF NOT EXISTS public.user_store_roles (
    id bigserial PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    store_id bigint DEFAULT 1 NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
    role text DEFAULT 'viewer' NOT NULL CHECK (role IN ('super_admin','admin','editor','viewer')),
    created_at timestamptz DEFAULT now(),
    UNIQUE (user_id, store_id)
);

-- Invitations
CREATE TABLE IF NOT EXISTS public.invitations (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    email text NOT NULL,
    role text NOT NULL CHECK (role IN ('admin','editor')),
    store_id bigint DEFAULT 1 REFERENCES public.stores(id),
    invited_by uuid REFERENCES auth.users(id),
    token text DEFAULT encode(extensions.gen_random_bytes(32), 'hex') NOT NULL UNIQUE,
    status text DEFAULT 'pending' NOT NULL CHECK (status IN ('pending','accepted','expired')),
    expires_at timestamptz DEFAULT (now() + interval '7 days') NOT NULL,
    created_at timestamptz DEFAULT now()
);

-- Categories
CREATE TABLE IF NOT EXISTS public.categories (
    id bigserial PRIMARY KEY,
    name text NOT NULL UNIQUE,
    name_en text,
    sort_order integer DEFAULT 0,
    created_at timestamptz DEFAULT now()
);

-- Tags
CREATE TABLE IF NOT EXISTS public.tags (
    id bigserial PRIMARY KEY,
    name text NOT NULL UNIQUE,
    name_en text,
    sort_order integer DEFAULT 0,
    created_at timestamptz DEFAULT now()
);

-- Products
CREATE TABLE IF NOT EXISTS public.products (
    id bigserial PRIMARY KEY,
    name text NOT NULL,
    sku text NOT NULL UNIQUE,
    quantity integer DEFAULT 0 NOT NULL,
    unit text DEFAULT '個' NOT NULL,
    cost numeric(10,2) DEFAULT 0,
    currency text DEFAULT 'TWD',
    category_id bigint REFERENCES public.categories(id) ON DELETE SET NULL,
    source text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- Product images
CREATE TABLE IF NOT EXISTS public.product_images (
    id bigserial PRIMARY KEY,
    product_id bigint NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
    url text NOT NULL,
    sort_order integer DEFAULT 0,
    created_at timestamptz DEFAULT now()
);

-- Product tags (many-to-many)
CREATE TABLE IF NOT EXISTS public.product_tags (
    product_id bigint NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
    tag_id bigint NOT NULL REFERENCES public.tags(id) ON DELETE CASCADE,
    PRIMARY KEY (product_id, tag_id)
);

-- Variant option types (e.g. 顏色、尺碼、性別)
CREATE TABLE IF NOT EXISTS public.variant_option_types (
    id bigserial PRIMARY KEY,
    name text NOT NULL UNIQUE,
    sort_order integer DEFAULT 0,
    created_at timestamptz DEFAULT now()
);

-- Variant option values (e.g. 黑色、白色、S、M、L)
CREATE TABLE IF NOT EXISTS public.variant_option_values (
    id bigserial PRIMARY KEY,
    option_type_id bigint REFERENCES public.variant_option_types(id) ON DELETE CASCADE,
    value text NOT NULL,
    sort_order integer DEFAULT 0,
    created_at timestamptz DEFAULT now(),
    UNIQUE (option_type_id, value)
);

-- Product variants
CREATE TABLE IF NOT EXISTS public.product_variants (
    id bigserial PRIMARY KEY,
    product_id bigint REFERENCES public.products(id) ON DELETE CASCADE,
    options jsonb DEFAULT '{}',
    stock integer DEFAULT 0 NOT NULL,
    price_adjustment numeric(10,2) DEFAULT 0,
    created_at timestamptz DEFAULT now()
);

-- Custom options (per-product custom fields)
CREATE TABLE IF NOT EXISTS public.custom_options (
    id bigserial PRIMARY KEY,
    product_id bigint REFERENCES public.products(id) ON DELETE CASCADE,
    label text NOT NULL,
    type text DEFAULT 'text',
    placeholder text,
    required boolean DEFAULT false,
    created_at timestamptz DEFAULT now()
);

-- Storefront products
CREATE TABLE IF NOT EXISTS public.storefront_products (
    id bigserial PRIMARY KEY,
    product_id bigint UNIQUE REFERENCES public.products(id) ON DELETE CASCADE,
    published boolean DEFAULT false,
    shop_price numeric(10,2) DEFAULT 0 NOT NULL,
    name_en text,
    desc_zh text,
    desc_en text,
    sort_order integer DEFAULT 0,
    collection_end timestamptz,
    sold_out boolean DEFAULT false,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- Exchange rates
CREATE TABLE IF NOT EXISTS public.exchange_rates (
    currency text PRIMARY KEY,
    rate numeric(10,4) NOT NULL,
    updated_at timestamptz DEFAULT now()
);

-- Inventory history
CREATE TABLE IF NOT EXISTS public.history (
    id bigserial PRIMARY KEY,
    sku text NOT NULL,
    change integer NOT NULL,
    reason text,
    created_at timestamptz DEFAULT now()
);

-- Internal orders (admin-created)
CREATE TABLE IF NOT EXISTS public.orders (
    id bigserial PRIMARY KEY,
    customer text NOT NULL,
    items text NOT NULL,
    total_amount numeric(10,2),
    deposit numeric(10,2) DEFAULT 0,
    payment_status text DEFAULT '未付' NOT NULL CHECK (payment_status IN ('未付','已付訂金','已付清')),
    note text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- Consumer orders (storefront checkout)
CREATE TABLE IF NOT EXISTS public.consumer_orders (
    id bigserial PRIMARY KEY,
    customer_name text NOT NULL,
    email text,
    phone text,
    address text,
    items text NOT NULL,
    items_json jsonb,
    total_amount numeric(10,2),
    payment_status text DEFAULT '未付',
    status text DEFAULT '待確認',
    note text,
    shipping_fee integer DEFAULT 0,
    fulfillment_type text,
    line_id text,
    tracking_number text,
    remittance_last5 text,
    store_name text,
    store_number text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- Consumers (storefront users)
CREATE TABLE IF NOT EXISTS public.consumers (
    id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email text NOT NULL,
    name text,
    phone text,
    line_id text,
    created_at timestamptz DEFAULT now()
);

-- ── Triggers ─────────────────────────────────────────────────

CREATE TRIGGER orders_updated_at BEFORE UPDATE ON public.orders
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER products_updated_at BEFORE UPDATE ON public.products
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Auth trigger: auto-create profile on signup
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── Row Level Security ───────────────────────────────────────

ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_store_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.variant_option_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.variant_option_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.storefront_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exchange_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consumer_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consumers ENABLE ROW LEVEL SECURITY;

-- ── RLS Policies ─────────────────────────────────────────────

-- Admin tables: authenticated users can read/write
CREATE POLICY "allow all authenticated stores" ON public.stores USING (auth.role() = 'authenticated');
CREATE POLICY "allow all authenticated profiles" ON public.profiles USING (auth.role() = 'authenticated');
CREATE POLICY "allow all authenticated user_store_roles" ON public.user_store_roles USING (auth.role() = 'authenticated');
CREATE POLICY "allow all authenticated products" ON public.products USING (auth.role() = 'authenticated');
CREATE POLICY "allow all authenticated orders" ON public.orders USING (auth.role() = 'authenticated');
CREATE POLICY "allow all authenticated history" ON public.history USING (auth.role() = 'authenticated');
CREATE POLICY "allow all authenticated exchange_rates" ON public.exchange_rates USING (auth.role() = 'authenticated');

-- Invitations
CREATE POLICY "anon read invitations by token" ON public.invitations FOR SELECT USING (true);
CREATE POLICY "authenticated manage invitations" ON public.invitations USING (auth.role() = 'authenticated');

-- Public-readable tables (storefront needs these)
CREATE POLICY "public read categories" ON public.categories FOR SELECT USING (true);
CREATE POLICY "auth write categories" ON public.categories USING (auth.role() = 'authenticated');

CREATE POLICY "public read tags" ON public.tags FOR SELECT USING (true);
CREATE POLICY "auth write tags" ON public.tags USING (auth.role() = 'authenticated');

CREATE POLICY "public read products" ON public.products FOR SELECT USING (true);

CREATE POLICY "public read product_images" ON public.product_images FOR SELECT USING (true);
CREATE POLICY "auth write product_images" ON public.product_images USING (auth.role() = 'authenticated');

CREATE POLICY "public read product_tags" ON public.product_tags FOR SELECT USING (true);
CREATE POLICY "auth write product_tags" ON public.product_tags USING (auth.role() = 'authenticated');

CREATE POLICY "public read variant_option_types" ON public.variant_option_types FOR SELECT USING (true);
CREATE POLICY "auth write variant_option_types" ON public.variant_option_types USING (auth.role() = 'authenticated');

CREATE POLICY "public read variant_option_values" ON public.variant_option_values FOR SELECT USING (true);
CREATE POLICY "auth write variant_option_values" ON public.variant_option_values USING (auth.role() = 'authenticated');

CREATE POLICY "public read variants" ON public.product_variants FOR SELECT USING (true);
CREATE POLICY "auth write variants" ON public.product_variants USING (auth.role() = 'authenticated');

CREATE POLICY "public read options" ON public.custom_options FOR SELECT USING (true);
CREATE POLICY "auth write options" ON public.custom_options USING (auth.role() = 'authenticated');

CREATE POLICY "public read published" ON public.storefront_products FOR SELECT USING (published = true OR auth.role() = 'authenticated');
CREATE POLICY "auth write storefront" ON public.storefront_products USING (auth.role() = 'authenticated');

-- Consumer orders: anyone can insert & read (for order status page), admin can update
CREATE POLICY "public insert orders" ON public.consumer_orders FOR INSERT WITH CHECK (true);
CREATE POLICY "anon read own order" ON public.consumer_orders FOR SELECT USING (true);
CREATE POLICY "auth update consumer_orders" ON public.consumer_orders FOR UPDATE USING (auth.role() = 'authenticated');

-- Consumers: users manage own profile
CREATE POLICY "users read own profile" ON public.consumers FOR SELECT USING (auth.uid() = id);
CREATE POLICY "users insert own profile" ON public.consumers FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "users update own profile" ON public.consumers FOR UPDATE USING (auth.uid() = id);

-- ── Seed data ────────────────────────────────────────────────

INSERT INTO public.stores (id, name) VALUES (1, 'Daigogo') ON CONFLICT DO NOTHING;

INSERT INTO public.exchange_rates (currency, rate) VALUES
  ('TWD', 1.0000),
  ('VND', 0.0013)
ON CONFLICT (currency) DO NOTHING;
