-- flipdesk-inventory plan action 7: the Sources page counts items per source
-- in SQL.
--
-- The page used to read inventory_items.source_id for EVERY row the caller
-- could see, with no range and no paging, and count them in the browser. That
-- is one row per item just to print a number, it runs into the 8s statement
-- timeout on a large catalog, and under any row cap the delete dialog would
-- under-report how many items get unlinked (vault/10-ops/postgrest-row-cap.md:
-- "page until empty, count without rows, or aggregate in SQL").
--
-- SECURITY INVOKER, so inventory_items RLS still decides which rows are
-- counted: an owner sees their own, a workspace member sees the owner's, and a
-- stranger passing someone else's id gets no rows at all. The p_user_id
-- filter narrows to one workspace; it is not the tenant boundary, RLS is.
-- No table change, no index change (idx_inventory_items_source_id exists).

create or replace function public.source_item_counts(p_user_id uuid)
returns table (source_id uuid, item_count bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select i.source_id, count(*)::bigint as item_count
  from public.inventory_items i
  where i.user_id = p_user_id
    and i.source_id is not null
  group by i.source_id
$$;

-- No REVOKE from anon or public, on purpose (US-2403): on this Postgres image a
-- denied function call from a supautils.hint_roles role segfaults the backend.
-- Nothing is lost by leaving it callable: the function is an INVOKER, and anon
-- matches no inventory_items SELECT policy, so an anon call returns no rows.
grant execute on function public.source_item_counts(uuid) to authenticated, service_role;

comment on function public.source_item_counts(uuid) is
  'Items linked to each source in one workspace. SECURITY INVOKER: inventory_items RLS decides what is counted.';

insert into public.applied_migrations (version) values ('00831') on conflict do nothing;
