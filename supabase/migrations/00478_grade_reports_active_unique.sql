-- US-2007: enforce "exactly ONE active grade report per submission".
--
-- 00150 added `superseded_at` and this comment:
--     "superseded_at marks the historical report(s) so every 'current report'
--      read resolves to exactly one ACTIVE row (superseded_at IS NULL)."
-- ...then created a PARTIAL but NON-UNIQUE index. The invariant was documented
-- and unenforced.
--
-- The consumer assumes it holds. grading-pipeline.ts finalizeIfAlreadyGraded()
-- does .eq(submission_id).is(superseded_at, null).maybeSingle(). With two active
-- rows, PostgREST returns PGRST116, the call site discarded the error, `report`
-- came back null, and the function returned false = "nothing to do". The grade
-- then sits UNFINALIZED FOREVER: no certificate is issued, and every retry hits
-- the same duplicate and returns false again. Silent, permanent, and
-- self-perpetuating — the user paid and no retry can recover it.
--
-- Two concurrent finalize/regrade paths are enough to produce it: a retry after
-- a timeout, a double webhook, or the reclaim cron racing a live worker.
--
-- ── De-dupe strategy: SUPERSEDE, never DELETE ────────────────────────────
-- 00440 (the api_keys precedent) deletes its duplicates, which is right there:
-- a repeated key hash means a duplicate issuance, not two distinct facts. Here
-- the opposite is true. A second active grade_report is REAL GRADING OUTPUT —
-- someone paid for it, and it may be the row a certificate already points at.
-- Deleting it would destroy paid work and could orphan a live certificate.
--
-- So: keep the NEWEST active report per submission and mark the older ones
-- superseded, which is exactly the state 00150 intended them to be in. Nothing
-- is lost; the history stays queryable, and every "current report" read
-- resolves to one row as designed.

UPDATE public.grade_reports AS g
SET superseded_at = now()
WHERE g.superseded_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM public.grade_reports AS newer
    WHERE newer.submission_id = g.submission_id
      AND newer.superseded_at IS NULL
      -- "newer" = later created_at, with id as a deterministic tie-break so a
      -- same-timestamp pair still resolves to exactly one survivor.
      AND (newer.created_at > g.created_at
           OR (newer.created_at = g.created_at AND newer.id > g.id))
  );

-- Now the invariant can be enforced. Partial (superseded rows are unconstrained,
-- so a submission may accumulate any number of historical reports) and UNIQUE
-- (at most one active).
--
-- Not CONCURRENTLY: it cannot run inside a transaction block, and
-- apply-prod-migrations.sh runs each file as one unit — matching 00440's plain
-- CREATE UNIQUE INDEX keeps this consistent with how migrations are applied here.
-- grade_reports is not large enough for the brief write lock to matter.
DROP INDEX IF EXISTS public.idx_grade_reports_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_grade_reports_active
  ON public.grade_reports (submission_id)
  WHERE superseded_at IS NULL;

COMMENT ON INDEX public.idx_grade_reports_active IS
  'US-2007: UNIQUE, enforcing one active (superseded_at IS NULL) grade_report '
  'per submission. 00150 documented this invariant but created a non-unique '
  'index; a duplicate made finalizeIfAlreadyGraded() PGRST116 and silently '
  'strand the grade unfinalized forever. Do not drop the UNIQUE.';

-- US-1108: self-record so the edge schema-version boot guard (US-778) stays
-- truthful regardless of how the SQL was applied.
INSERT INTO public.applied_migrations (version) VALUES ('00478') ON CONFLICT DO NOTHING;
