-- US-2023 AC2: distinct-brand filter without scanning every inventory row.
--
-- inventory.tsx populated its brand dropdown by selecting `brand` for EVERY
-- inventory_items row in the tenant and de-duplicating ~200 strings in the
-- browser. PostgREST cannot express DISTINCT, and the client-side workarounds
-- (a LIMIT, or sampling) would silently DROP brands from the filter — trading a
-- correctness regression for a performance win. So it needs an RPC.
--
-- SECURITY: SECURITY INVOKER (the default). This deliberately does NOT use
-- SECURITY DEFINER — running as the caller means the existing RLS policy on
-- inventory_items applies unchanged, so the function cannot return another
-- tenant's brands even if it is called with a forged argument. There is no
-- user_id parameter for exactly that reason: the tenant comes from auth.uid()
-- via RLS, never from the caller.

CREATE OR REPLACE FUNCTION public.inventory_distinct_brands()
RETURNS TABLE (brand text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT DISTINCT i.brand
  FROM public.inventory_items i
  WHERE i.brand IS NOT NULL
    AND btrim(i.brand) <> ''
  ORDER BY i.brand;
$$;

COMMENT ON FUNCTION public.inventory_distinct_brands() IS
  'Distinct non-blank brands visible to the caller, for the Inventory brand filter (US-2023). SECURITY INVOKER so RLS scopes it to the caller''s tenant.';

GRANT EXECUTE ON FUNCTION public.inventory_distinct_brands() TO authenticated;

-- Supports the DISTINCT scan.
CREATE INDEX IF NOT EXISTS idx_inventory_items_user_brand
  ON public.inventory_items(user_id, brand)
  WHERE brand IS NOT NULL;

insert into public.applied_migrations (version) values ('00482') on conflict do nothing;
