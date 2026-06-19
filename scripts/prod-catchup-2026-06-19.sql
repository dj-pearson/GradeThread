-- prod-catchup-2026-06-19.sql
--
-- WHY: the edge boot guard (US-778, lib/schema-version.ts) refuses to start:
--   [schema-version] DB is STALE: applied=00254, this build expects 00256.
--
-- ⚠️ DIFFERENT from prod-catchup-2026-06-14 / 2026-06-18: those were
-- tracker-BACKFILL ONLY (they recorded version rows for DDL already applied by
-- hand, back when migrations didn't self-record). They apply NO schema.
--
-- This file is the opposite: 00255/00256 DDL is NOT yet on prod (drip_campaigns,
-- owner_nodes, garments, garment_events do not exist). So this bundles the two
-- pending migration files VERBATIM — DDL + their US-1108 self-record footer — so
-- one paste both creates the schema AND advances latest_schema_migration() to
-- 00256. Running a tracker-only backfill here would mask the missing tables and
-- the edge would hit "relation does not exist" at runtime.
--
-- SOURCE OF TRUTH remains the migration files; this is a convenience bundle:
--   supabase/migrations/00255_drip_campaign_definitions.sql   (US-945)
--   supabase/migrations/00256_garment_passport_core.sql       (US-1089)
-- Both are idempotent (IF NOT EXISTS / guarded enums / ON CONFLICT) → safe to
-- re-run. Apply via Supabase Studio SQL editor or psql -f.
--
-- ⚠️ Back up prod first (BACKUPS.md). Migrations are forward-only.
--
-- After running, verify the tail line reports 00256, then restart/redeploy the
-- edge service — the boot guard will log "[schema-version] OK".

-- ════════════════════════════════════════════════════════════════════════════
-- 00255_drip_campaign_definitions.sql  (US-945)
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS public.drip_campaigns (
  campaign         text PRIMARY KEY,
  name             text NOT NULL,
  status           text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'paused', 'killed')),
  feature_flag_key text,
  graph            jsonb NOT NULL DEFAULT '{"entryStepId":null,"steps":[]}'::jsonb,
  updated_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.drip_campaigns IS
  'US-945: editable drip campaign step-graph (definition the engine reads + the '
  'admin builder edits). Service-role only; graph validated in the edge handler.';

DROP TRIGGER IF EXISTS set_drip_campaigns_updated_at ON public.drip_campaigns;
CREATE TRIGGER set_drip_campaigns_updated_at
  BEFORE UPDATE ON public.drip_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.drip_campaigns ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  EXECUTE 'REVOKE ALL ON public.drip_campaigns FROM anon';
  EXECUTE 'REVOKE ALL ON public.drip_campaigns FROM authenticated';
  EXECUTE 'GRANT ALL ON public.drip_campaigns TO service_role';
EXCEPTION WHEN undefined_object THEN
  NULL;
END $$;

INSERT INTO public.drip_campaigns (campaign, name, status, feature_flag_key, graph)
VALUES (
  'trial_conversion',
  'Trial Conversion Drip',
  'active',
  'trial_conversion_drip',
  $json$
  {
    "entryStepId": "welcome",
    "steps": [
      {
        "id": "welcome",
        "label": "Welcome — grade your first item",
        "phase": "in_trial",
        "trigger": "trial_started",
        "anchor": "enrollment",
        "delayHours": 0,
        "conditions": [],
        "brief": "Warm welcome. One clear CTA: upload your first garment and get a grade in minutes. No card on file — reassure them the trial is free.",
        "incentiveEnabled": false,
        "branches": [],
        "next": "tips",
        "exit": false,
        "variants": [
          {
            "id": "A",
            "weight": 100,
            "subject": "Welcome to GradeThread, {{firstName}} — let's grade your first item",
            "html": "<p>Hi {{firstName}},</p><p>Your free trial is live. Upload a garment and get a standardized condition grade in minutes.</p><p><a href=\"https://gradethread.com/dashboard\">Grade your first item</a></p>"
          }
        ]
      },
      {
        "id": "tips",
        "label": "Day 3 — get better grades",
        "phase": "in_trial",
        "trigger": "after_previous",
        "anchor": "previous",
        "delayHours": 72,
        "conditions": [{ "field": "converted", "op": "is_false" }],
        "brief": "Educational: how to photograph for the most accurate grade (front/back/label/detail). Reinforce value of the certificate.",
        "incentiveEnabled": false,
        "branches": [],
        "next": "ending_soon",
        "exit": false,
        "variants": [
          {
            "id": "A",
            "weight": 100,
            "subject": "Get sharper grades, {{firstName}}",
            "html": "<p>Hi {{firstName}},</p><p>Four photos — front, back, label, and a detail — get you the most accurate grade and a shareable certificate.</p>"
          }
        ]
      },
      {
        "id": "ending_soon",
        "label": "Trial ending — convert with incentive",
        "phase": "in_trial",
        "trigger": "before_trial_end",
        "anchor": "trial_end",
        "delayHours": -72,
        "conditions": [{ "field": "converted", "op": "is_false" }],
        "brief": "Urgency: trial ends in 3 days. Offer the launch incentive. Make upgrading one click.",
        "incentiveEnabled": true,
        "branches": [
          { "conditions": [{ "field": "gradesUsed", "op": "gte", "value": 1 }], "targetStepId": "ending_soon_active" }
        ],
        "next": "win_back_1",
        "exit": false,
        "variants": [
          {
            "id": "A",
            "weight": 50,
            "subject": "Your trial ends in 3 days, {{firstName}}",
            "html": "<p>Hi {{firstName}},</p><p>Your trial ends {{trialEndsAt}}. Upgrade now to keep grading.</p>{{incentive}}"
          },
          {
            "id": "B",
            "weight": 50,
            "subject": "Don't lose your reports, {{firstName}}",
            "html": "<p>Hi {{firstName}},</p><p>Keep your certificates and reports — upgrade before {{trialEndsAt}}.</p>{{incentive}}"
          }
        ]
      },
      {
        "id": "ending_soon_active",
        "label": "Trial ending — engaged users",
        "phase": "in_trial",
        "trigger": "before_trial_end",
        "anchor": "trial_end",
        "delayHours": -72,
        "conditions": [{ "field": "converted", "op": "is_false" }],
        "brief": "For users who already graded items: emphasize what they'll lose access to and how cheap continuing is.",
        "incentiveEnabled": true,
        "branches": [],
        "next": "win_back_1",
        "exit": false,
        "variants": [
          {
            "id": "A",
            "weight": 100,
            "subject": "Keep grading, {{firstName}} — your trial ends {{trialEndsAt}}",
            "html": "<p>Hi {{firstName}},</p><p>You've already graded items this trial. Upgrade to keep your reports and grade more.</p>{{incentive}}"
          }
        ]
      },
      {
        "id": "win_back_1",
        "label": "Win-back — 1 day after trial",
        "phase": "win_back",
        "trigger": "after_trial_end",
        "anchor": "trial_end",
        "delayHours": 24,
        "conditions": [{ "field": "converted", "op": "is_false" }],
        "brief": "Friendly win-back the day after the trial lapsed. Lead with the incentive and a low-friction return.",
        "incentiveEnabled": true,
        "branches": [],
        "next": "win_back_final",
        "exit": false,
        "variants": [
          {
            "id": "A",
            "weight": 100,
            "subject": "Come back, {{firstName}} — here's a hand",
            "html": "<p>Hi {{firstName}},</p><p>Your trial wrapped up. Pick up where you left off.</p>{{incentive}}"
          }
        ]
      },
      {
        "id": "win_back_final",
        "label": "Win-back — final (day 14)",
        "phase": "win_back",
        "trigger": "after_trial_end",
        "anchor": "trial_end",
        "delayHours": 336,
        "conditions": [{ "field": "converted", "op": "is_false" }],
        "brief": "Last touch. Strongest incentive, clear deadline, then exit the journey.",
        "incentiveEnabled": true,
        "branches": [],
        "next": null,
        "exit": true,
        "variants": [
          {
            "id": "A",
            "weight": 100,
            "subject": "Last call, {{firstName}}",
            "html": "<p>Hi {{firstName}},</p><p>This is the last we'll nudge you. Your incentive expires soon.</p>{{incentive}}"
          }
        ]
      }
    ]
  }
  $json$::jsonb
)
ON CONFLICT (campaign) DO NOTHING;

COMMIT;

INSERT INTO public.applied_migrations (version) VALUES ('00255')
ON CONFLICT DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- 00256_garment_passport_core.sql  (US-1089)
-- ════════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  CREATE TYPE public.garment_status AS ENUM ('active', 'merged', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.owner_node_kind AS ENUM ('seller', 'buyer', 'system');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.garment_event_type AS ENUM (
    'graded', 'listed', 'sold', 'ownership_transfer', 'fingerprinted'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.garment_event_confidence AS ENUM (
    'deterministic', 'probable', 'unknown'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

BEGIN;

CREATE TABLE IF NOT EXISTS public.owner_nodes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pseudonymous_label text NOT NULL,
  kind            public.owner_node_kind NOT NULL,
  linked_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.owner_nodes IS
  'US-1089: pseudonymous Garment Passport participants (no PII). linked_user_id '
  'is null until the opt-in identity story (US-1105). Service-role only.';

CREATE TABLE IF NOT EXISTS public.garments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_passport_slug  text NOT NULL UNIQUE
                          DEFAULT replace(gen_random_uuid()::text, '-', ''),
  sku_class             jsonb NOT NULL DEFAULT '{}'::jsonb,
  current_owner_node_id uuid REFERENCES public.owner_nodes(id) ON DELETE SET NULL,
  status                public.garment_status NOT NULL DEFAULT 'active',
  created_by            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.garments IS
  'US-1089: persistent Garment Passport identity. created_by is the tenant key; '
  'current_owner_node_id points at the pseudonymous current holder.';

CREATE TABLE IF NOT EXISTS public.garment_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  garment_id    uuid NOT NULL REFERENCES public.garments(id) ON DELETE CASCADE,
  event_type    public.garment_event_type NOT NULL,
  actor_node_id uuid REFERENCES public.owner_nodes(id) ON DELETE SET NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence    public.garment_event_confidence NOT NULL DEFAULT 'unknown',
  source        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.garment_events IS
  'US-1089: append-only Garment Passport event ledger (graded/listed/sold/'
  'ownership_transfer/fingerprinted). No update/delete — corrections are new rows.';

CREATE INDEX IF NOT EXISTS idx_garments_created_by
  ON public.garments(created_by);
CREATE INDEX IF NOT EXISTS idx_garments_current_owner_node
  ON public.garments(current_owner_node_id);
CREATE INDEX IF NOT EXISTS idx_owner_nodes_linked_user
  ON public.owner_nodes(linked_user_id) WHERE linked_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_garment_events_garment_created
  ON public.garment_events(garment_id, created_at);

DROP TRIGGER IF EXISTS trg_garments_updated_at ON public.garments;
CREATE TRIGGER trg_garments_updated_at
  BEFORE UPDATE ON public.garments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.owner_nodes    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.garments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.garment_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.owner_nodes FROM anon, authenticated;

REVOKE INSERT, UPDATE, DELETE ON public.garments FROM anon, authenticated;
DROP POLICY IF EXISTS garments_select_own ON public.garments;
CREATE POLICY garments_select_own ON public.garments
  FOR SELECT
  USING (created_by = auth.uid());

REVOKE INSERT, UPDATE, DELETE ON public.garment_events FROM anon, authenticated;
DROP POLICY IF EXISTS garment_events_select_via_garment ON public.garment_events;
CREATE POLICY garment_events_select_via_garment ON public.garment_events
  FOR SELECT
  USING (
    garment_id IN (
      SELECT id FROM public.garments WHERE created_by = auth.uid()
    )
  );

INSERT INTO public.applied_migrations (version) VALUES ('00256')
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- Verify: should report 00256.
SELECT public.latest_schema_migration() AS latest_tracked;
