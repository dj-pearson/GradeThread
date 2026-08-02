-- READ-ONLY production diagnostics. Answers the prod-data questions that five
-- open stories are each individually blocked on, in ONE session.
--
--   SUPABASE_DB_URL="postgres://…@host:5432/postgres" \
--     psql "$SUPABASE_DB_URL" -f scripts/prod-diagnostics.sql
--
-- ⚠️ NOTHING HERE WRITES. No INSERT, UPDATE, DELETE, CREATE, ALTER or DROP.
-- It is safe to run on prod during business hours; every query is a SELECT and
-- the heaviest is a table-size lookup from the catalog, not a scan. If you are
-- reviewing this file before running it, that property is the thing to check —
-- it is the reason this exists as a script rather than as ad-hoc pasted SQL.
--
-- WHY ONE SCRIPT. Each of the stories below has sat open for weeks with its
-- last acceptance criterion reading "needs prod access". That is five separate
-- asks of the one person who can answer them, which is how a question stops
-- being asked. One paste, one output, five answers.
--
--   §1  US-2009 AC2 — is any migration MISSING from the middle of the sequence?
--   §2  US-2009 AC2 — is any recorded migration a PHANTOM with no file?
--   §3  US-2021 AC3 — how much does the email_deliveries purge reclaim?
--   §4  US-2006 AC3 — how much past-retention imagery is still unpurged?
--   §5  US-2041 AC4 — was any dispute resolved on the wrong displayed grade?
--   §6  context — row counts for the tables the admin dashboard aggregates.
--
-- Paste the whole output back. Nothing in it is a secret: no keys, no tokens,
-- no email addresses, no image URLs. §5 returns dispute IDs and grades, which
-- are operator data you already see in the admin UI.

\pset pager off
\timing on

\echo ''
\echo '════════════════════════════════════════════════════════════════'
\echo '§1  US-2009 AC2 — MID-SEQUENCE MIGRATION GAPS'
\echo '════════════════════════════════════════════════════════════════'
\echo 'The boot guard compares a MAX. A gap below the max is structurally'
\echo 'invisible: the watermark only moves forward, and apply-prod-migrations.sh'
\echo 'skips any file at or below it. This already happened once — 00005 never'
\echo 'landed, the watermark advanced anyway, and every finalized grade silently'
\echo 'no-oped its developer webhook with a 42703 for an unknown duration.'
\echo ''
\echo 'EXPECTED: the numbers below are contiguous from 00254 upward.'
\echo 'Any number listed under "gap_start..gap_end" is a migration that never ran.'
\echo ''

WITH applied AS (
  SELECT DISTINCT version
  FROM public.applied_migrations
  WHERE version ~ '^[0-9]{5}$'
    AND version >= '00254'          -- the self-recording footer starts here;
                                     -- below it, absence carries no signal
),
numbered AS (
  SELECT version::int AS v,
         LEAD(version::int) OVER (ORDER BY version::int) AS next_v
  FROM applied
)
SELECT
  lpad((v + 1)::text, 5, '0')       AS gap_start,
  lpad((next_v - 1)::text, 5, '0')  AS gap_end,
  (next_v - v - 1)                  AS missing_count
FROM numbered
WHERE next_v IS NOT NULL
  AND next_v > v + 1
ORDER BY v;

\echo ''
\echo '-- Head and count, for orientation:'
SELECT
  min(version) FILTER (WHERE version >= '00254') AS lowest_footer_era,
  max(version)                                    AS highest_recorded,
  count(*) FILTER (WHERE version >= '00254')      AS footer_era_recorded
FROM public.applied_migrations
WHERE version ~ '^[0-9]{5}$';

\echo ''
\echo '════════════════════════════════════════════════════════════════'
\echo '§2  US-2009 AC2 — PHANTOM VERSIONS (recorded, but no file exists)'
\echo '════════════════════════════════════════════════════════════════'
\echo 'The opposite direction, and NOT hypothetical: /health/ready once reported'
\echo 'applied=00479 while no 00479 file had ever existed in the repo. That is'
\echo 'why 00480+ were numbered around it — reusing 00479 would have satisfied'
\echo 'the boot guard off a stale row even if the SQL never ran.'
\echo ''
\echo 'Cross-check the versions below against `ls supabase/migrations`.'
\echo 'Any version here with no matching file is a phantom.'
\echo ''

SELECT version, min(applied_at) AS first_recorded_at
FROM public.applied_migrations
WHERE version ~ '^[0-9]{5}$'
  AND version >= '00470'            -- recent tail only; older phantoms would
                                     -- already have surfaced as a gap in §1
GROUP BY version
ORDER BY version;

\echo ''
\echo '════════════════════════════════════════════════════════════════'
\echo '§3  US-2021 AC3 — EMAIL_DELIVERIES PURGE RECLAIM'
\echo '════════════════════════════════════════════════════════════════'
\echo 'The purge is written, capped at 5,000 rows a night, and has never run on'
\echo 'the historical backlog. Measure BEFORE the first sweep, or the reclaim is'
\echo 'assumed rather than known. sent rows older than 90d are DELETED;'
\echo 'dead_letter rows are never deleted, only their html body is stripped'
\echo 'after 180d, because deleting them would destroy the evidence that mail'
\echo 'went undelivered.'
\echo ''

SELECT
  pg_size_pretty(pg_total_relation_size('public.email_deliveries')) AS total_size,
  pg_size_pretty(pg_relation_size('public.email_deliveries'))       AS heap_size,
  count(*)                                                          AS total_rows,
  count(*) FILTER (
    WHERE status = 'sent' AND created_at < now() - interval '90 days'
  )                                                                 AS purgeable_sent_rows,
  count(*) FILTER (
    WHERE status = 'dead_letter'
      AND created_at < now() - interval '180 days'
      AND html IS NOT NULL
  )                                                                 AS strippable_bodies,
  -- Nights to drain at the 5,000/run cap. If this is large, consider a
  -- one-off manual drain rather than waiting out the cron.
  ceil(
    count(*) FILTER (
      WHERE status = 'sent' AND created_at < now() - interval '90 days'
    )::numeric / 5000
  )                                                                 AS nights_to_drain
FROM public.email_deliveries;

\echo ''
\echo '════════════════════════════════════════════════════════════════'
\echo '§4  US-2006 AC3 — UNPURGED PAST-RETENTION IMAGERY'
\echo '════════════════════════════════════════════════════════════════'
\echo 'The retention sweep stalled after its second run: it re-selected the same'
\echo 'already-purged rows, found no images, and reported success. The query is'
\echo 'fixed, but the backlog that accumulated while it was stalled has never'
\echo 'been quantified. This is how much GDPR-expired imagery is still stored.'
\echo ''

SELECT
  count(DISTINCT s.id)  AS expired_submissions_with_images,
  count(si.id)          AS image_rows_to_purge,
  min(s.created_at)     AS oldest_expired,
  max(s.created_at)     AS newest_expired
FROM public.submissions s
JOIN public.submission_images si ON si.submission_id = s.id
WHERE s.created_at < now() - interval '90 days';

\echo ''
\echo '════════════════════════════════════════════════════════════════'
\echo '§5  US-2041 AC4 — DISPUTES RESOLVED ON A MISROUNDED GRADE'
\echo '════════════════════════════════════════════════════════════════'
\echo 'admin/disputes.tsx rounded the weighted overall to 0.5 while the server'
\echo 'stored 0.1, so an operator saw a number up to 0.2 away from what was'
\echo 'persisted — in BOTH directions. Grade tier is a pricing input, so the'
\echo 'question is whether any dispute was decided on the wrong displayed value.'
\echo ''
\echo 'A row here is NOT proof of harm — it means the displayed and stored'
\echo 'numbers differed at resolution time. Read the ones where the 0.5-rounded'
\echo 'value crosses a tier boundary first; those are the ones that could have'
\echo 'changed a decision.'
\echo ''

-- NOTE ON THE COLUMNS: `disputes` has NO resolved_at. Its terminal states are
-- the enum values 'resolved' and 'rejected' (00001), and `updated_at` is the
-- only timestamp that moves when one is set. So "resolved at" below means
-- "last touched while in a terminal state", which is the closest thing the
-- schema records. It is good enough for this question — we are looking for
-- decisions made before the rounding was fixed, not for an audit trail.

SELECT
  d.id                                        AS dispute_id,
  d.status,
  d.updated_at                                AS decided_at_approx,
  gr.overall_score                            AS stored_grade,
  round(gr.overall_score * 2) / 2             AS would_have_displayed,
  abs(gr.overall_score - round(gr.overall_score * 2) / 2) AS drift
FROM public.disputes d
JOIN public.grade_reports gr ON gr.id = d.grade_report_id
WHERE d.status IN ('resolved', 'rejected')
  AND abs(gr.overall_score - round(gr.overall_score * 2) / 2) >= 0.1
ORDER BY drift DESC, d.updated_at DESC
LIMIT 50;

\echo ''
\echo '-- How many in total, so the LIMIT above is not mistaken for the whole set:'
SELECT count(*) AS total_decided_disputes_with_drift
FROM public.disputes d
JOIN public.grade_reports gr ON gr.id = d.grade_report_id
WHERE d.status IN ('resolved', 'rejected')
  AND abs(gr.overall_score - round(gr.overall_score * 2) / 2) >= 0.1;

\echo ''
\echo '════════════════════════════════════════════════════════════════'
\echo '§6  CONTEXT — admin dashboard aggregate table sizes (US-2390)'
\echo '════════════════════════════════════════════════════════════════'
\echo 'The dashboard still loads every row of these three to build its funnel'
\echo 'and cohort charts. If any is past the PostgREST row ceiling, those charts'
\echo 'are already reading a truncated set. The KPIs no longer are — they moved'
\echo 'to exact server-side counts — but the charts have not.'
\echo ''

SELECT 'submissions'   AS tbl, count(*) AS rows FROM public.submissions
UNION ALL SELECT 'grade_reports', count(*) FROM public.grade_reports
UNION ALL SELECT 'sales',         count(*) FROM public.sales
UNION ALL SELECT 'users',         count(*) FROM public.users
ORDER BY rows DESC;

\echo ''
\echo '════════════════════════════════════════════════════════════════'
\echo 'Done. Paste the whole output back — nothing above is a secret.'
\echo '════════════════════════════════════════════════════════════════'
