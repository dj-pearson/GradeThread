-- US-2029 AC1: discover equity-snapshot owners without a global table scan.
--
-- The nightly job found "owners holding unsold inventory" by selecting user_id
-- from inventory_items with .not('status','in',(sold,shipped,completed,archived)),
-- pulling up to 20,000 rows across ALL tenants and de-duplicating in JS. Two
-- problems: a NOT IN over four enum values will not use
-- idx_inventory_items_status, so it is a nightly sequential scan on the largest
-- table; and the 20,000-row cap is applied to ROWS, not owners, so past that
-- point owners are silently dropped — one seller with 20,000 unsold items would
-- starve every other seller out of the snapshot. That failure is invisible: the
-- job reports success and those sellers' equity trend simply goes flat.
--
-- SECURITY DEFINER is correct here, unlike 00482's brand RPC. This is called by
-- the equity-snapshot CRON through the service-role client, which already
-- bypasses RLS — it is a platform-wide aggregate BY DESIGN, not a tenant query.
-- It is therefore NOT granted to `authenticated`: a seller has no business
-- enumerating which other users hold inventory. Only service_role may execute.

CREATE OR REPLACE FUNCTION public.equity_snapshot_owners(p_limit integer DEFAULT 20000)
RETURNS TABLE (user_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT i.user_id
  FROM public.inventory_items i
  WHERE i.user_id IS NOT NULL
    AND i.status NOT IN ('sold', 'shipped', 'completed', 'archived')
  ORDER BY i.user_id
  LIMIT GREATEST(COALESCE(p_limit, 20000), 1);
$$;

COMMENT ON FUNCTION public.equity_snapshot_owners(integer) IS
  'US-2029: distinct owners holding unsold inventory, for the nightly equity snapshot. The limit bounds OWNERS, not rows — the previous client-side version capped rows, so a single large seller could starve others out of the snapshot entirely. SECURITY DEFINER + service_role only: a platform-wide aggregate, never a tenant query.';

REVOKE ALL ON FUNCTION public.equity_snapshot_owners(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.equity_snapshot_owners(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.equity_snapshot_owners(integer) TO service_role;

-- Supports the DISTINCT over the unsold predicate. Partial, so it indexes only
-- the rows the job actually looks at rather than the whole table.
CREATE INDEX IF NOT EXISTS idx_inventory_items_unsold_owner
  ON public.inventory_items (user_id)
  WHERE status NOT IN ('sold', 'shipped', 'completed', 'archived');

insert into public.applied_migrations (version) values ('00485') on conflict do nothing;
