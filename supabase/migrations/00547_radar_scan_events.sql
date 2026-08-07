-- US-1861: Thrift Radar — the opt-in contribution toggle and the de-identified
-- scan-event store the network layer is built from.
--
-- The full rule set lives in vault/20-domain/thrift-radar.md (this migration is
-- listed in its code_refs). The three constraints that are enforced HERE, in the
-- schema, rather than only in application code:
--
--   1. There is no coordinate column. Coordinates exist to pick a venue and are
--      discarded in the same request; what survives is `venue_id` or a coarse
--      `geohash` cell. A column would eventually be filled.
--   2. `geohash` is length-capped by a CHECK, so a later precision change cannot
--      quietly turn a neighbourhood cell into a doorstep.
--   3. There is no account column at all — the analytical path carries a salted,
--      rotating `contributor_key` instead. Distinct contributors stay countable
--      (the k-anonymity floor needs that); a person does not stay followable.

-- ── The contribution consent ────────────────────────────────────────────────
-- A NEW toggle, deliberately not a widening of share_sale_outcomes or the
-- analytics switch: location is a new kind of data, so it gets its own consent,
-- its own copy and its own line in the privacy policy. DEFAULT false on every
-- client — nothing is contributed until someone turns this on.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS radar_contribute boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.users.radar_contribute IS
  'US-1861: opt-in consent to contribute anonymized Thrift Radar scan events '
  '(venue/geohash cell + brand + category + grade band + buy/pass verdict). '
  'Default false. Viewing Radar is a SEPARATE consent — never gate a read on this.';

-- ── Let the account owner set their own consent ─────────────────────────────
-- 00526 made public.users self-updates DENY-BY-DEFAULT: an authenticated session
-- may change only the columns the guard enumerates, and everything else — present
-- or future — is refused. That is exactly the behaviour we want, and it is also
-- why a new consent column needs an explicit entry: without one, the settings
-- switch would fail on a real user in production and nowhere else.
--
-- 00526 is already applied and stays untouched (applied migrations are
-- immutable). The guard is a CREATE OR REPLACE function, so the way to extend it
-- is to restate it here — the whole body, with `radar_contribute` added, and
-- nothing else changed. Anyone extending it next does the same in their own file.
CREATE OR REPLACE FUNCTION public.guard_users_protected_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- The ONLY columns an end user may change on their own row.
  self_service constant text[] := ARRAY[
    -- Stamped by set_users_updated_at; must never be the reason for a refusal.
    'updated_at',
    -- Profile (settings.tsx, ios ProfileStore/AuthStore).
    'full_name', 'avatar_url',
    -- Business & shipping profile (settings.tsx, US-325).
    'business_name', 'business_phone', 'ship_from_address',
    -- Preferences.
    'notification_preferences', 'share_sale_outcomes',
    'sync_conflict_email_threshold',
    'ai_enrichment_enabled', 'ai_action_limit',
    'promote_listings_by_default', 'default_promo_rate_pct', 'default_promo_mode',
    -- Thrift Radar contribution consent (US-1861). Self-service on purpose: a
    -- consent the person cannot withdraw from their own settings screen is not
    -- a consent. Both clients write it directly (web settings card, iOS
    -- RadarConsent); the edge only ever READS it.
    'radar_contribute',
    -- Onboarding + one-shot dismissals.
    'onboarded_at', 'use_case', 'flipdesk_onboarded',
    'dismissed_flipdesk_promo', 'dismissed_ebay_publish_disclaimer',
    -- Which workspace the user is currently looking at (US-1636).
    'active_workspace_owner_id'
  ];
  changed text[];
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' THEN
    RETURN NEW;
  END IF;

  -- Name the offending columns rather than raising a generic refusal: the
  -- previous message listed categories, so a legitimate client write that
  -- tripped it gave the developer nothing to act on.
  SELECT array_agg(o.key ORDER BY o.key)
    INTO changed
    FROM jsonb_each(to_jsonb(OLD) - self_service) AS o
    JOIN jsonb_each(to_jsonb(NEW) - self_service) AS n ON n.key = o.key
   WHERE n.value IS DISTINCT FROM o.value;

  IF changed IS NOT NULL THEN
    RAISE EXCEPTION
      'users: column(s) % cannot be modified by the account owner (role, suspension, plan, billing, usage and entitlement columns are service-role only)',
      array_to_string(changed, ', ');
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.guard_users_protected_columns() IS
  'US-347 (00331) + US-1799 (00402) + US-2283 (00526) + US-1861 (00547): DENY-BY-DEFAULT guard on public.users self-updates. An authenticated (browser/app) session may change only the self-service columns enumerated in the function body; every other column, present or future, is refused. Service-role and SECURITY DEFINER paths bypass via the auth.role() check.';

-- ── The de-identified event store ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.radar_scan_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Salted SHA-256 of (epoch, account) — the same minimizeLinkageRef primitive
  -- the passport uses, plus rotation. Distinct-contributor counts work inside an
  -- epoch; joining a person's contributions ACROSS epochs does not.
  contributor_key text NOT NULL,
  -- Which rotation window `contributor_key` belongs to (whole epochs since the
  -- Unix epoch, at the configured rotation length).
  key_epoch       integer NOT NULL,
  -- Where. Exactly one of these is the location; both may be set once a cell is
  -- resolved to a venue. NO raw fix is stored, here or anywhere.
  venue_id        uuid,
  -- Coarse cell, used while the venue is unresolved. Capped at 7 characters
  -- (~150 m) by the CHECK below; the configured default is 6 (~1.2 km x 0.6 km).
  geohash         text,
  brand           text,
  category        text,
  -- Mirrors bandForGrade() in lib/resale-condition.ts.
  grade_band      text NOT NULL DEFAULT 'ungraded'
                    CHECK (grade_band IN ('high', 'mid', 'low', 'ungraded')),
  -- Mirrors BuyRecommendation in lib/scout-decision.ts. 'unknown' is the honest
  -- value for a scan that produced no comps, not a silent 'skip'.
  verdict         text NOT NULL DEFAULT 'unknown'
                    CHECK (verdict IN ('buy', 'maybe', 'skip', 'unknown')),
  scanned_at      timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- An event with neither a venue nor a cell is not a Radar observation.
  CONSTRAINT radar_scan_events_located
    CHECK (venue_id IS NOT NULL OR geohash IS NOT NULL),
  -- geohash base32 alphabet, 4–7 characters. This is the schema-level half of
  -- rule 4: precision is a knob, but it cannot be turned past this.
  CONSTRAINT radar_scan_events_geohash_coarse
    CHECK (geohash IS NULL OR geohash ~ '^[0-9b-hjkmnp-z]{4,7}$')
);

COMMENT ON TABLE public.radar_scan_events IS
  'US-1861: anonymized Thrift Radar contributions. No coordinates, no account '
  'column — see vault/20-domain/thrift-radar.md. Service-role writes only.';

-- The venue/cell x window aggregate read, and the distinct-contributor count
-- the k-anonymity floor is computed from.
CREATE INDEX IF NOT EXISTS idx_radar_scan_events_venue_window
  ON public.radar_scan_events(venue_id, scanned_at DESC)
  WHERE venue_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_radar_scan_events_cell_window
  ON public.radar_scan_events(geohash, scanned_at DESC)
  WHERE geohash IS NOT NULL;

-- Retention pruning: an aggregate that stays recomputable from retained raw
-- events is a raw-event store wearing a rollup's name.
CREATE INDEX IF NOT EXISTS idx_radar_scan_events_scanned_at
  ON public.radar_scan_events(scanned_at);

-- ── Deny-all RLS (service-role writes only) ─────────────────────────────────
-- No policies, on purpose. The edge writes with the service-role client, which
-- bypasses RLS; nothing else may touch this table. Registered in BOTH
-- SERVICE_ROLE_ONLY and SERVICE_ONLY_FORCED in rls-guard_test.ts because a table
-- with no owner column is otherwise never discovered, and a table nothing looks
-- at can lose its RLS with nothing going red.
ALTER TABLE public.radar_scan_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.radar_scan_events FROM anon, authenticated;

-- ── Privacy configuration ───────────────────────────────────────────────────
-- k_anonymity_floor lives here so US-1863's aggregates endpoint reads the same
-- number this migration documents. Lowering it is a POLICY change, not tuning.
INSERT INTO public.system_settings (key, value, value_type, default_value, category, description)
VALUES (
  'radar_privacy',
  '{"contribution_enabled": true, "geohash_precision": 6, "key_rotation_days": 7, "k_anonymity_floor": 3, "raw_event_retention_days": 180}'::jsonb,
  'json',
  '{"contribution_enabled": true, "geohash_precision": 6, "key_rotation_days": 7, "k_anonymity_floor": 3, "raw_event_retention_days": 180}'::jsonb,
  'radar',
  'US-1861: Thrift Radar privacy parameters. contribution_enabled is the '
  'kill-switch — false stops every emission regardless of per-user consent. '
  'geohash_precision is how coarse a stored cell is (6 = ~1.2 km x 0.6 km); the '
  'column CHECK caps it at 7 so this knob cannot be turned into a doorstep. '
  'key_rotation_days is how long a contributor digest stays stable — long enough '
  'to count distinct contributors in a window, short enough that contributions '
  'cannot be followed across windows. k_anonymity_floor is the minimum number of '
  'DISTINCT contributors before a venue x window aggregate is served at all; it '
  'is a privacy guarantee, so lowering it is a policy decision. '
  'raw_event_retention_days is when raw events are pruned — the rollup is only '
  'a rollup for as long as this stays finite.'
)
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00547')
ON CONFLICT (version) DO NOTHING;
