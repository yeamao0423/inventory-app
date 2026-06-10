-- ============================================
-- Migration: Stock deduction RPC functions
-- Run this in Supabase Dashboard → SQL Editor
-- ============================================

-- Decrement variant stock (won't go below 0)
CREATE OR REPLACE FUNCTION public.decrement_variant_stock(vid bigint, qty integer)
RETURNS void AS $$
BEGIN
  UPDATE public.product_variants
  SET stock = GREATEST(0, stock - qty)
  WHERE id = vid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Decrement base product stock (won't go below 0)
CREATE OR REPLACE FUNCTION public.decrement_product_stock(pid bigint, qty integer)
RETURNS void AS $$
BEGIN
  UPDATE public.products
  SET quantity = GREATEST(0, quantity - qty)
  WHERE id = pid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
