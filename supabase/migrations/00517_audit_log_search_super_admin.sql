-- US-2352: the audit-log search RPC enforces the gate its route claims.
--
-- THE HOLE. The edge route GET /api/admin/audit/export restricts itself to
-- super_admin and writes an `audit_log.export` row for every download. The RPC
-- it wraps, admin_audit_log_search (00227), was guarded only by is_admin(),
-- granted to `authenticated`, and accepted p_limit up to 50,000 — and the
-- console calls it from the BROWSER client. So any plain admin could open
-- devtools, call the RPC directly with p_limit 50000, and take the entire
-- forensic log — every other admin's IP addresses, user agents and `details`
-- payloads — leaving no export row behind. The route's gate and its self-audit
-- were both decoration to anyone willing to skip the route.
--
-- THE FIX, and why it is enforcement rather than a narrower grant. Revoking the
-- `authenticated` grant would also break the console's own 25-row paginated
-- list, forcing that read through the edge in the same change — a bigger job
-- than the security fix needs, and a bigger diff to get wrong. Enforcing
-- super_admin INSIDE the function closes the hole without moving anything.
--
-- TWO CEILINGS, NOT ONE. 50,000 exists solely for the export path, which runs as
-- service_role behind the super_admin route gate. A browser caller has no use
-- for more than a page, so it now gets a console-sized cap. Bulk extraction
-- through the RPC is therefore bounded even for a super_admin whose session is
-- stolen.
--
-- AC3 — every call recorded. A direct RPC call now writes its own audit row, so
-- the RPC path is no longer the quiet one. Service-role calls are NOT recorded
-- here: the edge route already writes `audit_log.export` with the format and row
-- count, and recording both would double-count every export and make the log
-- disagree with itself.
--
-- This makes the function VOLATILE. It was STABLE, and a STABLE function cannot
-- write — the recording is what forces the change. The function is called once
-- per request from a low-QPS admin surface, so nothing depended on the planner
-- treating it as stable.
--
-- SCOPE, stated so the next reader does not over-read this. The same
-- "granted to authenticated, guarded by is_admin()" shape appears on fifteen
-- SECURITY DEFINER functions. Fourteen are NOT bugs: thirteen are read-only
-- analytics an admin is meant to read, and is_workspace_member must stay
-- callable by authenticated or the RLS policies that call it break. The pattern
-- is a defect only where a STRICTER control sits in front of the RPC that the
-- RPC does not itself enforce. Today that is this function alone.

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
  -- The service-role edge client backs the forensic EXPORT and keeps the high
  -- cap; every other caller is a console page and is capped accordingly.
  v_is_service boolean := auth.role() = 'service_role';
  v_max    int := case when v_is_service then 50000 else 500 end;
  v_limit  int := least(greatest(coalesce(p_limit, 25), 1), v_max);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_like   text;
begin
  -- US-2352: super_admin, not merely admin. The route in front of the export
  -- required super_admin and the function did not, so the route was skippable.
  if not (v_is_service or public.is_super_admin()) then
    raise exception 'admin_audit_log_search: super_admin role required'
      using errcode = '42501';
  end if;

  -- US-2352 AC3: a direct RPC call records itself. Service-role calls are left
  -- to the edge route's own audit_log.export row — writing both would
  -- double-count every export.
  if not v_is_service then
    insert into public.admin_audit_log (admin_user_id, action, target_type, target_id, details)
    values (
      auth.uid(),
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

  v_like := case when v_search is null then null else '%' || v_search || '%' end;

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
end;
$$;

comment on function public.admin_audit_log_search(
  text, uuid, text, text, timestamptz, timestamptz, int, int
) is
  'US-905 search, hardened by US-2352: SUPER_ADMIN (or service_role) only, '
  'p_limit capped at 500 for browser callers and 50000 for the service-role '
  'export, and every non-service-role call writes its own audit_log.search row.';

-- The filter-options helper feeds the same super-admin-only page and leaks the
-- roster of admins and the vocabulary of actions. Same gate, no self-audit: it
-- returns no log rows, so there is nothing to exfiltrate through it.
--
-- Reproduced from 00147 with ONE line changed (the guard). The body, the
-- `returns jsonb` type and the ordering are byte-for-byte the original: CREATE
-- OR REPLACE cannot change a return type, and rewriting the shape here would
-- break the console's dropdowns for a security fix that does not need to touch
-- them.
create or replace function public.admin_audit_log_filter_options()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  -- US-2352: super_admin, matching the search RPC above and the page they feed.
  if not (auth.role() = 'service_role' or public.is_super_admin()) then
    raise exception 'admin_audit_log_filter_options: super_admin role required'
      using errcode = '42501';
  end if;

  select jsonb_build_object(
    'actions', coalesce((
      select jsonb_agg(action order by action)
      from (select distinct action from public.admin_audit_log) a
    ), '[]'::jsonb),
    'targetTypes', coalesce((
      select jsonb_agg(target_type order by target_type)
      from (select distinct target_type from public.admin_audit_log) t
    ), '[]'::jsonb),
    'admins', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', u.id,
        'label', coalesce(nullif(u.full_name, ''), u.email, u.id::text)
      ) order by coalesce(nullif(u.full_name, ''), u.email, u.id::text))
      from (
        select distinct admin_user_id from public.admin_audit_log
        where admin_user_id is not null
      ) d
      join public.users u on u.id = d.admin_user_id
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

comment on function public.admin_audit_log_filter_options() is
  'US-415 filter options, hardened by US-2352: super_admin (or service_role) '
  'only - it exposes the admin roster and the action vocabulary of the audit '
  'log, which is the same surface the search RPC now protects.';

-- Grants are unchanged on purpose: `authenticated` still holds EXECUTE because
-- the console calls both from the browser. The authorisation now lives in the
-- function bodies, where a caller cannot route around it.
grant execute on function public.admin_audit_log_search(
  text, uuid, text, text, timestamptz, timestamptz, int, int
) to authenticated;
grant execute on function public.admin_audit_log_search(
  text, uuid, text, text, timestamptz, timestamptz, int, int
) to service_role;
grant execute on function public.admin_audit_log_filter_options() to authenticated;
grant execute on function public.admin_audit_log_filter_options() to service_role;

insert into public.applied_migrations (version) values ('00517') on conflict do nothing;
