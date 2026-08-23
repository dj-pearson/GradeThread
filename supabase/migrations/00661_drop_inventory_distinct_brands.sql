-- 00661: drop inventory_distinct_brands and the index that exists only for it.
--
-- US-2814, owner's decision 2026-08-23. The function (00482) was written for the
-- Inventory brand dropdown; US-958 rewrote that page into a lazy view router and
-- the dropdown went with it. Nothing has called the function since - not a
-- client, not an edge route, not another function - while
-- idx_inventory_items_user_brand has been maintained on every inventory_items
-- insert and every brand update to support a DISTINCT scan nobody runs.
--
-- The two brand dropdowns that still exist de-duplicate over row sets their page
-- has already loaded in full, so they are complete and cost nothing extra. The
-- feared regression did not happen; that was checked before this was written.
--
-- DROP, NOT REVOKE, and the difference is load-bearing here. A REVOKE on a
-- function anon or authenticated can still reach segfaults this Postgres
-- (US-2403), which is why no new migration in this repo revokes. Dropping the
-- function removes it entirely: a call would answer 42883 "function does not
-- exist", an ordinary error, and there is no caller to make one.
--
-- REVERSIBLE, and the reasoning is preserved rather than lost. If a future
-- server-paginated inventory view wants a COMPLETE brand list, this function is
-- exactly right and PostgREST cannot express DISTINCT - so re-adding it is a
-- small migration, and 00482's header plus US-2814's notes carry why it existed.

DROP INDEX IF EXISTS public.idx_inventory_items_user_brand;

DROP FUNCTION IF EXISTS public.inventory_distinct_brands();

insert into public.applied_migrations (version) values ('00661') on conflict do nothing;
