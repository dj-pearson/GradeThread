-- Make items_full view respect RLS on the underlying tables and grant
-- explicit SELECT to authenticated.
--
-- Why: A plain PostgreSQL view runs as its owner (postgres), which bypasses
-- RLS. Either RLS doesn't filter (privacy bug — user sees other users' rows)
-- or the authenticated role lacks SELECT and the query 403s. We want neither.
--
-- security_invoker = on (PG 15+) makes the view run as the caller, so RLS on
-- the underlying tables (inventory_items, sources, listings, sales) applies.

ALTER VIEW public.items_full SET (security_invoker = on);

-- Be explicit about grants. Supabase auto-grants new tables to the
-- authenticated/anon roles via default privileges, but views are not always
-- covered.
GRANT SELECT ON public.items_full TO authenticated;
GRANT SELECT ON public.items_full TO anon;
