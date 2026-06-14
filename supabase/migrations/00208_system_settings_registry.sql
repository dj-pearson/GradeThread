-- US-884: DB-backed system settings registry.
--
-- US-883 (00207) created the generic key→jsonb `system_settings` table seeded
-- with `ops_health_thresholds`. This migration BUILDS ON that table — it does
-- NOT recreate it — turning it into a typed, audited, deploy-free config
-- registry that the admin editor (settings-registry.tsx) renders:
--   • adds value_type (number|bool|string|json), default_value and category so
--     the editor can render type-aware controls + a "reset to default";
--   • backfills the existing row(s);
--   • seeds the first operational constants previously hardcoded in code — the
--     human-review confidence threshold and the /api/grade rate-limit cap — so
--     they can be retuned without a deploy (both are wired to read through the
--     registry in this same change).
--
-- The updated_at audit trigger (trg_system_settings_updated_at) and the
-- service-role-only RLS posture already exist from 00207; we re-assert the RLS
-- grants here for clarity/idempotency.

-- ── 1. Extend the table (additive, idempotent) ─────────────────────────────
alter table public.system_settings
  add column if not exists value_type    text,
  add column if not exists default_value jsonb,
  add column if not exists category      text;

-- Backfill the pre-existing health-thresholds row from 00207.
update public.system_settings
   set value_type    = coalesce(value_type, 'json'),
       default_value = coalesce(default_value, value),
       category      = coalesce(category, 'health')
 where key = 'ops_health_thresholds';

-- Generic backfill so any other pre-existing rows satisfy the NOT NULL below.
update public.system_settings
   set value_type = coalesce(value_type, 'json'),
       category   = coalesce(category, 'general')
 where value_type is null or category is null;

-- Enforce the typed contract now that every row is populated.
alter table public.system_settings
  alter column value_type set not null,
  alter column category   set not null,
  alter column category   set default 'general';

alter table public.system_settings
  drop constraint if exists system_settings_value_type_check;
alter table public.system_settings
  add constraint system_settings_value_type_check
  check (value_type in ('number', 'bool', 'string', 'json'));

comment on column public.system_settings.value_type is
  'US-884: how the jsonb value is interpreted/edited — number|bool|string|json.';
comment on column public.system_settings.default_value is
  'US-884: factory default, used by the admin editor''s "reset to default".';
comment on column public.system_settings.category is
  'US-884: grouping key for the settings editor (e.g. grading, rate_limits, health).';

-- ── 2. Seed the first migrated operational constants ───────────────────────
-- Both are READ THROUGH the registry in this change (lib/ai-config.ts +
-- main.ts), proving the end-to-end wiring. `on conflict do nothing` so a manual
-- override applied before a re-run is never clobbered.
insert into public.system_settings (key, value, value_type, default_value, category, description)
values
  (
    'grading_review_confidence_threshold',
    to_jsonb(0.75::numeric), 'number', to_jsonb(0.75::numeric), 'grading',
    'Confidence (0–1) below which an AI grade is routed to human review. Lower = fewer reviews, higher = more.'
  ),
  (
    'rate_limit_grade_per_min',
    to_jsonb(60), 'number', to_jsonb(60), 'rate_limits',
    'Maximum /api/grade/* requests allowed per user (or IP) per minute.'
  )
on conflict (key) do nothing;

-- ── 3. Re-assert the service-role-only posture (defense in depth) ───────────
-- RLS was enabled in 00207 with NO client policies → deny-all for
-- anon/authenticated; the admin endpoints read/write via the service-role
-- client (bypasses RLS) and are role-gated at the API layer.
alter table public.system_settings enable row level security;
revoke all on public.system_settings from anon, authenticated;
