-- US-2352 follow-up: the self-audit row was landing inside its own result set.
--
-- MY BUG, shipped in 00517 and applied to prod before it was caught. 00517 wrote
-- the `audit_log.search` row BEFORE running the search, in the same function and
-- therefore the same statement. Under READ COMMITTED the new row is visible to
-- the SELECT that follows it, so every call polluted its own answer:
--
--   • `total_count` is a window `count(*) over ()` and grew by one on EVERY
--     call, so the console's page count climbed as you browsed;
--   • the ORDER BY is `created_at desc` and the new row sorts FIRST, so it
--     displaced everything by one position. Page 0 returned the new row plus
--     originals 1-24; turning to page 1 inserted another row and `offset 25`
--     then returned originals 24-48 — one DUPLICATED row per page turn, and one
--     row skipped for each earlier insert.
--
-- Nothing was lost and nothing was mis-recorded: the audit rows are correct and
-- the log is intact. What was wrong is the READING of it, which on an audit
-- surface is bad in its own way — a forensic list that quietly repeats and skips
-- rows is worse than one that is obviously broken.
--
-- THE FIX is an ordering one. `RETURN QUERY` executes its query immediately and
-- appends the rows to the function's result set; execution then CONTINUES. So
-- moving the insert after it means the search runs against the state that
-- existed when the caller asked, and the audit row still lands.
--
-- ALSO FIXED HERE: `actor_role` was left NULL on these rows. Every other writer
-- sets it — lib/audit-log.ts and the 00065 triggers — so a filter on actor_role
-- silently skipped them and the CSV export showed a blank column.
--
-- WHAT THIS STILL CANNOT DO, stated because 00517's header over-claimed it. A
-- REJECTED call records nothing. The guard raises, the exception aborts the
-- statement, and any row written before it rolls back with everything else —
-- reordering does not help, and an autonomous transaction is not available here.
-- So AC3 covers calls that SUCCEED. The devtools attack 00517's header describes
-- is now blocked, but it is blocked SILENTLY, and catching the attempt itself
-- needs the attempt to be observed somewhere that does not roll back: the
-- Postgres log, or moving the read behind the edge. That is a real gap and it
-- belongs to whoever picks up the "move the console read to the edge" work.

create or replace function public.admin_audit_log_search(
  p_search      text default null,
  p_admin       uuid default null,
  p_action      text default null,
  p_target_type text default null,
  p_from        timestamptz default null,
  p_to          timestamptz default null,
  p_limit       int default 25,
  p_offset      int default 0
)
returns table (
  id            uuid,
  admin_user_id uuid,
  actor_role    text,
  action        text,
  target_type   text,
  target_id     uuid,
  details       jsonb,
  ip            text,
  user_agent    text,
  created_at    timestamptz,
  total_count   bigint
)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_is_service boolean := auth.role() = 'service_role';
  v_max    int := case when v_is_service then 50000 else 500 end;
  v_limit  int := least(greatest(coalesce(p_limit, 25), 1), v_max);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_like   text;
  v_role   text;
begin
  if not (v_is_service or public.is_super_admin()) then
    raise exception 'admin_audit_log_search: super_admin role required'
      using errcode = '42501';
  end if;

  v_like := case when v_search is null then null else '%' || v_search || '%' end;

  -- The search runs FIRST, against the state the caller asked about. RETURN
  -- QUERY appends to the result set and execution continues, so the self-audit
  -- below still happens — it just no longer appears in its own answer.
  return query
  with filtered as (
    select
      a.id, a.admin_user_id, a.actor_role, a.action, a.target_type,
      a.target_id, a.details, a.ip, a.user_agent, a.created_at,
      count(*) over () as total_count
    from public.admin_audit_log a
    where (p_admin is null or a.admin_user_id = p_admin)
      and (p_action is null or a.action = p_action)
      and (p_target_type is null or a.target_type = p_target_type)
      and (p_from is null or a.created_at >= p_from)
      and (p_to is null or a.created_at <= p_to)
      and (
        v_like is null
        or a.action ilike v_like
        or a.target_type ilike v_like
        or coalesce(a.target_id::text, '') ilike v_like
        or coalesce(a.details::text, '') ilike v_like
      )
    order by a.created_at desc
    limit v_limit offset v_offset
  )
  select * from filtered;

  -- US-2352 AC3: a direct RPC call records itself, so the way around the export
  -- route's gate is not also the way around the record. Service-role calls are
  -- left to the edge route's own audit_log.export row — recording both would
  -- double-count every export.
  if not v_is_service then
    select u.role into v_role from public.users u where u.id = auth.uid();
    insert into public.admin_audit_log
      (admin_user_id, actor_role, action, target_type, target_id, details)
    values (
      auth.uid(),
      v_role,
      'audit_log.search',
      'admin_audit_log',
      null,
      jsonb_build_object(
        'via', 'rpc',
        'limit', v_limit,
        'offset', v_offset,
        'filters', jsonb_strip_nulls(jsonb_build_object(
          'search', v_search,
          'admin', p_admin,
          'action', p_action,
          'target_type', p_target_type,
          'from', p_from,
          'to', p_to
        ))
      )
    );
  end if;

  return;
end;
$$;

comment on function public.admin_audit_log_search(
  text, uuid, text, text, timestamptz, timestamptz, int, int
) is
  'US-905 search, hardened by US-2352 and corrected by 00518: SUPER_ADMIN (or '
  'service_role) only; p_limit capped at 500 for browser callers and 50000 for '
  'the service-role export; a non-service-role call writes its own '
  'audit_log.search row AFTER the search runs, so it does not appear in its own '
  'result set. A REJECTED call records nothing — the exception rolls it back.';

grant execute on function public.admin_audit_log_search(
  text, uuid, text, text, timestamptz, timestamptz, int, int
) to authenticated;
grant execute on function public.admin_audit_log_search(
  text, uuid, text, text, timestamptz, timestamptz, int, int
) to service_role;

insert into public.applied_migrations (version) values ('00518') on conflict do nothing;
