-- US-1864: Thrift Radar — the PERSONAL sourcing-history layer ("your best
-- stores"). Rule 7 of vault/20-domain/thrift-radar.md, made real:
--
--   "The personal layer is free, opt-in-independent, and must work at n=1. A
--    user's own sourcing history per venue is their own data: it requires no
--    contribution consent, is available on every plan, and must be useful with
--    zero network data anywhere near them."
--
-- Two objects, and the reason each exists:
--
--   1. `sources.radar_venue_id` — the JOIN between a reseller's own named store
--      (which has the money in it: items, spend, sales) and the shared venue the
--      US-1862 resolver places a scan at (which has the visits in it). Without
--      it the two halves of "my best stores" can never meet, because a scan
--      knows a venue and an item knows a source and nothing knew they were the
--      same shop.
--
--   2. `radar_personal_scans` — the reseller's OWN scan log. It cannot be
--      derived from `radar_scan_events`, and that is by design, not an
--      oversight: 00550 deliberately carries no account column, so there is no
--      way to ask "which of these were mine" and there must never be one. The
--      personal layer therefore needs its own store, and this is it — owner-read,
--      service-role-write, cascading with the account.
--
-- The privacy shape is inherited WHOLE from 00550 rather than relaxed because
-- the rows are the user's own:
--
--   • NO COORDINATE COLUMN. A visit row keeps a `venue_id` or a coarse
--     `geohash` cell. "Their own data" is not a reason to start keeping a
--     movement trail of a NAMED person — it is the reason to be more careful,
--     since these rows are not pseudonymised the way a contribution is.
--   • The same length CHECK on `geohash`, so a precision change cannot turn a
--     neighbourhood cell into a doorstep here either.
--   • The same located CHECK: a visit with neither a venue nor a cell is not a
--     visit, and inventing one would be worse than dropping it.
--
-- Retention: deliberately none. These rows are the subject's own record of
-- where they source, they are exported by GET /api/account/export, they are
-- deletable by the owner through the RLS policy below, and they die with the
-- account through ON DELETE CASCADE. Pruning somebody's own trading history on
-- a timer would be deleting the thing the feature is for. That is NOT a
-- relaxation of rule 4 — rule 4 governs the ANALYTICAL path, whose retention
-- (radar_privacy.raw_event_retention_days) is unchanged.

-- ── The source → venue link ─────────────────────────────────────────────────
ALTER TABLE public.sources
  ADD COLUMN IF NOT EXISTS radar_venue_id uuid
    REFERENCES public.radar_venues(id) ON DELETE SET NULL;

-- Note what this column is NOT protected against, and why that is acceptable.
-- 00008 gives `sources` a plain authenticated UPDATE policy over the whole row,
-- so a client can set its own `radar_venue_id` directly and skip the "venue is
-- live / follow the merge tombstone" checks in `linkSourceToVenue`. The blast
-- radius is the caller's OWN row: `radar_venues` is deny-all, so venue ids are
-- not listable, and the personal read returns only a display name and a chain tag
-- for the linked venue — no aggregate, so this is not a route around the
-- k-anonymity floor. A worse link than the endpoint would have made is a worse
-- ranking for the person who made it. Not worth a column-level trigger.
COMMENT ON COLUMN public.sources.radar_venue_id IS
  'US-1864: the shared Thrift Radar venue this named source IS, when the owner '
  'has linked them. Set through POST /api/flipdesk/radar/my-stores/link, which '
  'verifies the source belongs to the caller and the venue is live. ON DELETE '
  'SET NULL: a merged-away or removed venue must never take a reseller''s own '
  'source row with it.';

-- One index, and it is the shape the personal read actually uses: every source
-- for one tenant, with the venue id it resolves to.
CREATE INDEX IF NOT EXISTS idx_sources_radar_venue
  ON public.sources(user_id, radar_venue_id)
  WHERE radar_venue_id IS NOT NULL;

-- ── The personal visit log ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.radar_personal_scans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The workspace owner the scan was billed to. A plain `user_id`, unlike
  -- radar_scan_events' rotating digest, because the whole point of this table is
  -- to give the row BACK to the person — which is also why it is owner-readable
  -- and cascades on account deletion.
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- Where. The venue the US-1862 resolver placed the scan at, and/or the coarse
  -- cell it fell in. NO raw fix, here or anywhere.
  venue_id    uuid REFERENCES public.radar_venues(id) ON DELETE SET NULL,
  geohash     text,
  brand       text,
  category    text,
  -- Mirrors bandForGrade() in lib/resale-condition.ts. A band, not a numeric
  -- grade: the estimate is a shadow grade, and storing it to 0.1 would invite
  -- someone to average it into a figure it cannot support.
  grade_band  text NOT NULL DEFAULT 'ungraded'
                CHECK (grade_band IN ('high', 'mid', 'low', 'ungraded')),
  -- Mirrors BuyRecommendation in lib/scout-decision.ts.
  verdict     text NOT NULL DEFAULT 'unknown'
                CHECK (verdict IN ('buy', 'maybe', 'skip', 'unknown')),
  scanned_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT radar_personal_scans_located
    CHECK (venue_id IS NOT NULL OR geohash IS NOT NULL),
  CONSTRAINT radar_personal_scans_geohash_coarse
    CHECK (geohash IS NULL OR geohash ~ '^[0-9b-hjkmnp-z]{4,7}$')
);

COMMENT ON TABLE public.radar_personal_scans IS
  'US-1864: a reseller''s OWN Thrift Radar visit log — the free, consent-'
  'independent personal layer (rule 7). Owner-readable and owner-deletable; '
  'written only by the edge service-role client. No coordinate column, by '
  'design — see vault/20-domain/thrift-radar.md.';

-- The personal read: this tenant's visits, newest first, grouped by venue.
CREATE INDEX IF NOT EXISTS idx_radar_personal_scans_user_venue
  ON public.radar_personal_scans(user_id, venue_id, scanned_at DESC);

CREATE INDEX IF NOT EXISTS idx_radar_personal_scans_user_recent
  ON public.radar_personal_scans(user_id, scanned_at DESC);

-- ── RLS: the owner reads and may erase; only the edge writes ────────────────
ALTER TABLE public.radar_personal_scans ENABLE ROW LEVEL SECURITY;

-- `(select auth.uid())` rather than a bare `auth.uid()` so the planner hoists
-- one InitPlan instead of re-evaluating per row (US-1927; rls-guard_test.ts
-- fails the bare form).
DROP POLICY IF EXISTS "Users read own radar visits" ON public.radar_personal_scans;
CREATE POLICY "Users read own radar visits"
  ON public.radar_personal_scans FOR SELECT
  USING ((select auth.uid()) = user_id);

-- Erasure without closing the account. A visit history you cannot clear is a
-- location history somebody else is keeping for you.
DROP POLICY IF EXISTS "Users delete own radar visits" ON public.radar_personal_scans;
CREATE POLICY "Users delete own radar visits"
  ON public.radar_personal_scans FOR DELETE
  USING ((select auth.uid()) = user_id);

-- No INSERT or UPDATE policy, deliberately. A client-writable visit log is a
-- client-writable "my best stores" ranking, and the row is only meaningful if
-- the server that resolved the venue is the thing that wrote it.

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00553')
ON CONFLICT (version) DO NOTHING;
