-- US-1862: Thrift Radar — the store venue registry.
--
-- 00547 gave every contribution a coarse `geohash` cell and left `venue_id`
-- nullable with nothing to point at. This is the thing it points at: a named,
-- deduplicated place, so intelligence accrues to "the Goodwill on Main St"
-- rather than to a soup of cells.
--
-- The rule this table is built around is rule 4 of
-- vault/20-domain/thrift-radar.md — NO PRECISE COORDINATE SURVIVES VENUE
-- RESOLUTION. A venue centroid looks like an exception to that and is not, for
-- one reason worth stating in the schema rather than only in a code comment:
--
--   An AUTO-CREATED venue's centroid is the CENTRE OF A GEOHASH CELL, never a
--   contributor's fix. The first scan at an unknown store creates a candidate
--   whose lat/lng is the middle of the ~1.2 km x 0.6 km cell that scan fell in.
--   That is a fact about the map, not about the person — every scan in the cell
--   produces the identical pair, so the centroid cannot be read back as
--   "somebody stood here". Precision is only ever bought later, from a source
--   that is allowed to be precise: a human naming the venue, or the Places
--   enrichment the `place_*` columns are reserved for.
--
-- Which is also why `centroid_source` exists. A column that can hold either a
-- derived cell centre or a surveyed coordinate needs to say which it is holding,
-- or the guarantee above degrades into a claim nobody can check.

-- ── The registry ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.radar_venues (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What a human calls it. Auto-created candidates get a cell-derived
  -- placeholder ("Unnamed venue u33dc0"); naming is a later, optional step.
  display_name    text NOT NULL,

  -- Chain identity, normalized from whatever string a namer typed:
  -- 'Goodwill Store #123' and 'Goodwill Industries of Michigan' are both
  -- 'goodwill'. The CHAIN is shared; the VENUE stays distinct — two Goodwills
  -- are two rows, and nothing in this schema merges them on chain alone.
  chain           text NOT NULL DEFAULT 'other'
                    CHECK (chain IN ('goodwill', 'savers', 'salvation_army',
                                     'value_village', 'other')),

  -- Centroid. See the header: derived from a cell centre unless
  -- centroid_source says a precise source supplied it.
  lat             double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng             double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  centroid_source text NOT NULL DEFAULT 'cell'
                    CHECK (centroid_source IN ('cell', 'user', 'places')),

  -- The resolution cell this venue is indexed under — the same geohash
  -- alphabet and the same 4–7 character cap as radar_scan_events.geohash, so a
  -- scan's cell and a venue's cell are directly comparable. Lookup is
  -- "this cell plus its eight neighbours", which is why the cap matters here
  -- too: a finer cell would make the neighbourhood miss real matches.
  geohash         text NOT NULL
                    CHECK (geohash ~ '^[0-9b-hjkmnp-z]{4,7}$'),

  -- candidate  — auto-created from scan convergence, never confirmed by anyone.
  -- confirmed  — a human named it, or enough distinct contributors converged.
  -- merged     — a near-duplicate that lost a merge; `merged_into_id` is the
  --              survivor. Kept rather than deleted so an id already written to
  --              a scan event never dangles.
  status          text NOT NULL DEFAULT 'candidate'
                    CHECK (status IN ('candidate', 'confirmed', 'merged')),
  merged_into_id  uuid REFERENCES public.radar_venues(id) ON DELETE SET NULL,

  -- How many contributions have resolved here. Drives merge-survivor choice and
  -- candidate → confirmed promotion. NOT a contributor count: the k-anonymity
  -- floor is computed from DISTINCT contributor_key on the events, never from
  -- this, because this counts repeat visits by one person as many.
  observation_count integer NOT NULL DEFAULT 0 CHECK (observation_count >= 0),

  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),

  -- ── Reserved for a Places enrichment, deliberately unused in v1 ───────────
  -- The story is dependency-free on purpose (no external Places API), but the
  -- shape has to admit one later without rework: an enrichment fills these,
  -- flips centroid_source to 'places', and nothing else changes.
  place_provider  text,
  place_ref       text,
  address         text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- A merged row must name its survivor, and a live row must not name one.
  CONSTRAINT radar_venues_merge_target
    CHECK ((status = 'merged') = (merged_into_id IS NOT NULL)),
  -- Nothing may be merged into itself.
  CONSTRAINT radar_venues_merge_not_self
    CHECK (merged_into_id IS NULL OR merged_into_id <> id)
);

COMMENT ON TABLE public.radar_venues IS
  'US-1862: Thrift Radar store venue registry. Auto-created candidates carry a '
  'CELL-CENTRE centroid, never a contributor coordinate — see '
  'vault/20-domain/thrift-radar.md rule 4. Service-role only.';

COMMENT ON COLUMN public.radar_venues.centroid_source IS
  'Where lat/lng came from: cell = derived from a geohash cell centre (the only '
  'thing scan convergence may produce); user = a person placed it; places = an '
  'external Places enrichment. Never set to user/places from scan data.';

COMMENT ON COLUMN public.radar_venues.observation_count IS
  'Contributions resolved here. NOT a contributor count — the k-anonymity floor '
  'is computed from distinct radar_scan_events.contributor_key, never from this.';

-- One LIVE venue per (cell, chain). This is what makes later scans CONVERGE
-- instead of each minting its own candidate: the resolver inserts with
-- ON CONFLICT DO NOTHING and re-reads the winner, so a race produces one row.
-- Partial on status <> 'merged' so a merged loser does not hold the slot.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_radar_venues_live_cell_chain
  ON public.radar_venues(geohash, chain)
  WHERE status <> 'merged';

-- The resolver's read: the scan's cell plus its eight neighbours.
CREATE INDEX IF NOT EXISTS idx_radar_venues_geohash
  ON public.radar_venues(geohash)
  WHERE status <> 'merged';

CREATE INDEX IF NOT EXISTS idx_radar_venues_chain
  ON public.radar_venues(chain, last_seen_at DESC)
  WHERE status = 'confirmed';

DROP TRIGGER IF EXISTS set_radar_venues_updated_at ON public.radar_venues;
CREATE TRIGGER set_radar_venues_updated_at
  BEFORE UPDATE ON public.radar_venues
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── Deny-all RLS (service-role only) ────────────────────────────────────────
-- Same reasoning as radar_scan_events: no owner column, so nothing discovers
-- it, so it is registered in BOTH SERVICE_ROLE_ONLY and SERVICE_ONLY_FORCED in
-- rls-guard_test.ts. A client-writable venue registry is a way to poison every
-- other tenant's map; a client-readable one leaks candidate cells that have not
-- cleared the k-anonymity floor.
ALTER TABLE public.radar_venues ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.radar_venues FROM anon, authenticated;

-- ── Close the loop 00547 left open ──────────────────────────────────────────
-- radar_scan_events.venue_id existed with nothing to reference. Point it here.
-- ON DELETE SET NULL rather than CASCADE: deleting a venue must never delete
-- the observations — they fall back to their geohash cell, which is exactly the
-- unresolved state the `radar_scan_events_located` CHECK already allows.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'radar_scan_events_venue_id_fkey'
       AND conrelid = 'public.radar_scan_events'::regclass
  ) THEN
    ALTER TABLE public.radar_scan_events
      ADD CONSTRAINT radar_scan_events_venue_id_fkey
      FOREIGN KEY (venue_id) REFERENCES public.radar_venues(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── Resolver configuration ──────────────────────────────────────────────────
-- Separate key from `radar_privacy` on purpose. Those are PRIVACY parameters
-- (lowering k is a policy decision); these are RESOLUTION tuning, and mixing a
-- knob anyone may turn into the row that holds the k-floor invites turning the
-- wrong one. It also keeps 00547's ON CONFLICT DO NOTHING seed intact.
INSERT INTO public.system_settings (key, value, value_type, default_value, category, description)
VALUES (
  'radar_venues',
  '{"resolution_enabled": true, "match_radius_meters": 750, "merge_radius_meters": 250, "confirm_min_observations": 8}'::jsonb,
  'json',
  '{"resolution_enabled": true, "match_radius_meters": 750, "merge_radius_meters": 250, "confirm_min_observations": 8}'::jsonb,
  'radar',
  'US-1862: Thrift Radar venue resolution. resolution_enabled false makes every '
  'contribution fall back to its geohash cell (the pre-US-1862 behaviour) '
  'without losing the events. match_radius_meters is how close a scan must be '
  'to a known venue to resolve to it — sized against the ~1.2 km x 0.6 km cell '
  'a candidate centroid is derived from, so a smaller value mostly means more '
  'candidates, not better accuracy. merge_radius_meters is how close two '
  'candidates must be before one is folded into the other. '
  'confirm_min_observations is how many resolved contributions promote a '
  'candidate to confirmed; it is an interest threshold, NOT the privacy floor — '
  'that is radar_privacy.k_anonymity_floor and it counts distinct contributors.'
)
ON CONFLICT (key) DO NOTHING;

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00548')
ON CONFLICT (version) DO NOTHING;
