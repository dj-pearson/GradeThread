-- US-906: real-time ops activity feed + critical-event alerting.
--
-- A single operator-facing stream of significant platform events (job failures,
-- AI budget kills, fraud signals, billing-reconciliation divergences, maintenance
-- toggles, …). emitOpsEvent() (lib/ops-events.ts) appends here and, for
-- severity >= warning, fans the event out to the configured channels (email +
-- generic webhook from the settings registry). The admin Activity Feed reads it;
-- the nav badge counts unacknowledged critical events.
--
-- This adds:
--   1. ops_events — the append-mostly event stream (OPERATOR surface: deny-all
--      RLS, service-role only; the SPA reads it only via the role-gated admin
--      endpoints, never directly). Triage = acknowledge (open -> acknowledged).
--   2. webhook_dead_letters: allow an 'ops-alert' provider so a failed alert
--      webhook delivery lands in the SAME dead-letter console (AC#6) for
--      visibility (not auto-replayable; replay stays Stripe/content-only).
--   3. Settings-registry keys (system_settings) so the alert channels + routing
--      are editable WITHOUT a deploy.

-- ────────────────────────────────────────────────────────────────────
-- 1. ops_events — operator event stream (deny-all RLS, service-role only)
-- ────────────────────────────────────────────────────────────────────
create table if not exists public.ops_events (
  id            uuid primary key default gen_random_uuid(),
  -- Dotted event type, e.g. 'job.failed', 'ai_budget.kill', 'fraud.signal',
  -- 'billing.reconciliation', 'maintenance.activated'. Free text (callers own
  -- the taxonomy) so a new emit site needs no enum migration.
  type          text not null,
  severity      text not null default 'info'
                  check (severity in ('info', 'warning', 'critical')),
  -- Human-readable one-liner for the feed.
  title         text not null,
  -- Where it originated (cron job name, 'maintenance', 'manual', …).
  source        text,
  -- The acting admin, when human-initiated (maintenance toggle, test event).
  -- Nullable + NOT a tenant key: this is a platform operator surface, never
  -- user-owned data.
  actor_user_id uuid references public.users(id) on delete set null,
  -- Structured context (ids, counts, names) for the detail view.
  payload       jsonb not null default '{}'::jsonb,
  -- Whether a fan-out to alert channels was attempted (severity >= configured
  -- minimum and not a muted type) and whether at least one channel delivered.
  fanned_out    boolean not null default false,
  delivered     boolean not null default false,
  -- Triage lifecycle: an unacknowledged critical event drives the nav badge.
  acknowledged_at timestamptz,
  acknowledged_by uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now()
);

-- Feed reads newest-first; the badge counts unacknowledged critical events.
create index if not exists idx_ops_events_created
  on public.ops_events(created_at desc);
create index if not exists idx_ops_events_unacked
  on public.ops_events(severity, acknowledged_at)
  where acknowledged_at is null;
create index if not exists idx_ops_events_type
  on public.ops_events(type);

-- RLS enabled with ZERO policies by design: anon/authenticated get nothing and
-- only the service-role edge client (emitter + admin console endpoints) reads or
-- writes it. Most restrictive configuration, not a gap. (Classified in
-- rls-guard_test.ts SERVICE_ROLE_ONLY.)
alter table public.ops_events enable row level security;
revoke all on public.ops_events from anon, authenticated;

comment on table public.ops_events is
  'US-906: operator activity-feed event stream (job failures, AI budget kills, '
  'fraud signals, billing-reconciliation, maintenance toggles). Appended by '
  'emitOpsEvent(); service-role only, deny-all RLS.';

-- ────────────────────────────────────────────────────────────────────
-- 2. Let a failed alert webhook dead-letter in the unified DLQ (AC#6)
-- ────────────────────────────────────────────────────────────────────
-- The inline column CHECK was extended in 00206; re-extend it to add the
-- 'ops-alert' provider so a failed ops-alert webhook POST lands in the same
-- dead-letter console for visibility. Not auto-replayable (isWebhookReplayable
-- keeps replay to stripe/content) — a record-for-visibility, not a re-delivery.
alter table public.webhook_dead_letters
  drop constraint if exists webhook_dead_letters_provider_check;
alter table public.webhook_dead_letters
  add constraint webhook_dead_letters_provider_check
  check (provider in ('stripe', 'ebay', 'appstore', 'content', 'ops-alert'));

-- ────────────────────────────────────────────────────────────────────
-- 3. Configurable alert channels + routing in the settings registry
-- ────────────────────────────────────────────────────────────────────
insert into public.system_settings (key, value, value_type, default_value, category, description)
values
  (
    'ops_alert_enabled',
    to_jsonb(true), 'bool', to_jsonb(true), 'observability',
    'US-906: master switch for fanning ops events out to alert channels. When '
    'off, events are still recorded to the feed but no email/webhook is sent.'
  ),
  (
    'ops_alert_min_severity',
    to_jsonb('warning'::text), 'string', to_jsonb('warning'::text), 'observability',
    'US-906: minimum event severity (info | warning | critical) that fans out to '
    'the alert channels. Events below this are feed-only.'
  ),
  (
    'ops_alert_webhook_url',
    to_jsonb(''::text), 'string', to_jsonb(''::text), 'observability',
    'US-906: generic outbound webhook (Slack/PagerDuty/etc.) for critical ops '
    'alerts. Empty falls back to the MONITOR_ALERT_WEBHOOK env var.'
  ),
  (
    'ops_alert_email',
    to_jsonb(''::text), 'string', to_jsonb(''::text), 'observability',
    'US-906: recipient for ops alert emails. Empty falls back to '
    'MONITOR_ALERT_EMAIL / SMTP_ADMIN_EMAIL.'
  ),
  (
    'ops_alert_muted_types',
    to_jsonb('[]'::jsonb), 'json', to_jsonb('[]'::jsonb), 'observability',
    'US-906: array of event types to suppress fan-out for (still recorded to the '
    'feed). Per-type routing override, e.g. ["job.failed"].'
  )
on conflict (key) do nothing;
