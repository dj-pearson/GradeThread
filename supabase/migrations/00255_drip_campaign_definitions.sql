-- US-945: Visual drip / journey builder — persisted campaign step-graph.
--
-- The drip ANALYTICS tables (00253: drip_enrollments / drip_sends /
-- drip_attributions) record what the engine DID. This migration adds the
-- editable DEFINITION the admin builder edits and the engine reads: one row per
-- campaign holding an ordered/branching step graph (trigger, delay/anchor,
-- conditions, branch targets, exit, per-step brief/copy + A/B variants,
-- incentive toggle) plus a pause/resume/kill status.
--
-- Service-role only (mirrors 00253): the edge engine + admin builder read/write
-- via the service-role client; never client-readable. Validation of the graph
-- (no loops/orphans) is enforced in the edge handler (drip-graph.ts) before any
-- write, so a malformed graph never lands here.

BEGIN;

CREATE TABLE IF NOT EXISTS public.drip_campaigns (
  campaign         text PRIMARY KEY,
  name             text NOT NULL,
  -- active: ticking + sending. paused: definition frozen, no sends. killed:
  -- hard-stopped (also flips the linked feature flag off).
  status           text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'paused', 'killed')),
  -- Optional feature-flag key the kill switch flips off (US-507 flags). NULL =
  -- status alone gates the engine.
  feature_flag_key text,
  -- The step graph: { "entryStepId": text|null, "steps": [ … ] }. Shape is
  -- validated in drip-graph.ts (validateGraph) before every write.
  graph            jsonb NOT NULL DEFAULT '{"entryStepId":null,"steps":[]}'::jsonb,
  updated_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.drip_campaigns IS
  'US-945: editable drip campaign step-graph (definition the engine reads + the '
  'admin builder edits). Service-role only; graph validated in the edge handler.';

-- updated_at trigger (reuse the shared helper from 00001).
DROP TRIGGER IF EXISTS set_drip_campaigns_updated_at ON public.drip_campaigns;
CREATE TRIGGER set_drip_campaigns_updated_at
  BEFORE UPDATE ON public.drip_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Service-role only: RLS on, no policy → anon/authenticated denied via PostgREST;
-- the service-role client (and SECURITY DEFINER) still reads/writes.
ALTER TABLE public.drip_campaigns ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  EXECUTE 'REVOKE ALL ON public.drip_campaigns FROM anon';
  EXECUTE 'REVOKE ALL ON public.drip_campaigns FROM authenticated';
  EXECUTE 'GRANT ALL ON public.drip_campaigns TO service_role';
EXCEPTION WHEN undefined_object THEN
  NULL; -- roles may not all exist on a bare local Postgres
END $$;

-- ── Seed the trial-conversion campaign with a default graph ──
-- 14d no-card trial (14 in-trial nudges + 14d post-trial win-back). Exits
-- instantly on conversion. Anchors: enrollment | previous | trial_end;
-- delay_hours is an offset from the anchor (may be negative, e.g. -72h = 3 days
-- BEFORE trial end). This is a STARTING point operators edit in the builder.
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

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00255')
ON CONFLICT DO NOTHING;
