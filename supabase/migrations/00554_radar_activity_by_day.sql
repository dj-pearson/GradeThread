-- US-1865: Thrift Radar — the weekly activity pattern the venue panel shows.
--
-- "Which day is this store worth driving to" is the question a sourcing map is
-- for, and until now the aggregate carried only totals and a freshness stamp.
-- This adds the seven numbers behind that pattern to the SAME row, which is the
-- whole point: the histogram inherits the k-anonymity floor
-- (`contributor_count >= 2` CHECK plus the configured
-- `radar_privacy.k_anonymity_floor`), the hourly recompute and the sweep,
-- without any of them being copied.
--
-- Full rule set: vault/20-domain/thrift-radar.md. Two rules bear directly on
-- this column:
--
--   • RULE 6 (the k-floor) is why this is a column and not a second table. A
--     weekly rhythm published for a venue whose counts are withheld would be a
--     timetable for one person's Saturdays. Riding the existing row means there
--     is no code path that can serve one without the other.
--   • RULE 4 (no precise coordinate survives) is why the day is bucketed by the
--     VENUE's approximate solar time — `offsetMinutesForLongitude` in
--     radar-aggregates.ts, derived from the venue's own cell-centre longitude —
--     rather than by a timezone we would have to look up somewhere else with the
--     coordinate in hand. Sunday is index 1 of the array (Postgres arrays are
--     1-based; the served DTO is 0-based, index 0 = Sunday).
--
-- No backfill. The aggregation job rewrites every servable row each run and
-- deletes what it did not rewrite, so the default all-zero week is replaced
-- within the hour, and a row still holding zeros renders as "no pattern yet"
-- rather than as a lie about a quiet store.

ALTER TABLE public.radar_venue_aggregates
  ADD COLUMN IF NOT EXISTS dow_counts integer[] NOT NULL
    DEFAULT ARRAY[0, 0, 0, 0, 0, 0, 0];

-- Length is part of the type as far as every reader is concerned, so it is a
-- constraint rather than an assumption. Dropped-then-added so re-running the
-- migration cannot fail on an existing constraint of the same name.
ALTER TABLE public.radar_venue_aggregates
  DROP CONSTRAINT IF EXISTS radar_venue_aggregates_dow_counts_len;
ALTER TABLE public.radar_venue_aggregates
  ADD CONSTRAINT radar_venue_aggregates_dow_counts_len
    CHECK (cardinality(dow_counts) = 7);

COMMENT ON COLUMN public.radar_venue_aggregates.dow_counts IS
  'US-1865: scans per day of the week at the venue''s approximate LOCAL day, '
  'array position 1 = Sunday. Sums to scan_count. Served only as part of a row '
  'that already clears the k-anonymity floor — see vault/20-domain/thrift-radar.md '
  'rule 6. Local day is solar time from the venue''s longitude (rule 4: we do not '
  'send a coordinate anywhere to resolve a real timezone).';

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00554')
ON CONFLICT (version) DO NOTHING;
