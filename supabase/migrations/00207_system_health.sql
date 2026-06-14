-- US-883: System health & infrastructure dashboard.
--
-- Gives operators a single live view of platform health — DB table sizes/row
-- counts, storage bucket usage, queue/DLQ depths, open disputes/reviews, recent
-- job failures and the slowest recent jobs — so a problem is visible before a
-- customer reports it.
--
-- Two pieces:
--   1. system_settings — a minimal, generic key→jsonb registry. The health
--      thresholds (DLQ depth, storage %, error rate, …) live here so they're
--      tunable WITHOUT a deploy (AC#4). This is the seed of the broader settings
--      registry (US-884 builds the editor UI on top of the same table).
--   2. system_health() — a SECURITY DEFINER, admin-gated RPC returning one
--      compact jsonb document with every number the dashboard renders.

-- ── 1. system_settings registry ───────────────────────────────────────────
create table if not exists public.system_settings (
  key         text primary key,
  value       jsonb not null,
  description text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.users(id)
);

comment on table public.system_settings is
  'US-883: generic key→jsonb platform settings registry (DB-backed, deploy-free '
  'tuning). Seeded with ops_health_thresholds; US-884 adds the admin editor.';

-- updated_at maintenance (project-wide trigger convention).
create or replace function public.set_system_settings_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_system_settings_updated_at on public.system_settings;
create trigger trg_system_settings_updated_at
  before update on public.system_settings
  for each row execute function public.set_system_settings_updated_at();

-- Admin-only resource. RLS on with NO client policies → deny-all for
-- anon/authenticated; the admin endpoints read/write via the service-role
-- client (which bypasses RLS) and are role-gated at the API layer.
alter table public.system_settings enable row level security;
revoke all on public.system_settings from anon, authenticated;

-- Seed the health thresholds with sensible defaults. `on conflict do nothing`
-- so a re-run (or a later override) is never clobbered.
insert into public.system_settings (key, value, description) values (
  'ops_health_thresholds',
  jsonb_build_object(
    'webhookDlqOpen',    jsonb_build_object('amber', 1,     'red', 25),
    'emailDlqOpen',      jsonb_build_object('amber', 1,     'red', 25),
    'disputesOpen',      jsonb_build_object('amber', 5,     'red', 20),
    'reviewsOpen',       jsonb_build_object('amber', 10,    'red', 50),
    'jobFailures24h',    jsonb_build_object('amber', 1,     'red', 10),
    'storagePct',        jsonb_build_object('amber', 70,    'red', 90),
    'storageBytesCapGb', 50,
    'slowestJobMs',      jsonb_build_object('amber', 30000, 'red', 120000)
  ),
  'US-883: amber/red thresholds for the system health dashboard tiles.'
) on conflict (key) do nothing;

-- ── 2. system_health() RPC ─────────────────────────────────────────────────
-- SECURITY DEFINER so it can read cross-tenant aggregates + pg_catalog +
-- storage.objects (the caller's RLS would hide most of this). The guard allows
-- the service_role (the already-role-gated /api/admin/ops/health endpoint calls
-- via the service-role client, where auth.uid() is null) OR an admin user
-- calling directly — anon/regular users are rejected, so definer rights never
-- leak data to a non-admin.
create or replace function public.system_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
  hot_tables constant text[] := array[
    'submissions', 'grade_reports', 'submission_images', 'inventory_items',
    'listings', 'sales', 'item_photos', 'cron_runs', 'email_deliveries',
    'webhook_dead_letters', 'admin_audit_log', 'users'
  ];
begin
  if not (auth.role() = 'service_role' or public.is_admin()) then
    raise exception 'system_health: admin role required' using errcode = '42501';
  end if;

  select jsonb_build_object(
    -- Estimated row counts (pg_stat_user_tables) + on-disk bytes per hot table.
    'tables', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'name', rel, 'rows', n_live, 'bytes', total_bytes
      ) order by total_bytes desc), '[]'::jsonb)
      from (
        select
          c.relname as rel,
          coalesce(st.n_live_tup, 0)::bigint as n_live,
          pg_total_relation_size(c.oid)::bigint as total_bytes
        from pg_class c
        join pg_namespace ns on ns.oid = c.relnamespace
        left join pg_stat_user_tables st on st.relid = c.oid
        where ns.nspname = 'public'
          and c.relkind = 'r'
          and c.relname = any(hot_tables)
      ) t
    ),
    -- Object count + bytes per storage bucket.
    'storage', (
      select jsonb_build_object(
        'buckets', coalesce((
          select jsonb_agg(jsonb_build_object(
            'bucket', bucket_id, 'objects', cnt, 'bytes', bytes
          ) order by bytes desc)
          from (
            select
              bucket_id,
              count(*)::bigint as cnt,
              coalesce(sum((metadata->>'size')::bigint), 0)::bigint as bytes
            from storage.objects
            group by bucket_id
          ) b
        ), '[]'::jsonb),
        'totalObjects', (select count(*)::bigint from storage.objects),
        'totalBytes', coalesce((
          select sum((metadata->>'size')::bigint)::bigint from storage.objects
        ), 0)
      )
    ),
    -- Open queue / DLQ depths.
    'queues', jsonb_build_object(
      'disputesOpen', (
        select count(*)::int from public.disputes
        where status in ('open', 'under_review')
      ),
      'reviewsOpen', (
        select count(*)::int from public.grade_reports gr
        where gr.needs_human_review = true
          and not exists (
            select 1 from public.human_reviews hr
            where hr.grade_report_id = gr.id
          )
      ),
      'webhookDlqOpen', (
        select count(*)::int from public.webhook_dead_letters
        where status = 'unresolved'
      ),
      'emailDlqOpen', (
        select count(*)::int from public.email_deliveries
        where status = 'dead_letter'
      )
    ),
    -- Recent job health: 24h failure count + slowest recent runs.
    'jobs', jsonb_build_object(
      'failuresLast24h', (
        select count(*)::int from public.cron_runs
        where status = 'error' and created_at >= now() - interval '24 hours'
      ),
      'maxDurationMs', coalesce((
        select max(duration_ms)::int from public.cron_runs
        where created_at >= now() - interval '24 hours'
      ), 0),
      'slowest', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'job', job_name, 'durationMs', duration_ms,
          'status', status, 'at', created_at
        ) order by duration_ms desc nulls last), '[]'::jsonb)
        from (
          select job_name, duration_ms, status, created_at
          from public.cron_runs
          where created_at >= now() - interval '24 hours'
            and duration_ms is not null
          order by duration_ms desc nulls last
          limit 5
        ) s
      )
    ),
    -- Sparkline-style trends (last 7 daily buckets).
    'trends', jsonb_build_object(
      'jobFailuresByDay', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'day', b.bucket, 'count', coalesce(agg.failed, 0)
        ) order by b.bucket), '[]'::jsonb)
        from generate_series(
          date_trunc('day', now()) - interval '6 days',
          date_trunc('day', now()),
          interval '1 day'
        ) as b(bucket)
        left join lateral (
          select count(*)::int as failed
          from public.cron_runs cr
          where cr.status = 'error'
            and cr.created_at >= b.bucket
            and cr.created_at < b.bucket + interval '1 day'
        ) agg on true
      ),
      'submissionErrorsByDay', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'day', b.bucket,
          'total', coalesce(agg.total, 0),
          'failed', coalesce(agg.failed, 0)
        ) order by b.bucket), '[]'::jsonb)
        from generate_series(
          date_trunc('day', now()) - interval '6 days',
          date_trunc('day', now()),
          interval '1 day'
        ) as b(bucket)
        left join lateral (
          select
            count(*)::int as total,
            (count(*) filter (where s.status = 'failed'))::int as failed
          from public.submissions s
          where s.created_at >= b.bucket
            and s.created_at < b.bucket + interval '1 day'
        ) agg on true
      )
    ),
    -- Tunable thresholds (deploy-free; AC#4). Falls back to {} if the row was
    -- removed — the edge merges defaults over whatever is present.
    'thresholds', coalesce(
      (select value from public.system_settings where key = 'ops_health_thresholds'),
      '{}'::jsonb
    ),
    'generatedAt', now()
  ) into result;

  return result;
end;
$$;

comment on function public.system_health() is
  'US-883: one compact jsonb document of platform health (table sizes/rows, '
  'storage usage, queue/DLQ depths, job failures + slowest jobs, trends, '
  'thresholds). SECURITY DEFINER + service_role/is_admin() guard.';

grant execute on function public.system_health() to authenticated;
grant execute on function public.system_health() to service_role;
