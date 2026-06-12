-- US-404: Server-side grouped tab counts for the inventory surfaces.
--
-- The inventory pages (listings / grid / analytics) previously derived their
-- stage-tab counts by loading the ENTIRE wide items_full view into the browser
-- and counting rows in JS. As those surfaces move to slim, paginated loads
-- (US-404) the full set is no longer held in memory, so the tab counts must
-- come from a grouped count query instead of from the loaded rows.
--
-- This function returns one row-count per inventory_items.status as a compact
-- JSON object, e.g. {"sourced": 12, "listed": 340, "sold": 88, ...}. The UI
-- maps those statuses onto its stage tabs (a tab like "To List" sums several
-- statuses client-side). One grouped aggregate replaces a multi-megabyte
-- full-table transfer.
--
-- SECURITY INVOKER: the function runs as the caller, so the existing owner +
-- workspace-member RLS on inventory_items applies unchanged — a user only ever
-- counts their own (or their workspace owner's) items. No new data is exposed.

create or replace function public.inventory_status_counts()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(jsonb_object_agg(status, cnt), '{}'::jsonb)
  from (
    select status::text as status, count(*)::int as cnt
    from public.inventory_items
    group by status
  ) s;
$$;

comment on function public.inventory_status_counts() is
  'US-404: per-status inventory_items row counts as jsonb, for server-side '
  'stage-tab counts. SECURITY INVOKER so RLS scopes counts to the caller.';

grant execute on function public.inventory_status_counts() to authenticated;
grant execute on function public.inventory_status_counts() to service_role;
