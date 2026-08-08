-- US-1863: Thrift Radar — the served aggregate table and the retention archive.
--
-- 00550 stores de-identified scan events; 00551 gives them a named venue. This
-- is the layer anyone actually reads: venue x brand x time-window intelligence,
-- recomputed by a scheduled job, and the archive that lets the raw events be
-- deleted on schedule without erasing the record that activity happened.
--
-- Full rule set: vault/20-domain/thrift-radar.md (this file is in its code_refs).
-- The one rule that is enforced HERE, in the schema, rather than only in the
-- aggregation code, is rule 6 — THE K-ANONYMITY FLOOR:
--
--   `radar_venue_aggregates.contributor_count` carries a CHECK of >= 2. The
--   table therefore CANNOT HOLD an aggregate that only one person contributed
--   to. The configured floor (radar_privacy.k_anonymity_floor, default 3) is a
--   minimum an operator may raise; this CHECK is the number they cannot get
--   below by editing a JSON setting, and it is why the guarantee survives a
--   config edit by someone who has not read the note.
--
-- Four layers hold the floor, deliberately: the aggregation engine writes only
-- rows that clear it, this CHECK refuses the rest, the read endpoint re-applies
-- it, and the below-floor case produces NO ROW AT ALL rather than a suppressed
-- marker — a row saying "hidden here" is itself the disclosure that somebody
-- scanned there.

-- ── The served aggregates ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.radar_venue_aggregates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  venue_id          uuid NOT NULL REFERENCES public.radar_venues(id) ON DELETE CASCADE,

  -- Rolling windows the job recomputes from scratch each run.
  window_key        text NOT NULL CHECK (window_key IN ('7d', '30d', '90d')),

  -- '*' is the venue TOTAL across every brand; anything else is a normalized
  -- brand. Both grains live in one table because the floor, the sweep and the
  -- serving filter apply identically to both — a second table would mean a
  -- second copy of each guard, and a copied privacy guard goes stale on one
  -- side. A venue total is computed directly from the events, never by summing
  -- the brand rows (which would double-count a contributor who scanned two).
  brand_key         text NOT NULL,

  window_start      timestamptz NOT NULL,
  window_end        timestamptz NOT NULL,

  scan_count        integer NOT NULL CHECK (scan_count >= 0),

  -- DISTINCT contributor keys — the ONLY number the floor is computed from, and
  -- deliberately not radar_venues.observation_count, which counts one
  -- enthusiast's repeat visits as many. See the header: this CHECK is the
  -- schema-level half of rule 6.
  contributor_count integer NOT NULL CHECK (contributor_count >= 2),

  -- Band-resolution average. The event store holds a BAND, never a numeric
  -- grade (00550's minimization, not undone here), so this is derived from band
  -- midpoints and can only land between 5.0 and 9.0. The mix columns below are
  -- the honest detail behind it.
  avg_grade         numeric(3,1),
  high_count        integer NOT NULL DEFAULT 0 CHECK (high_count >= 0),
  mid_count         integer NOT NULL DEFAULT 0 CHECK (mid_count >= 0),
  low_count         integer NOT NULL DEFAULT 0 CHECK (low_count >= 0),
  ungraded_count    integer NOT NULL DEFAULT 0 CHECK (ungraded_count >= 0),

  -- Buy-verdict rate over the scans that produced a REAL verdict. A scan with
  -- no comps is 'unknown' and is excluded from the denominator rather than
  -- counted as a pass — a store looks worse than it is otherwise.
  buy_count         integer NOT NULL DEFAULT 0 CHECK (buy_count >= 0),
  verdict_count     integer NOT NULL DEFAULT 0 CHECK (verdict_count >= 0),
  buy_rate          numeric(4,3) CHECK (buy_rate IS NULL OR (buy_rate >= 0 AND buy_rate <= 1)),

  -- Freshness: the most recent scan inside the window.
  last_activity_at  timestamptz NOT NULL,

  -- Stamped with the run that produced the row. The job upserts the current
  -- truth and then deletes everything it did not touch, so a venue that drops
  -- BELOW the floor between runs loses its row instead of keeping a stale one.
  computed_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.radar_venue_aggregates IS
  'US-1863: served Thrift Radar intelligence, venue x window x brand. Holds ONLY '
  'aggregates above the k-anonymity floor — see vault/20-domain/thrift-radar.md '
  'rule 6 and the contributor_count CHECK. Service-role only; recomputed each run.';

COMMENT ON COLUMN public.radar_venue_aggregates.contributor_count IS
  'Distinct radar_scan_events.contributor_key in the window. The CHECK (>= 2) is '
  'the schema-level k-anonymity floor: the configured radar_privacy.k_anonymity_floor '
  '(default 3) may raise it, never lower it below this.';

COMMENT ON COLUMN public.radar_venue_aggregates.brand_key IS
  '''*'' = the venue total across all brands; anything else = a normalized brand. '
  'Both grains carry their own contributor_count and clear the floor independently.';

-- One row per venue x window x brand — what the upsert conflicts on.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_radar_venue_aggregates_grain
  ON public.radar_venue_aggregates(venue_id, window_key, brand_key);

-- The sweep that removes rows the latest run did not rewrite.
CREATE INDEX IF NOT EXISTS idx_radar_venue_aggregates_computed_at
  ON public.radar_venue_aggregates(computed_at);

-- ── The retention archive ───────────────────────────────────────────────────
-- Rule: an aggregate that stays recomputable from retained raw events is a raw
-- event store wearing a rollup's name. So raw events are pruned on a schedule —
-- and this is what survives them, at month resolution, so pruning is not the
-- moment the record of activity disappears.
--
-- Deliberately NO foreign key to radar_venues. The archive has to outlive a
-- venue row: a dangling id reads as "a place that is no longer in the registry",
-- which is a true statement, whereas ON DELETE CASCADE would make deleting a
-- venue also delete the history of everything that happened there, and
-- ON DELETE SET NULL would break the generated place_key below.
CREATE TABLE IF NOT EXISTS public.radar_scan_history (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The place: a venue when the event resolved to one, else the coarse cell.
  -- Unresolved activity is archived too — it is not network intelligence, but
  -- deleting it silently would be a different thing from retiring it.
  venue_id          uuid,
  geohash           text
                      CHECK (geohash IS NULL OR geohash ~ '^[0-9b-hjkmnp-z]{4,7}$'),
  place_key         text GENERATED ALWAYS AS
                      (COALESCE(venue_id::text, 'cell:' || geohash)) STORED,

  month_start       date NOT NULL,

  scan_count        integer NOT NULL CHECK (scan_count >= 0),
  -- Distinct contributor KEYS, which rotate (default weekly). Across a month
  -- that over-counts people, and the name says volume rather than headcount on
  -- purpose. Nothing serves this table; any future read path must apply the
  -- k-anonymity floor itself, because this column is not one.
  contributor_count integer NOT NULL CHECK (contributor_count >= 0),
  avg_grade         numeric(3,1),
  buy_count         integer NOT NULL DEFAULT 0 CHECK (buy_count >= 0),
  verdict_count     integer NOT NULL DEFAULT 0 CHECK (verdict_count >= 0),
  last_activity_at  timestamptz NOT NULL,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT radar_scan_history_located
    CHECK (venue_id IS NOT NULL OR geohash IS NOT NULL)
);

COMMENT ON TABLE public.radar_scan_history IS
  'US-1863: month-resolution archive of pruned radar_scan_events, so retention '
  'pruning does not erase that activity happened. Not served by any endpoint. '
  'Service-role only.';

CREATE UNIQUE INDEX IF NOT EXISTS uniq_radar_scan_history_place_month
  ON public.radar_scan_history(place_key, month_start);

CREATE INDEX IF NOT EXISTS idx_radar_scan_history_month
  ON public.radar_scan_history(month_start DESC);

DROP TRIGGER IF EXISTS set_radar_scan_history_updated_at ON public.radar_scan_history;
CREATE TRIGGER set_radar_scan_history_updated_at
  BEFORE UPDATE ON public.radar_scan_history
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── Deny-all RLS (service-role only) ────────────────────────────────────────
-- Same reasoning as 00550 and 00551: neither table has an owner column, so
-- rls-guard's discovery never finds them, so each is registered in BOTH
-- SERVICE_ROLE_ONLY and SERVICE_ONLY_FORCED in rls-guard_test.ts. A directly
-- readable aggregates table would let a client bypass the endpoint that applies
-- the floor on read — which is most of the point of having the endpoint.
ALTER TABLE public.radar_venue_aggregates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.radar_venue_aggregates FROM anon, authenticated;

ALTER TABLE public.radar_scan_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.radar_scan_history FROM anon, authenticated;

-- ── Aggregation tuning ──────────────────────────────────────────────────────
-- A THIRD radar settings row, and the split is the same one 00551 argued for:
-- radar_privacy holds the numbers whose change is a POLICY decision (the floor,
-- retention); radar_venues holds resolution tuning; this holds job tuning. A
-- knob anyone may turn must not share an edit with the k-anonymity floor.
INSERT INTO public.system_settings (key, value, value_type, default_value, category, description)
VALUES (
  'radar_aggregation',
  '{"aggregation_enabled": true, "retention_enabled": true, "max_events_per_run": 200000, "max_prune_events_per_run": 50000, "bbox_venue_limit": 200}'::jsonb,
  'json',
  '{"aggregation_enabled": true, "retention_enabled": true, "max_events_per_run": 200000, "max_prune_events_per_run": 50000, "bbox_venue_limit": 200}'::jsonb,
  'radar',
  'US-1863: Thrift Radar aggregation job tuning. aggregation_enabled false stops '
  'the recompute (existing rows are left alone, so the map freezes rather than '
  'empties). retention_enabled false stops the prune — use it to pause deletion '
  'while investigating, never as a permanent setting, because retention is what '
  'keeps the rollup a rollup. max_events_per_run and max_prune_events_per_run '
  'bound one run''s reads so a backlog is worked off over several runs instead '
  'of timing one out. bbox_venue_limit caps how many venues one map viewport '
  'request may return. NOTE: the k-anonymity floor and the retention WINDOW are '
  'NOT here — they live in radar_privacy, because lowering either is a policy '
  'change rather than tuning.'
)
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00552')
ON CONFLICT (version) DO NOTHING;
