


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
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


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_admin"() RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    AS $$                                                  
    select exists (                                                                                    
      select 1 from public.profiles where id = auth.uid() and role = 'admin'
    )                                                                                                  
  $$;


ALTER FUNCTION "public"."is_admin"() OWNER TO "supabase_admin";


CREATE OR REPLACE FUNCTION "public"."update_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin new.updated_at = now(); return new; end;
$$;


ALTER FUNCTION "public"."update_updated_at"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."categories" (
    "id" bigint NOT NULL,
    "name" "text" NOT NULL,
    "name_en" "text",
    "sort_order" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."categories" OWNER TO "supabase_admin";


CREATE SEQUENCE IF NOT EXISTS "public"."categories_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."categories_id_seq" OWNER TO "supabase_admin";


ALTER SEQUENCE "public"."categories_id_seq" OWNED BY "public"."categories"."id";



CREATE TABLE IF NOT EXISTS "public"."consumer_orders" (
    "id" bigint NOT NULL,
    "customer_name" "text" NOT NULL,
    "email" "text",
    "phone" "text",
    "address" "text",
    "items" "text" NOT NULL,
    "items_json" "jsonb",
    "total_amount" numeric(10,2),
    "payment_status" "text" DEFAULT '未付'::"text",
    "status" "text" DEFAULT '待確認'::"text",
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "shipping_fee" integer DEFAULT 0,
    "fulfillment_type" "text"
);


ALTER TABLE "public"."consumer_orders" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."consumer_orders_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."consumer_orders_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."consumer_orders_id_seq" OWNED BY "public"."consumer_orders"."id";



CREATE TABLE IF NOT EXISTS "public"."consumers" (
    "id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "name" "text",
    "phone" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "line_id" "text"
);


ALTER TABLE "public"."consumers" OWNER TO "supabase_admin";


CREATE TABLE IF NOT EXISTS "public"."custom_options" (
    "id" bigint NOT NULL,
    "product_id" bigint,
    "label" "text" NOT NULL,
    "type" "text" DEFAULT 'text'::"text",
    "placeholder" "text",
    "required" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."custom_options" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."custom_options_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."custom_options_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."custom_options_id_seq" OWNED BY "public"."custom_options"."id";



CREATE TABLE IF NOT EXISTS "public"."exchange_rates" (
    "currency" "text" NOT NULL,
    "rate" numeric(10,4) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."exchange_rates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."history" (
    "id" bigint NOT NULL,
    "sku" "text" NOT NULL,
    "change" integer NOT NULL,
    "reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."history" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."history_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."history_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."history_id_seq" OWNED BY "public"."history"."id";



CREATE TABLE IF NOT EXISTS "public"."invitations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "email" "text" NOT NULL,
    "role" "text" NOT NULL,
    "store_id" bigint DEFAULT 1,
    "invited_by" "uuid",
    "token" "text" DEFAULT "encode"("extensions"."gen_random_bytes"(32), 'hex'::"text") NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '7 days'::interval) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "invitations_role_check" CHECK (("role" = ANY (ARRAY['admin'::"text", 'editor'::"text"]))),
    CONSTRAINT "invitations_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'accepted'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."invitations" OWNER TO "supabase_admin";


CREATE TABLE IF NOT EXISTS "public"."orders" (
    "id" bigint NOT NULL,
    "customer" "text" NOT NULL,
    "items" "text" NOT NULL,
    "total_amount" numeric(10,2),
    "deposit" numeric(10,2) DEFAULT 0,
    "payment_status" "text" DEFAULT '未付'::"text" NOT NULL,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "orders_payment_status_check" CHECK (("payment_status" = ANY (ARRAY['未付'::"text", '已付訂金'::"text", '已付清'::"text"])))
);


ALTER TABLE "public"."orders" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."orders_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."orders_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."orders_id_seq" OWNED BY "public"."orders"."id";



CREATE TABLE IF NOT EXISTS "public"."product_images" (
    "id" bigint NOT NULL,
    "product_id" bigint NOT NULL,
    "url" "text" NOT NULL,
    "sort_order" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."product_images" OWNER TO "supabase_admin";


CREATE SEQUENCE IF NOT EXISTS "public"."product_images_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."product_images_id_seq" OWNER TO "supabase_admin";


ALTER SEQUENCE "public"."product_images_id_seq" OWNED BY "public"."product_images"."id";



CREATE TABLE IF NOT EXISTS "public"."product_tags" (
    "product_id" bigint NOT NULL,
    "tag_id" bigint NOT NULL
);


ALTER TABLE "public"."product_tags" OWNER TO "supabase_admin";


CREATE TABLE IF NOT EXISTS "public"."product_variants" (
    "id" bigint NOT NULL,
    "product_id" bigint,
    "color" "text",
    "size" "text",
    "dimensions" "text",
    "stock" integer DEFAULT 0 NOT NULL,
    "price_adjustment" numeric(10,2) DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."product_variants" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."product_variants_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."product_variants_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."product_variants_id_seq" OWNED BY "public"."product_variants"."id";



CREATE TABLE IF NOT EXISTS "public"."products" (
    "id" bigint NOT NULL,
    "name" "text" NOT NULL,
    "sku" "text" NOT NULL,
    "quantity" integer DEFAULT 0 NOT NULL,
    "unit" "text" DEFAULT '個'::"text" NOT NULL,
    "cost" numeric(10,2) DEFAULT 0,
    "currency" "text" DEFAULT 'TWD'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "category_id" bigint
);


ALTER TABLE "public"."products" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."products_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."products_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."products_id_seq" OWNED BY "public"."products"."id";



CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "email" "text"
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."storefront_products" (
    "id" bigint NOT NULL,
    "product_id" bigint,
    "published" boolean DEFAULT false,
    "shop_price" numeric(10,2) DEFAULT 0 NOT NULL,
    "name_en" "text",
    "desc_zh" "text",
    "desc_en" "text",
    "sort_order" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."storefront_products" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."storefront_products_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."storefront_products_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."storefront_products_id_seq" OWNED BY "public"."storefront_products"."id";



CREATE TABLE IF NOT EXISTS "public"."stores" (
    "id" bigint NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."stores" OWNER TO "supabase_admin";


CREATE SEQUENCE IF NOT EXISTS "public"."stores_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."stores_id_seq" OWNER TO "supabase_admin";


ALTER SEQUENCE "public"."stores_id_seq" OWNED BY "public"."stores"."id";



CREATE TABLE IF NOT EXISTS "public"."tags" (
    "id" bigint NOT NULL,
    "name" "text" NOT NULL,
    "name_en" "text",
    "sort_order" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."tags" OWNER TO "supabase_admin";


CREATE SEQUENCE IF NOT EXISTS "public"."tags_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."tags_id_seq" OWNER TO "supabase_admin";


ALTER SEQUENCE "public"."tags_id_seq" OWNED BY "public"."tags"."id";



CREATE TABLE IF NOT EXISTS "public"."user_store_roles" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "store_id" bigint DEFAULT 1 NOT NULL,
    "role" "text" DEFAULT 'viewer'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "user_store_roles_role_check" CHECK (("role" = ANY (ARRAY['super_admin'::"text", 'admin'::"text", 'editor'::"text", 'viewer'::"text"])))
);


ALTER TABLE "public"."user_store_roles" OWNER TO "supabase_admin";


CREATE SEQUENCE IF NOT EXISTS "public"."user_store_roles_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."user_store_roles_id_seq" OWNER TO "supabase_admin";


ALTER SEQUENCE "public"."user_store_roles_id_seq" OWNED BY "public"."user_store_roles"."id";



ALTER TABLE ONLY "public"."categories" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."categories_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."consumer_orders" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."consumer_orders_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."custom_options" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."custom_options_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."history" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."history_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."orders" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."orders_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."product_images" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."product_images_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."product_variants" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."product_variants_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."products" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."products_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."storefront_products" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."storefront_products_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."stores" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."stores_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."tags" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."tags_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."user_store_roles" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."user_store_roles_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."categories"
    ADD CONSTRAINT "categories_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."categories"
    ADD CONSTRAINT "categories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."consumer_orders"
    ADD CONSTRAINT "consumer_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."consumers"
    ADD CONSTRAINT "consumers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."custom_options"
    ADD CONSTRAINT "custom_options_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."exchange_rates"
    ADD CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("currency");



ALTER TABLE ONLY "public"."history"
    ADD CONSTRAINT "history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invitations"
    ADD CONSTRAINT "invitations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invitations"
    ADD CONSTRAINT "invitations_token_key" UNIQUE ("token");



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_images"
    ADD CONSTRAINT "product_images_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_tags"
    ADD CONSTRAINT "product_tags_pkey" PRIMARY KEY ("product_id", "tag_id");



ALTER TABLE ONLY "public"."product_variants"
    ADD CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_sku_key" UNIQUE ("sku");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."storefront_products"
    ADD CONSTRAINT "storefront_products_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."storefront_products"
    ADD CONSTRAINT "storefront_products_product_id_key" UNIQUE ("product_id");



ALTER TABLE ONLY "public"."stores"
    ADD CONSTRAINT "stores_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tags"
    ADD CONSTRAINT "tags_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."tags"
    ADD CONSTRAINT "tags_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_store_roles"
    ADD CONSTRAINT "user_store_roles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_store_roles"
    ADD CONSTRAINT "user_store_roles_user_id_store_id_key" UNIQUE ("user_id", "store_id");



CREATE OR REPLACE TRIGGER "orders_updated_at" BEFORE UPDATE ON "public"."orders" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "products_updated_at" BEFORE UPDATE ON "public"."products" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



ALTER TABLE ONLY "public"."consumers"
    ADD CONSTRAINT "consumers_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."custom_options"
    ADD CONSTRAINT "custom_options_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."invitations"
    ADD CONSTRAINT "invitations_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."invitations"
    ADD CONSTRAINT "invitations_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id");



ALTER TABLE ONLY "public"."product_images"
    ADD CONSTRAINT "product_images_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."product_tags"
    ADD CONSTRAINT "product_tags_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."product_tags"
    ADD CONSTRAINT "product_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."product_variants"
    ADD CONSTRAINT "product_variants_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."storefront_products"
    ADD CONSTRAINT "storefront_products_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_store_roles"
    ADD CONSTRAINT "user_store_roles_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_store_roles"
    ADD CONSTRAINT "user_store_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



CREATE POLICY "allow all authenticated exchange_rates" ON "public"."exchange_rates" USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "allow all authenticated history" ON "public"."history" USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "allow all authenticated orders" ON "public"."orders" USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "allow all authenticated products" ON "public"."products" USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "allow all authenticated profiles" ON "public"."profiles" USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "allow all authenticated stores" ON "public"."stores" USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "allow all authenticated user_store_roles" ON "public"."user_store_roles" USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "anon read invitations by token" ON "public"."invitations" FOR SELECT USING (true);



CREATE POLICY "anon read own order" ON "public"."consumer_orders" FOR SELECT USING (true);



CREATE POLICY "auth read consumer_orders" ON "public"."consumer_orders" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "auth read orders" ON "public"."consumer_orders" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "auth update consumer_orders" ON "public"."consumer_orders" FOR UPDATE USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "auth update orders" ON "public"."consumer_orders" FOR UPDATE USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "auth write categories" ON "public"."categories" USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "auth write options" ON "public"."custom_options" USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "auth write product_images" ON "public"."product_images" USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "auth write product_tags" ON "public"."product_tags" USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "auth write storefront" ON "public"."storefront_products" USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "auth write tags" ON "public"."tags" USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "auth write variants" ON "public"."product_variants" USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "authenticated manage invitations" ON "public"."invitations" USING (("auth"."role"() = 'authenticated'::"text"));



ALTER TABLE "public"."categories" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."consumer_orders" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."consumers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."custom_options" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."exchange_rates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."invitations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."orders" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."product_images" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."product_tags" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."product_variants" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."products" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "public insert orders" ON "public"."consumer_orders" FOR INSERT WITH CHECK (true);



CREATE POLICY "public read categories" ON "public"."categories" FOR SELECT USING (true);



CREATE POLICY "public read options" ON "public"."custom_options" FOR SELECT USING (true);



CREATE POLICY "public read product_images" ON "public"."product_images" FOR SELECT USING (true);



CREATE POLICY "public read product_tags" ON "public"."product_tags" FOR SELECT USING (true);



CREATE POLICY "public read products" ON "public"."products" FOR SELECT USING (true);



CREATE POLICY "public read published" ON "public"."storefront_products" FOR SELECT USING ((("published" = true) OR ("auth"."role"() = 'authenticated'::"text")));



CREATE POLICY "public read tags" ON "public"."tags" FOR SELECT USING (true);



CREATE POLICY "public read variants" ON "public"."product_variants" FOR SELECT USING (true);



ALTER TABLE "public"."storefront_products" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."stores" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tags" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_store_roles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "users insert own profile" ON "public"."consumers" FOR INSERT WITH CHECK (("auth"."uid"() = "id"));



CREATE POLICY "users read own profile" ON "public"."consumers" FOR SELECT USING (("auth"."uid"() = "id"));



CREATE POLICY "users update own profile" ON "public"."consumers" FOR UPDATE USING (("auth"."uid"() = "id"));





ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";





GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";































































































































































GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_admin"() TO "postgres";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "service_role";


















GRANT ALL ON TABLE "public"."categories" TO "postgres";
GRANT ALL ON TABLE "public"."categories" TO "anon";
GRANT ALL ON TABLE "public"."categories" TO "authenticated";
GRANT ALL ON TABLE "public"."categories" TO "service_role";



GRANT ALL ON SEQUENCE "public"."categories_id_seq" TO "postgres";
GRANT ALL ON SEQUENCE "public"."categories_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."categories_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."categories_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."consumer_orders" TO "anon";
GRANT ALL ON TABLE "public"."consumer_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."consumer_orders" TO "service_role";



GRANT ALL ON SEQUENCE "public"."consumer_orders_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."consumer_orders_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."consumer_orders_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."consumers" TO "postgres";
GRANT ALL ON TABLE "public"."consumers" TO "anon";
GRANT ALL ON TABLE "public"."consumers" TO "authenticated";
GRANT ALL ON TABLE "public"."consumers" TO "service_role";



GRANT ALL ON TABLE "public"."custom_options" TO "anon";
GRANT ALL ON TABLE "public"."custom_options" TO "authenticated";
GRANT ALL ON TABLE "public"."custom_options" TO "service_role";



GRANT ALL ON SEQUENCE "public"."custom_options_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."custom_options_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."custom_options_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."exchange_rates" TO "anon";
GRANT ALL ON TABLE "public"."exchange_rates" TO "authenticated";
GRANT ALL ON TABLE "public"."exchange_rates" TO "service_role";



GRANT ALL ON TABLE "public"."history" TO "anon";
GRANT ALL ON TABLE "public"."history" TO "authenticated";
GRANT ALL ON TABLE "public"."history" TO "service_role";



GRANT ALL ON SEQUENCE "public"."history_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."history_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."history_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."invitations" TO "postgres";
GRANT ALL ON TABLE "public"."invitations" TO "anon";
GRANT ALL ON TABLE "public"."invitations" TO "authenticated";
GRANT ALL ON TABLE "public"."invitations" TO "service_role";



GRANT ALL ON TABLE "public"."orders" TO "anon";
GRANT ALL ON TABLE "public"."orders" TO "authenticated";
GRANT ALL ON TABLE "public"."orders" TO "service_role";



GRANT ALL ON SEQUENCE "public"."orders_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."orders_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."orders_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."product_images" TO "postgres";
GRANT ALL ON TABLE "public"."product_images" TO "anon";
GRANT ALL ON TABLE "public"."product_images" TO "authenticated";
GRANT ALL ON TABLE "public"."product_images" TO "service_role";



GRANT ALL ON SEQUENCE "public"."product_images_id_seq" TO "postgres";
GRANT ALL ON SEQUENCE "public"."product_images_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."product_images_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."product_images_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."product_tags" TO "postgres";
GRANT ALL ON TABLE "public"."product_tags" TO "anon";
GRANT ALL ON TABLE "public"."product_tags" TO "authenticated";
GRANT ALL ON TABLE "public"."product_tags" TO "service_role";



GRANT ALL ON TABLE "public"."product_variants" TO "anon";
GRANT ALL ON TABLE "public"."product_variants" TO "authenticated";
GRANT ALL ON TABLE "public"."product_variants" TO "service_role";



GRANT ALL ON SEQUENCE "public"."product_variants_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."product_variants_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."product_variants_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."products" TO "anon";
GRANT ALL ON TABLE "public"."products" TO "authenticated";
GRANT ALL ON TABLE "public"."products" TO "service_role";



GRANT ALL ON SEQUENCE "public"."products_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."products_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."products_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."storefront_products" TO "anon";
GRANT ALL ON TABLE "public"."storefront_products" TO "authenticated";
GRANT ALL ON TABLE "public"."storefront_products" TO "service_role";



GRANT ALL ON SEQUENCE "public"."storefront_products_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."storefront_products_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."storefront_products_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."stores" TO "postgres";
GRANT ALL ON TABLE "public"."stores" TO "anon";
GRANT ALL ON TABLE "public"."stores" TO "authenticated";
GRANT ALL ON TABLE "public"."stores" TO "service_role";



GRANT ALL ON SEQUENCE "public"."stores_id_seq" TO "postgres";
GRANT ALL ON SEQUENCE "public"."stores_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."stores_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."stores_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."tags" TO "postgres";
GRANT ALL ON TABLE "public"."tags" TO "anon";
GRANT ALL ON TABLE "public"."tags" TO "authenticated";
GRANT ALL ON TABLE "public"."tags" TO "service_role";



GRANT ALL ON SEQUENCE "public"."tags_id_seq" TO "postgres";
GRANT ALL ON SEQUENCE "public"."tags_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."tags_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."tags_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."user_store_roles" TO "postgres";
GRANT ALL ON TABLE "public"."user_store_roles" TO "anon";
GRANT ALL ON TABLE "public"."user_store_roles" TO "authenticated";
GRANT ALL ON TABLE "public"."user_store_roles" TO "service_role";



GRANT ALL ON SEQUENCE "public"."user_store_roles_id_seq" TO "postgres";
GRANT ALL ON SEQUENCE "public"."user_store_roles_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."user_store_roles_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."user_store_roles_id_seq" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































