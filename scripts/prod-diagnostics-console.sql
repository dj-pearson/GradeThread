-- ══════════════════════════════════════════════════════════════════
-- GENERATED — do not edit. Source: scripts/prod-diagnostics.sql
--   node scripts/gen-console-diagnostics.mjs
--
-- Same queries, with psql meta-commands (\pset, \timing, \echo) removed so
-- this is valid in a SQL CONSOLE (Supabase SQL editor, pgAdmin, DBeaver).
-- Those lines are interpreted by the psql CLIENT; a console forwards them to
-- the server, which rejects the first one with:
--   ERROR: 42601: syntax error at or near "\"
--
-- ⚠️ HOW TO RUN THIS IN A CONSOLE. Most SQL editors show only the LAST result
-- set when you execute a whole file. Run it ONE SECTION AT A TIME — there are
-- 27, marked `§1` … `§27` — or use psql with the original file,
-- which prints every result with its banner.
--
-- The count above is DERIVED from the source's own index at generation time.
-- It was hardcoded until 2026-08-17 and had been wrong by fourteen sections,
-- which is how an operator runs half the diagnostics and believes they ran all.
--
-- Still strictly read-only: no INSERT, UPDATE, DELETE, CREATE, ALTER or DROP.
-- ══════════════════════════════════════════════════════════════════

-- READ-ONLY production diagnostics. Answers, in ONE session, the prod-data
-- questions that open stories are each individually blocked on — the index below
-- names which story each section is for, and that index is the count. It said
-- "nineteen" while carrying 27 sections for 23 stories, which is the same way
-- the generated console copy came to advertise §1–§13 of 27: a number written
-- once and then outgrown. Read the index, not a total.
--
--   SUPABASE_DB_URL="postgres://…@host:5432/postgres" \
--     psql "$SUPABASE_DB_URL" -f scripts/prod-diagnostics.sql
--
-- ⚠️ NOTHING HERE WRITES. No INSERT, UPDATE, DELETE, CREATE, ALTER or DROP.
-- It is safe to run on prod during business hours; every query is a SELECT.
-- §1–§9 are catalog lookups and bounded reads. §10 is the one SCAN — of
-- items_full, bounded by the inventory row count §6 reports — and it is called
-- out rather than averaged into the claim, because a sentence that is 90% true
-- is what stops the next person re-reading this file at all. If you are
-- reviewing this file before running it, that property is the thing to check —
-- it is the reason this exists as a script rather than as ad-hoc pasted SQL.
--
-- WHY ONE SCRIPT. Each of the stories below has sat open for weeks with its
-- last acceptance criterion reading "needs prod access". That is nineteen
-- separate asks of the one person who can answer them, which is how a question
-- stops being asked. One paste, one output, every answer.
--
--   §1  US-2009 AC2 — is any migration MISSING from the middle of the sequence?
--   §2  US-2009 AC2 — is any recorded migration a PHANTOM with no file?
--   §3  US-2021 AC3 — how much does the email_deliveries purge reclaim?
--   §4  US-2006 AC3 — how much past-retention imagery is still unpurged?
--   §5  US-2041 AC4 — was any dispute resolved on the wrong displayed grade?
--   §6  context — row counts for the tables the admin dashboard aggregates.
--   §7  US-2293 AC3 — overage packs refunded before the credit clawback shipped.
--   §8  US-2031 AC1 — is the affiliate hold window long enough?
--   §9  US-2034 AC2 — exemplar sets gated before the golden-set leak was fixed.
--   §10 US-2331 AC4 — the items_full payload for the largest account.
--   §11 US-2313 AC4 — are the ops alert destinations actually configured?
--   §12 US-2359 AC4 — free-tier buyers who used a paid buyer feature.
--   §13 US-2322 AC5 — sellers disconnected by an invalid_grant refresh.
--   §14 US-2347 AC1 — SECURITY DEFINER functions callable by PUBLIC.
--   §15 US-2347 AC3 — golden-set size and which prompt versions are live.
--   §16 US-2347 AC4 — does the billing-source check still exclude Play?
--   §17 US-2398 AC3 — how far off were the admin paid/churn counts?
--   §18 US-2406 AC5 — has any feature flag been targeted at a plan?
--   §19 US-2288 AC4 — free-trial exposure: started, converted, and spend.
--   §20 US-2289 AC5 — who was charged more than once for one garment.
--   §21 US-2117 — has any agreement row actually recorded a disclosure version?
--   §22 US-2444 AC1 — what migration 00122 created, read out of the database.
--   §23 US-2403 AC1 — is the denied-function segfault path live on this image?
--   §24 US-2286 AC5 — which entitlements came from a sandbox purchase.
--   §25 US-2606 — did migration 00594 actually land? (run it AFTER applying)
--   §26 US-2304 AC4 — how often did a missing tag photo cost a vision call?
--   §27 US-2610 AC5 — which required photo is actually blocking people?
--
-- Paste the whole output back. Nothing in it is a secret: no keys, no tokens,
-- no email addresses, no image URLs. §5 returns dispute IDs and grades, which
-- are operator data you already see in the admin UI.

-- ════════════════════════════════════════════════════════════════
-- §1  US-2009 AC2 — MID-SEQUENCE MIGRATION GAPS
-- ════════════════════════════════════════════════════════════════
-- The boot guard compares a MAX. A gap below the max is structurally
-- invisible: the watermark only moves forward, and apply-prod-migrations.sh
-- skips any file at or below it. This already happened once — 00005 never
-- landed, the watermark advanced anyway, and every finalized grade silently
-- no-oped its developer webhook with a 42703 for an unknown duration.

-- EXPECTED: the numbers below are contiguous from 00254 upward.
-- Any number listed under "gap_start..gap_end" is a migration that never ran.

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

-- -- Head and count, for orientation:
SELECT
  min(version) FILTER (WHERE version >= '00254') AS lowest_footer_era,
  max(version)                                    AS highest_recorded,
  count(*) FILTER (WHERE version >= '00254')      AS footer_era_recorded
FROM public.applied_migrations
WHERE version ~ '^[0-9]{5}$';

-- ════════════════════════════════════════════════════════════════
-- §2  US-2009 AC2 — PHANTOM VERSIONS (recorded, but no file exists)
-- ════════════════════════════════════════════════════════════════
-- The opposite direction, and NOT hypothetical: /health/ready once reported
-- applied=00479 while no 00479 file had ever existed in the repo. That is
-- why 00480+ were numbered around it — reusing 00479 would have satisfied
-- the boot guard off a stale row even if the SQL never ran.

-- Cross-check the versions below against `ls supabase/migrations`.
-- Any version here with no matching file is a phantom.

SELECT version, min(applied_at) AS first_recorded_at
FROM public.applied_migrations
WHERE version ~ '^[0-9]{5}$'
  AND version >= '00470'            -- recent tail only; older phantoms would
                                     -- already have surfaced as a gap in §1
GROUP BY version
ORDER BY version;

-- ════════════════════════════════════════════════════════════════
-- §3  US-2021 AC3 — EMAIL_DELIVERIES PURGE RECLAIM
-- ════════════════════════════════════════════════════════════════
-- The purge is written, capped at 5,000 rows a night, and has never run on
-- the historical backlog. Measure BEFORE the first sweep, or the reclaim is
-- assumed rather than known. sent rows older than 90d are DELETED;
-- dead_letter rows are never deleted, only their html body is stripped
-- after 180d, because deleting them would destroy the evidence that mail
-- went undelivered.

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

-- ════════════════════════════════════════════════════════════════
-- §4  US-2006 AC3 — UNPURGED PAST-RETENTION IMAGERY
-- ════════════════════════════════════════════════════════════════
-- The retention sweep stalled after its second run: it re-selected the same
-- already-purged rows, found no images, and reported success. The query is
-- fixed, but the backlog that accumulated while it was stalled has never
-- been quantified. This is how much GDPR-expired imagery is still stored.

SELECT
  count(DISTINCT s.id)  AS expired_submissions_with_images,
  count(si.id)          AS image_rows_to_purge,
  min(s.created_at)     AS oldest_expired,
  max(s.created_at)     AS newest_expired
FROM public.submissions s
JOIN public.submission_images si ON si.submission_id = s.id
WHERE s.created_at < now() - interval '90 days';

-- ════════════════════════════════════════════════════════════════
-- §5  US-2041 AC4 — DISPUTES RESOLVED ON A MISROUNDED GRADE
-- ════════════════════════════════════════════════════════════════
-- admin/disputes.tsx rounded the weighted overall to 0.5 while the server
-- stored 0.1, so an operator saw a number up to 0.2 away from what was
-- persisted — in BOTH directions. Grade tier is a pricing input, so the
-- question is whether any dispute was decided on the wrong displayed value.

-- A row here is NOT proof of harm — it means the displayed and stored
-- numbers differed at resolution time. Read the ones where the 0.5-rounded
-- value crosses a tier boundary first; those are the ones that could have
-- changed a decision.

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

-- -- How many in total, so the LIMIT above is not mistaken for the whole set:
SELECT count(*) AS total_decided_disputes_with_drift
FROM public.disputes d
JOIN public.grade_reports gr ON gr.id = d.grade_report_id
WHERE d.status IN ('resolved', 'rejected')
  AND abs(gr.overall_score - round(gr.overall_score * 2) / 2) >= 0.1;

-- ════════════════════════════════════════════════════════════════
-- §6  CONTEXT — admin dashboard aggregate table sizes (US-2390)
-- ════════════════════════════════════════════════════════════════
-- The dashboard still loads every row of these three to build its funnel
-- and cohort charts. If any is past the PostgREST row ceiling, those charts
-- are already reading a truncated set. The KPIs no longer are — they moved
-- to exact server-side counts — but the charts have not.

SELECT 'submissions'   AS tbl, count(*) AS rows FROM public.submissions
UNION ALL SELECT 'grade_reports', count(*) FROM public.grade_reports
UNION ALL SELECT 'sales',         count(*) FROM public.sales
UNION ALL SELECT 'users',         count(*) FROM public.users
ORDER BY rows DESC;

-- ════════════════════════════════════════════════════════════════
-- §7  US-2293 AC3 — OVERAGE PACKS REFUNDED BEFORE THE CLAWBACK
-- ════════════════════════════════════════════════════════════════
-- Until the US-2293 fix, refunding an API overage pack returned the money
-- and left the credits. The grant branch handled three products; the refund
-- branch dispatched on only two, so api_overage fell through to a log line.

-- The fix stops it recurring. It does NOT reconcile the balances that were
-- already wrong, and nothing else will — the ledger is append-only, so a
-- missing debit stays missing until someone writes one.

-- A row below is a user whose purchases and clawbacks do not balance.
-- Compare the count against your refunded api_overage charges in Stripe:
-- a purchase with no matching refund_clawback is the shortfall to correct.

SELECT
  user_id,
  count(*) FILTER (WHERE reason = 'api_overage_purchase')        AS purchases,
  count(*) FILTER (WHERE reason LIKE '%refund%')                 AS clawbacks,
  sum(delta) FILTER (WHERE reason = 'api_overage_purchase')      AS credits_granted,
  sum(delta) FILTER (WHERE reason LIKE '%refund%')               AS credits_reversed,
  max(created_at) FILTER (WHERE reason = 'api_overage_purchase') AS last_purchase
FROM public.api_credit_transactions
GROUP BY user_id
HAVING count(*) FILTER (WHERE reason = 'api_overage_purchase') > 0
ORDER BY credits_granted DESC NULLS LAST
LIMIT 100;

-- -- Current wallet balances, so a clawback is not applied blind. The wallet
-- -- has CHECK (balance >= 0), so a debit larger than the balance would fail
-- -- the constraint rather than going negative — clamp it and record the
-- -- shortfall, which is what AC1 does for new refunds.
SELECT count(*) AS wallets, sum(balance) AS total_credits_outstanding
FROM public.api_credit_wallet;

-- ════════════════════════════════════════════════════════════════
-- §8  US-2031 AC1 — IS THE AFFILIATE HOLD WINDOW LONG ENOUGH?
-- ════════════════════════════════════════════════════════════════
-- affiliate_commissions has a hold_until window (default 30 days) but no
-- refund or chargeback reversal. A referred subscription refunded AFTER the
-- hold expires leaves the commission paid and unrecoverable.

-- AC1 does not ask you to build a clawback. It asks you to MEASURE first,
-- then choose: extend the hold, build the clawback, or accept the loss with
-- a number next to it. All three are defensible; guessing is not.

-- Read this as: how long does a commission actually sit before payout, and
-- how many are already paid. Pair it with your Stripe refund-age data — the
-- question is what share of refunds land after the hold, and only Stripe
-- knows the refund dates.

SELECT
  status,
  count(*)                                                        AS commissions,
  sum(amount)                                                     AS total_amount,
  min(created_at)                                                 AS oldest,
  -- Days from accrual to the end of hold. If this clusters at exactly 30 the
  -- default is untouched; a spread means someone has been setting it per row.
  round(avg(extract(epoch FROM (hold_until - created_at)) / 86400)::numeric, 1)
                                                                  AS avg_hold_days
FROM public.affiliate_commissions
GROUP BY status
ORDER BY status;

-- -- Paid commissions by age, so the exposure window is concrete. A refund
-- -- arriving today can only be clawed back from a commission still accrued;
-- -- everything under `paid` is already out the door.
SELECT
  count(*) FILTER (WHERE status = 'paid')                         AS paid_total,
  sum(amount) FILTER (WHERE status = 'paid')                      AS paid_amount,
  count(*) FILTER (WHERE status = 'accrued' AND hold_until > now()) AS still_held,
  sum(amount) FILTER (WHERE status = 'accrued' AND hold_until > now()) AS still_held_amount,
  count(*) FILTER (WHERE status = 'accrued' AND hold_until <= now()) AS due_for_payout,
  count(*) FILTER (WHERE status = 'void')                         AS voided
FROM public.affiliate_commissions;

-- ════════════════════════════════════════════════════════════════
-- §9  US-2034 AC2 — EXEMPLAR SETS GATED BEFORE THE LEAK WAS FIXED
-- ════════════════════════════════════════════════════════════════
-- Until 2026-07-18 the few-shot exemplar pool did not exclude golden-set
-- sources, so an exemplar set could be evaluated against cases it had been
-- built from. That does not make a set WRONG — it makes its eval number
-- unearned, because the gate was marking its own homework.

-- Any set CREATED before that date carries an eval figure that proves less
-- than it appears to. A set still ACTIVE is the one that matters: it is
-- shaping live grading prompts on the strength of that number.

-- AC2 asks you to re-run the gate for those. AC3 asks whether any published
-- accuracy figure cites them — if a set below is active AND pre-fix, treat
-- any number derived from it as unrestated until the re-run.

SELECT
  version_name,
  garment_category,
  status,
  is_active,
  eval_passed,
  eval_mae,
  eval_agreement_rate,
  exemplar_count,
  created_at,
  -- The whole question, in one column.
  (created_at < TIMESTAMPTZ '2026-07-18') AS gated_before_fix
FROM public.grading_exemplar_sets
ORDER BY is_active DESC, created_at DESC
LIMIT 100;

-- -- The short answer. A non-zero first number is the re-run list.
SELECT
  count(*) FILTER (
    WHERE is_active AND created_at < TIMESTAMPTZ '2026-07-18'
  )                                                    AS active_and_pre_fix,
  count(*) FILTER (WHERE created_at < TIMESTAMPTZ '2026-07-18') AS all_pre_fix,
  count(*) FILTER (WHERE is_active)                    AS active_total,
  count(*)                                             AS sets_total
FROM public.grading_exemplar_sets;

-- ════════════════════════════════════════════════════════════════
-- §10  US-2331 AC4 — the items_full payload, before and after
-- ════════════════════════════════════════════════════════════════
-- The one section that SCANS rather than reading the catalog. It is bounded by
-- the inventory row count §6 reports (hundreds today, not millions), so it is
-- still safe during business hours — but it is a scan, and the header says so.
--
-- WHAT THE NUMBERS MEAN. Two changes are being measured, and they are separate:
--
--   • The DETAIL page used to fetch every row and `.find()` the one it wanted.
--     Before = full_bytes for that account. After = one row. So the ratio is
--     simply `items`:1, and `avg_row_bytes` turns it into bytes.
--   • Every LIST surface still reads every row, but through a projection that
--     drops four detail-only columns (item_description, notes, comps,
--     ai_field_sources). `detail_only_bytes` is exactly what that saves.
--
-- Accounts are reported by RANK, not by id: the question is about the largest
-- account's payload, and naming the seller adds nothing to the answer.

-- -- Top 5 accounts by inventory size. full_bytes is the OLD payload.
SELECT
  row_number() OVER (ORDER BY count(*) DESC)                  AS rank,
  count(*)                                                    AS items,
  pg_size_pretty(sum(pg_column_size(f))::bigint)              AS full_bytes,
  pg_size_pretty(
    sum(
      pg_column_size(f.item_description)
      + pg_column_size(f.notes)
      + pg_column_size(f.comps)
      + pg_column_size(f.ai_field_sources)
    )::bigint
  )                                                           AS detail_only_bytes,
  (sum(pg_column_size(f)) / greatest(count(*), 1))::int       AS avg_row_bytes
FROM public.items_full f
GROUP BY f.user_id
ORDER BY count(*) DESC
LIMIT 5;

-- ════════════════════════════════════════════════════════════════
-- §11  US-2313 AC4 — do the ops alerts have anywhere to go?
-- ════════════════════════════════════════════════════════════════
-- ops-events.ts reads both of these with an EMPTY-STRING default. If they are
-- unset, every ops alert — including the cron-fleet-stalled alert that the whole
-- of US-2313 is about — terminates in an admin screen nobody is watching. The
-- VALUES are secrets-adjacent (a webhook URL is a capability), so this prints
-- only whether each is present and how long it is.
SELECT
  key,
  (value IS NOT NULL AND btrim(value::text, '" ') <> '') AS configured,
  length(btrim(value::text, '" '))                       AS value_length,
  updated_at
FROM public.system_settings
WHERE key IN ('ops_alert_webhook_url', 'ops_alert_email')
ORDER BY key;

-- -- A missing ROW is the same as an empty value: both fall back to "".
SELECT
  count(*) FILTER (WHERE key = 'ops_alert_webhook_url') AS webhook_row_present,
  count(*) FILTER (WHERE key = 'ops_alert_email')       AS email_row_present
FROM public.system_settings
WHERE key IN ('ops_alert_webhook_url', 'ops_alert_email');

-- ════════════════════════════════════════════════════════════════
-- §12  US-2359 AC4 — free-tier buyers who used a paid buyer feature
-- ════════════════════════════════════════════════════════════════
-- Two features were genuinely ungated until today: the demand board (buyer_wants,
-- Connoisseur-only) and the purchase-guarantee claim (Guard and up). Switching a
-- gate on for people who have had it free is a support event, not just a fix —
-- this is the number that decides whether to grandfather them.
--
-- Counted by ACCOUNT, not by row: "3,000 wants" and "4 buyers" call for very
-- different decisions.
SELECT
  'demand_board' AS feature,
  count(DISTINCT w.user_id) AS free_tier_accounts,
  count(*)                  AS rows_created
FROM public.buyer_wants w
JOIN public.users u ON u.id = w.user_id
WHERE COALESCE(u.buyer_plan, 'free') = 'free'
UNION ALL
SELECT
  'guarantee_claim',
  count(DISTINCT c.user_id),
  count(*)
FROM public.buyer_guarantee_claims c
JOIN public.users u ON u.id = c.user_id
WHERE COALESCE(u.buyer_plan, 'free') = 'free';

-- -- Recent activity only: an account that used it once a year ago is not
-- -- the same support problem as one using it this week.
SELECT
  count(DISTINCT w.user_id) AS free_tier_accounts_last_30d
FROM public.buyer_wants w
JOIN public.users u ON u.id = w.user_id
WHERE COALESCE(u.buyer_plan, 'free') = 'free'
  AND w.created_at > now() - interval '30 days';

-- ════════════════════════════════════════════════════════════════
-- §13  US-2322 AC5 — sellers disconnected by a refresh race
-- ════════════════════════════════════════════════════════════════
-- Etsy, Whatnot and Depop rotate the refresh token and invalidate the old one on
-- first use, so two of our own callers refreshing at once produced an
-- invalid_grant for the loser — which every connector classified as PERMANENT
-- and deactivated. Fixed 2026-08-03; these are the accounts that were already
-- deactivated by it and are owed a reconnect prompt.
--
-- No token material is selected. refresh_error is our own message, not the
-- provider's payload.
SELECT
  marketplace,
  count(*)                                        AS deactivated,
  count(*) FILTER (WHERE last_refresh_attempt_at > now() - interval '30 days')
                                                  AS in_last_30d,
  min(last_refresh_attempt_at)                    AS earliest,
  max(last_refresh_attempt_at)                    AS latest
FROM public.marketplace_connections
WHERE is_active = false
  AND refresh_error IS NOT NULL
GROUP BY marketplace
ORDER BY count(*) DESC;

-- -- The distinct reasons, so a genuine revocation is not mistaken for a race.
SELECT
  left(refresh_error, 80) AS refresh_error_prefix,
  count(*)                AS connections
FROM public.marketplace_connections
WHERE is_active = false
  AND refresh_error IS NOT NULL
GROUP BY 1
ORDER BY count(*) DESC
LIMIT 20;

-- ════════════════════════════════════════════════════════════════
-- §14  US-2347 AC1 — SECURITY DEFINER functions callable by PUBLIC
-- ════════════════════════════════════════════════════════════════
-- A SECURITY DEFINER function runs as its OWNER, so one that PUBLIC may execute
-- is a hole straight through RLS for whatever it touches. A NULL acl means the
-- default, which for a function IS execute-to-PUBLIC — so "no explicit grant"
-- is the dangerous case, not the safe one, and that is the column to read first.
SELECT
  proname,
  (proacl IS NULL) AS default_acl_public_execute,
  proacl::text     AS acl
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND prosecdef
ORDER BY (proacl IS NULL) DESC, proname;

-- -- The short answer. A non-zero first number is the review list.
SELECT
  count(*) FILTER (WHERE proacl IS NULL) AS public_executable,
  count(*)                               AS security_definer_total
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND prosecdef;

-- ════════════════════════════════════════════════════════════════
-- §15  US-2347 AC3 — the golden set, and which prompts are live
-- ════════════════════════════════════════════════════════════════
-- US-2301 made an empty golden set raise a critical alert instead of skipping
-- silently. This is the number that alert is about: an eval gate with no cases
-- passes everything.
SELECT
  count(*)                                   AS eval_cases_total,
  count(*) FILTER (WHERE is_active)          AS active,
  count(*) FILTER (WHERE deleted_at IS NULL) AS not_deleted
FROM public.grading_eval_cases;

-- -- Which prompt versions are actually serving, and were they eval-gated?
-- -- A live version with eval_passed false or qualified_model null is one
-- -- serving traffic on an unproven prompt.
SELECT
  version_name,
  stage,
  is_active,
  is_shadow,
  is_canary,
  rollout_percentage,
  eval_passed,
  qualified_model,
  created_at
FROM public.ai_prompt_versions
ORDER BY is_active DESC, created_at DESC
LIMIT 50;

-- ════════════════════════════════════════════════════════════════
-- §16  US-2347 AC4 — does the billing-source check still exclude Play?
-- ════════════════════════════════════════════════════════════════
-- US-2287: if the CHECK constraint has no 'googleplay' value, every Play
-- subscription write fails outright. Reading the constraint text is the whole
-- answer — the second query then says whether anyone has ever landed one.
SELECT
  conname,
  pg_get_constraintdef(oid) AS definition,
  (pg_get_constraintdef(oid) ILIKE '%googleplay%') AS allows_googleplay
FROM pg_constraint
WHERE conrelid = 'public.users'::regclass
  AND conname = 'users_billing_source_chk';

-- -- Has any billing source other than the default ever been written?
SELECT
  COALESCE(billing_source, '(null)') AS billing_source,
  count(*)                           AS users
FROM public.users
GROUP BY 1
ORDER BY count(*) DESC;

-- ════════════════════════════════════════════════════════════════
-- §17  US-2398 AC3 — how wrong were the admin counts, and since when?
-- ════════════════════════════════════════════════════════════════
-- The before/after is still measurable AFTER the 00525 apply, because the
-- legacy column is FROZEN: users.plan still holds exactly what the dashboard
-- was reading, and users.flipdesk_plan holds what it reads now. The first
-- query is literally the old number beside the new one.

-- DO NOT DROP users.plan BEFORE RUNNING THIS. Dropping it destroys the only
-- record of what the dashboard used to say (US-2398 AC4).

SELECT
  count(*) FILTER (WHERE plan <> 'free')                      AS paid_before,
  count(*) FILTER (WHERE flipdesk_plan <> 'free')             AS paid_after,
  count(*) FILTER (WHERE flipdesk_plan <> 'free'
                     AND plan = 'free')                       AS undercounted,
  count(*) FILTER (WHERE plan <> 'free'
                     AND flipdesk_plan = 'free')              AS overcounted,
  count(*)                                                    AS total_users
FROM public.users;

-- -- The churn numerator used the SAME frozen column, so both errors ran the
-- -- same direction: users the paid count was missing, the churn count was
-- -- adding. This is the overlap.
SELECT
  count(*) AS counted_as_churned_but_actually_paying
FROM public.users
WHERE plan = 'free'
  AND flipdesk_plan <> 'free';

-- -- SINCE WHEN. The first paying account whose legacy value never caught up
-- -- dates the drift; the monthly shape says whether it is still growing.
SELECT
  date_trunc('month', created_at)::date          AS signup_month,
  count(*)                                       AS accounts,
  count(*) FILTER (WHERE flipdesk_plan <> 'free'
                     AND plan = 'free')          AS diverged
FROM public.users
GROUP BY 1
ORDER BY 1;

-- -- The plan mix, both vocabularies side by side. professional/enterprise
-- -- are the frozen spellings of pro/business — the dashboard used to label
-- -- the mix with tiers nobody can currently be on.
SELECT
  COALESCE(plan::text, '(null)')          AS legacy_plan,
  COALESCE(flipdesk_plan::text, '(null)') AS live_plan,
  count(*)                                AS users
FROM public.users
GROUP BY 1, 2
ORDER BY count(*) DESC;

-- ════════════════════════════════════════════════════════════════
-- §18  US-2406 AC5 — has any flag been targeted at a plan?
-- ════════════════════════════════════════════════════════════════
-- Plan targeting was NEVER APPLIED at runtime before US-2406: the resolver
-- only checked plan_targets when the caller supplied a plan, and no caller
-- did. So any flag listed below has been serving EVERY tier, not the tier
-- it names, for as long as the target has been set. Whoever set it should
-- be told before the fix ships and the limit starts biting.

-- rollout_percentage is here for the same reason: it too was skipped at the
-- call sites that passed no user id, and those sites now pass one.

SELECT
  key,
  enabled,
  rollout_percentage,
  plan_targets,
  cardinality(user_allow) AS allow_count,
  cardinality(user_deny)  AS deny_count,
  starts_at,
  ends_at,
  updated_at
FROM public.feature_flags
WHERE cardinality(plan_targets) > 0
   OR rollout_percentage < 100
ORDER BY key;

-- -- Empty above = nothing was ever targeted, and the fix changes no live
-- -- behaviour. That is the expected result; the query exists to prove it
-- -- rather than assume it.

-- ════════════════════════════════════════════════════════════════
-- §19 US-2288 AC4 — FREE-TRIAL EXPOSURE
-- ════════════════════════════════════════════════════════════════
-- handle_new_user (live definition: 00401_buyer_account_roles.sql) grants
-- EVERY non-buyer-only signup flipdesk_plan=pro, subscription_status=trialing
-- and 14 days, with no prior-trial lookup, no card and no device signal.
-- Deleting the account and signing up again resets it, and each trial can
-- spend real Claude Vision money.

-- US-2288 says MEASURE FIRST, and it is right to: the correct abuse control
-- is different if the answer is "two people did this" than if it is "two
-- hundred". These four queries are that measurement. NOTHING below writes.

-- -- (a) Trials started per month, and how many converted.
-- -- A trial is counted by trial_ends_at being set at all. Conversion names
-- -- the PAID statuses positively (active, comp) rather than excluding the
-- -- unpaid ones: an exclusion list counts any status added LATER as a
-- -- conversion, and would quietly overstate the number this story turns on.
SELECT
  date_trunc('month', u.created_at)::date AS month,
  count(*)                                                       AS trials_started,
  count(*) FILTER (
    WHERE u.subscription_status IN ('active', 'comp')
  )                                                              AS converted,
  count(*) FILTER (WHERE u.subscription_status = 'trialing')      AS still_trialing
FROM public.users u
WHERE u.trial_ends_at IS NOT NULL
GROUP BY 1
ORDER BY 1 DESC
LIMIT 24;

-- -- (b) THE ABUSE SIGNAL. Addresses that differ only by a Gmail-style
-- -- plus-tag or by dots are the cheapest way to take a second trial, and
-- -- they normalise to one mailbox. Any row here with n > 1 is one person
-- -- holding several trials. This returns a COUNT and a normalised stem
-- -- only — the full addresses are deliberately not selected, because this
-- -- output gets pasted around.
SELECT
  count(*)                     AS distinct_stems_with_repeats,
  coalesce(sum(n), 0)          AS accounts_involved,
  coalesce(max(n), 0)          AS worst_single_stem
FROM (
  SELECT
    replace(split_part(split_part(lower(u.email), '@', 1), '+', 1), '.', '')
      || '@' || split_part(lower(u.email), '@', 2) AS stem,
    count(*) AS n
  FROM public.users u
  WHERE u.trial_ends_at IS NOT NULL
    AND u.email IS NOT NULL
  GROUP BY 1
  HAVING count(*) > 1
) t;

-- -- (c) What the trials actually COST. Grading submissions made by an
-- -- account while it was inside its trial window. This is the number that
-- -- decides whether AC3 (a trial-specific volume cap) is worth building.
SELECT
  count(*)                                   AS submissions_during_trial,
  count(DISTINCT s.user_id)                  AS trial_accounts_that_graded,
  round(count(*)::numeric
        / greatest(count(DISTINCT s.user_id), 1), 1) AS avg_per_trial_account,
  max(per_user.c)                            AS most_by_one_trial_account
FROM public.submissions s
JOIN public.users u ON u.id = s.user_id
LEFT JOIN LATERAL (
  SELECT count(*) AS c
  FROM public.submissions s2
  WHERE s2.user_id = s.user_id
    AND s2.created_at <= u.trial_ends_at
) per_user ON true
WHERE u.trial_ends_at IS NOT NULL
  AND s.created_at <= u.trial_ends_at;

-- -- (d) Did any of that spend come from an account that has since been
-- -- DELETED? The deletion log is what makes the delete-and-resignup loop
-- -- measurable rather than hypothetical. An empty result means nobody has
-- -- exercised it yet, which is the good answer and still worth knowing.
SELECT
  count(*) AS deleted_accounts_logged,
  min(d.requested_at)::date AS first_deletion,
  max(d.requested_at)::date AS last_deletion
FROM public.account_deletion_log d;

-- -- READING THIS: (b) at zero and (d) at zero together mean the hole is
-- -- real but unexploited, and the cheap control (a prior-trial record) is
-- -- enough. (b) above zero means it is already being used and the control
-- -- has to survive deletion — which is what AC2 asks for, and why it must
-- -- be keyed on something that outlives the users row.

-- ════════════════════════════════════════════════════════════════
-- §20 US-2289 AC5 — WHO WAS CHARGED MORE THAN ONCE FOR ONE GARMENT
-- ════════════════════════════════════════════════════════════════
-- The bug: gradeBatchItem created a submission and charged on EVERY
-- invocation, and the reclaim cron re-ran a stale job with no reference to
-- the attempt that had already paid. MAX_GRADE_JOB_ATTEMPTS is 5, so one
-- garment could take five debits and produce five certificates. Each
-- attempt was individually correct, which is why nothing caught it.

-- The fix charges through an idempotency key of grade-batch-job:<job id>,
-- so post-fix debits are deduped by a partial unique index. That key is
-- also what makes the damage measurable: a NULL key on a batch-era debit
-- is a pre-fix charge.

-- -- (a) Per batch: jobs versus debits taken inside its window. A batch
-- -- where debits exceed jobs was charged more than once for the same work.
-- -- The window is padded 30 minutes past the batch updated_at because the
-- -- reclaim runs on a */5 cron and a resumed attempt can settle after the
-- -- batch row last moved.
WITH batch_window AS (
  SELECT b.id                AS batch_id,
         b.user_id,
         b.created_at        AS started_at,
         b.updated_at + interval '30 minutes' AS ended_at,
         count(j.id)         AS jobs,
         max(j.attempts)     AS max_attempts
  FROM public.grading_batches b
  LEFT JOIN public.grading_batch_jobs j ON j.batch_id = b.id
  GROUP BY b.id, b.user_id, b.created_at, b.updated_at
)
SELECT
  w.batch_id,
  w.user_id,
  w.started_at::date                       AS batch_date,
  w.jobs,
  w.max_attempts,
  count(t.id)                              AS debits_in_window,
  count(t.id) FILTER (WHERE t.idempotency_key IS NULL) AS pre_fix_debits,
  greatest(count(t.id) - w.jobs, 0)        AS suspected_extra_charges,
  abs(sum(t.delta) FILTER (WHERE t.delta < 0))         AS credits_debited
FROM batch_window w
LEFT JOIN public.grade_credit_transactions t
       ON t.user_id = w.user_id
      AND t.reason  = 'grade_debit'
      AND t.created_at BETWEEN w.started_at AND w.ended_at
GROUP BY w.batch_id, w.user_id, w.started_at, w.jobs, w.max_attempts
HAVING count(t.id) > w.jobs
ORDER BY suspected_extra_charges DESC, w.started_at DESC
LIMIT 100;

-- -- (b) The refund list. One row per affected customer, which is the
-- -- shape AC5 needs: extra debits owed back, and when it happened.
WITH batch_window AS (
  SELECT b.id AS batch_id, b.user_id,
         b.created_at AS started_at,
         b.updated_at + interval '30 minutes' AS ended_at,
         count(j.id) AS jobs
  FROM public.grading_batches b
  LEFT JOIN public.grading_batch_jobs j ON j.batch_id = b.id
  GROUP BY b.id, b.user_id, b.created_at, b.updated_at
),
excess AS (
  SELECT w.user_id,
         greatest(count(t.id) - w.jobs, 0) AS extra,
         min(w.started_at)                 AS first_seen,
         max(w.started_at)                 AS last_seen
  FROM batch_window w
  LEFT JOIN public.grade_credit_transactions t
         ON t.user_id = w.user_id
        AND t.reason  = 'grade_debit'
        AND t.created_at BETWEEN w.started_at AND w.ended_at
  GROUP BY w.user_id, w.jobs, w.batch_id
)
SELECT user_id,
       sum(extra)        AS credits_to_refund,
       min(first_seen)::date AS first_affected,
       max(last_seen)::date  AS last_affected
FROM excess
WHERE extra > 0
GROUP BY user_id
ORDER BY credits_to_refund DESC;

-- -- (c) Duplicate certificates from the same bug: more than one grade
-- -- report for one account inside one batch window beyond its job count.
-- -- Refunding the credit does not withdraw the certificate, and a garment
-- -- with two public certificates is a trust problem rather than a billing
-- -- one, so it is counted separately.
SELECT
  b.id                        AS batch_id,
  b.user_id,
  count(DISTINCT j.id)        AS jobs,
  count(DISTINCT r.id)        AS grade_reports_in_window
FROM public.grading_batches b
LEFT JOIN public.grading_batch_jobs j ON j.batch_id = b.id
LEFT JOIN public.submissions s
       ON s.user_id = b.user_id
      AND s.created_at BETWEEN b.created_at AND b.updated_at + interval '30 minutes'
LEFT JOIN public.grade_reports r ON r.submission_id = s.id
GROUP BY b.id, b.user_id
HAVING count(DISTINCT r.id) > count(DISTINCT j.id)
ORDER BY (count(DISTINCT r.id) - count(DISTINCT j.id)) DESC
LIMIT 50;

-- -- (d) Is the fix holding? Every debit taken since it shipped should
-- -- carry a grade-batch-job key, and no key should appear twice — the
-- -- partial unique index makes the second impossible, so a non-zero count
-- -- here would mean the index is missing rather than that dedupe failed.
SELECT
  count(*) FILTER (WHERE idempotency_key LIKE 'grade-batch-job:%') AS keyed_batch_debits,
  count(*) FILTER (WHERE idempotency_key IS NULL AND reason = 'grade_debit') AS unkeyed_debits,
  max(created_at) FILTER (WHERE idempotency_key LIKE 'grade-batch-job:%') AS newest_keyed,
  max(created_at) FILTER (WHERE idempotency_key IS NULL AND reason = 'grade_debit') AS newest_unkeyed
FROM public.grade_credit_transactions;

-- -- READING THIS: an empty (a) and (b) means the window between the bug
-- -- shipping and the fix landing produced no double charge, and AC5 closes
-- -- as "audited, nothing owed" rather than being left open forever. Rows in
-- -- (b) are a refund list. In (d), a newest_unkeyed LATER than newest_keyed
-- -- means some grading path still charges outside the chokepoint.

-- ════════════════════════════════════════════════════════════════
-- §21 US-2117 — HAS AN AGREEMENT ROW EVER CARRIED A DISCLOSURE VERSION?
-- ════════════════════════════════════════════════════════════════
-- US-2117 stayed open on one narrow thing: every test of the disclosure
-- version is a unit or source test, and nobody has OBSERVED a row carrying
-- one. The value rides in Stripe subscription_data.metadata — the same
-- channel that already carries user_id in production — so the mechanism is
-- not speculative. But this column exists to be trusted years later in a
-- dispute, and "we are confident it writes" is the wrong standard for that.

SELECT
  count(*)                                              AS agreements_total,
  count(*) FILTER (WHERE disclosure_version IS NOT NULL) AS with_disclosure_version,
  min(created_at) FILTER (WHERE disclosure_version IS NOT NULL) AS first_versioned,
  max(created_at)                                       AS newest_agreement
FROM public.subscription_agreements;

-- -- Which versions, and on which plans. A single unexpected string here
-- -- (or a version nobody recognises) is worth more than the count above.
SELECT disclosure_version, plan, billing_interval, count(*) AS rows,
       max(created_at) AS newest
FROM public.subscription_agreements
GROUP BY disclosure_version, plan, billing_interval
ORDER BY newest DESC
LIMIT 30;

-- -- READING THIS: agreements_total at zero means nobody has subscribed
-- -- since the table shipped, and the question is still open rather than
-- -- answered. A non-zero total with with_disclosure_version at zero is the
-- -- bad answer: rows are being written and the metadata is not arriving.

-- ════════════════════════════════════════════════════════════════
-- §22 US-2444 AC1 — WHAT MIGRATION 00122 CREATED
-- ════════════════════════════════════════════════════════════════
-- 00122_verified_storefront_listings.sql was named in .gitignore and never
-- committed, so its DDL was applied to prod by hand and exists nowhere in
-- the repo. AC1 insists the replacement be written from the DATABASE, not
-- reconstructed from the feature commit — that commit shows what the code
-- EXPECTED, which is exactly the thing that may differ.

-- Everything below is a catalog read. Paste it back whole; the replacement
-- migration is written from it.

-- -- (a) Tables and columns whose name mentions the storefront.
SELECT c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND (c.table_name ILIKE '%storefront%' OR c.column_name ILIKE '%storefront%')
ORDER BY c.table_name, c.ordinal_position;

-- -- (b) Indexes on those tables.
SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename ILIKE '%storefront%'
ORDER BY tablename, indexname;

-- -- (c) RLS policies. A table restored without its policies is a table
-- -- that reads to everyone, so these are the half worth being exact about.
SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename ILIKE '%storefront%'
ORDER BY tablename, policyname;

-- -- (d) Is RLS actually enabled on them?
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname ILIKE '%storefront%';

-- -- (e) Functions and triggers mentioning it — the parts a column dump
-- -- silently omits, and the usual reason a hand-applied migration cannot
-- -- be inferred from the table alone.
-- ⚠ The CTE is `AS MATERIALIZED` on purpose and removing it breaks this query
-- on EVERY Postgres. `pg_get_functiondef` RAISES on an aggregate ("array_agg is
-- an aggregate function"), so the call has to see only the rows already
-- narrowed to plain functions in `public`. This was originally written with the
-- namespace filter as a JOIN, which does not narrow anything: the planner is
-- free to evaluate the qual before the join, and it does — the call landed on
-- pg_catalog's aggregates and aborted the session under ON_ERROR_STOP=1, which
-- is precisely what this file's header promises it cannot do to you. Caught
-- 2026-08-16 the first time the file was ever executed end to end.
-- `MATERIALIZED` is an optimization fence (PG12+), so it is a guarantee rather
-- than a hope about qual ordering.
WITH public_functions AS MATERIALIZED (
  SELECT p.oid, p.proname
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.prokind = 'f'   -- 'a' aggregate / 'w' window both raise above
)
SELECT proname AS function_name, pg_get_function_identity_arguments(oid) AS args
FROM public_functions
WHERE proname ILIKE '%storefront%' OR pg_get_functiondef(oid) ILIKE '%storefront%'
ORDER BY proname;

SELECT c.relname AS table_name, t.tgname AS trigger_name,
       pg_get_triggerdef(t.oid) AS definition
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND NOT t.tgisinternal AND c.relname ILIKE '%storefront%'
ORDER BY c.relname, t.tgname;

-- -- (f) Which ledger, if any, knows about 00122. applied_migrations is the
-- -- WRONG place to look on its own: self-recording footers only start at
-- -- 00254, so an absent row there is expected and carries no signal. The
-- -- supabase_migrations ledger is the one that could have a 00122 row, and
-- -- whether it does decides whether the replacement migration has to insert
-- -- the version or merely create the objects.
SELECT 'applied_migrations' AS ledger, version, applied_at::text AS recorded_at
FROM public.applied_migrations
WHERE version IN ('00121', '00122', '00123')
UNION ALL
SELECT 'schema_migrations', version, NULL
FROM supabase_migrations.schema_migrations
WHERE version LIKE '00121%' OR version LIKE '00122%' OR version LIKE '00123%'
ORDER BY ledger, version;

-- -- READING THIS: an empty (a) does not mean nothing was applied. It means
-- -- the objects are not named after the feature, and the next place to look
-- -- is the storefront code path for the table it actually reads.

-- ════════════════════════════════════════════════════════════════
-- Done. Paste the whole output back — nothing above is a secret.
-- ════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════
-- §23 US-2403 AC1 — IS THE SEGFAULT PATH LIVE ON THIS IMAGE?
-- ════════════════════════════════════════════════════════════════
-- A denied FUNCTION call from a role listed in supautils.hint_roles
-- segfaults the backend and restarts the whole database. Reproduced on the
-- stock Supabase image; never tested against prod, deliberately, because
-- the test IS the denial of service.

-- These two reads settle it and neither is invasive. If anon is ABSENT from
-- hint_roles, prod does not reproduce, AC1 closes, AC2 is already satisfied,
-- and migration 00527 (parked as .BLOCKED) unblocks along with US-2282.

-- DO NOT "confirm" by calling a revoked function. That call is the outage.
-- One earlier note in US-2403 said re-running latest_schema_migration() as
-- anon was cheap and not an attack; it is on the list of fourteen functions
-- anon cannot execute, so it is exactly the attack.

-- NOT written as `SHOW supautils.hint_roles` on purpose. If supautils is not
-- loaded, SHOW raises "unrecognized configuration parameter" and, under
-- ON_ERROR_STOP=1, kills the rest of this session — the exact failure this
-- file exists to avoid. current_setting(..., true) answers NULL instead,
-- and NULL is itself the finding: no supautils, no hint path, no crash.

SELECT current_setting('supautils.hint_roles', true) AS hint_roles_or_null;

-- -- READING THIS. NULL or an empty string: the hint path is not running,
-- -- prod does not reproduce, and 00527/US-2282 unblock. A value CONTAINING
-- -- anon: this image crashes on a denied function call and the mitigation
-- -- (clear hint_roles in /etc/postgresql-custom/supautils.conf and restart)
-- -- comes BEFORE anything else — it cannot be done from SQL, supautils
-- -- refuses ALTER SYSTEM on it even as superuser.

-- -- Corroborated from outside on 2026-08-15 (US-2606): prod returns NO
-- -- supautils hint on a denied TABLE read as anon, while a genuine Postgres
-- -- hint does reach the client. Table denials never crash, so that probe
-- -- was safe — it inferred what this query answers directly.
-- --   node scripts/probe-supautils-hint.mjs

-- ════════════════════════════════════════════════════════════════
-- §24 US-2286 AC5 — WHICH ENTITLEMENTS CAME FROM A SANDBOX PURCHASE
-- ════════════════════════════════════════════════════════════════
-- US-2286 stamps the store environment on a grant rather than refusing
-- sandbox purchases (refusing would fail App Review, which always exercises
-- IAP in the sandbox). NULL means the grant predates the marker and
-- countsAsRevenue(NULL) is deliberately true, so historical MRR is not
-- zeroed. What this shows is whether any grant since then is sandbox.

-- Counts only. No user ids, no emails.
SELECT
  coalesce(billing_source, '(none)')        AS billing_source,
  coalesce(billing_environment, '(pre-marker)') AS environment,
  count(*)                                   AS accounts
FROM public.users
WHERE billing_source IS NOT NULL
GROUP BY 1, 2
ORDER BY 1, 2;

-- -- READING THIS: any row with environment = sandbox is a free entitlement
-- -- booked as if paid. (pre-marker) rows are NOT identifiable from the
-- -- database alone — that half needs App Store purchase history, which is
-- -- why AC5 stays an operator task even after this query runs.

-- ════════════════════════════════════════════════════════════════
-- §25 US-2606 — DID 00594 ACTUALLY LAND?
-- ════════════════════════════════════════════════════════════════
-- /health/ready reported missing:["00594"] on 2026-08-15 while status said
-- match, because the recorded version is a MAXIMUM and a maximum cannot see
-- a hole beneath it. flipdesk_overview_metrics is the single RPC behind the
-- FlipDesk Overview page, which throws when it is absent.

-- Run this AFTER applying the migration. Both rows should come back.
SELECT 'recorded' AS check, count(*)::text AS result
FROM public.applied_migrations WHERE version = '00594'
UNION ALL
SELECT 'function exists', count(*)::text
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'flipdesk_overview_metrics';

-- -- READING THIS: recorded=1 and function exists=1 is the all-clear, and
-- -- the authoritative version of it is one unauthenticated GET:
-- --   curl -fsS https://functions.gradethread.com/health/ready | jq .schema
-- -- An empty or absent "missing" is what closes US-2606. A bare
-- -- "status":"match" is NOT — that is what it said while 00594 was gone.

-- ════════════════════════════════════════════════════════════════
-- §26 US-2304 AC4 — HOW OFTEN DID A MISSING TAG PHOTO COST A VISION CALL?
-- ════════════════════════════════════════════════════════════════
-- A FlipDesk item submitted without a tag photo was CHARGED, ran one Claude
-- Vision call per image, abstained to needs_photos, and was refunded. The
-- money came back and the AI spend did not. AC1 fixed it going forward by
-- requiring the tag; AC4 asks what it cost before that.

-- Counts and dates only — no ids, no user ids.

-- -- (a) FlipDesk grading rows that ended in needs_photos, by month.
SELECT
  to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
  count(*)                                            AS needs_photos_rows
FROM public.flipdesk_grading_submissions
WHERE status = 'needs_photos'
GROUP BY 1
ORDER BY 1;

-- -- (b) The refunds that followed, i.e. the ones that actually cost a call
-- -- and gave the money back. Joined through submission_id, which is the
-- -- only link between the FlipDesk bridge row and the credit ledger.
SELECT
  to_char(date_trunc('month', t.created_at), 'YYYY-MM') AS month,
  count(*)                                              AS refunds,
  sum(t.delta)                                          AS credits_returned
FROM public.grade_credit_transactions t
WHERE t.reason = 'refund'
  AND t.submission_id IN (
    SELECT submission_id
    FROM public.flipdesk_grading_submissions
    WHERE status = 'needs_photos' AND submission_id IS NOT NULL
  )
GROUP BY 1
ORDER BY 1;

-- -- READING THIS: (a) with an empty (b) means the abstention happened and
-- -- the refund did not — a worse finding than the one this AC asked about,
-- -- because the seller then paid for a grade they never received. Both
-- -- empty means the path never fired in production and AC4 closes at zero.
-- -- The AI spend is NOT recoverable from either number; images-per-
-- -- submission is the multiplier and it is not stored on these rows.

-- ════════════════════════════════════════════════════════════════
-- §27 US-2610 AC5 — WHICH REQUIRED PHOTO IS ACTUALLY BLOCKING PEOPLE?
-- ════════════════════════════════════════════════════════════════
-- REQUIRED_IMAGE_TYPES is front + back + label, all at severity block, so a
-- garment with no readable tag cannot be graded at all. Some genuinely have
-- none: heat-transfer cut sizes wear off, resale basics ship tagless,
-- vintage tags get cut out. US-2610 asks what those sellers photograph
-- instead — and asks this FIRST, because if the label case is rare the
-- honest fix is a clearer refusal message and nothing more.

-- ⚠ THIS IS A SNAPSHOT, NOT A HISTORY, and the difference is large.
-- quality_feedback is set to NULL the moment a grade is produced (00069),
-- so every seller who added the missing photo and succeeded has already
-- erased their own row from this count. What is left is the people who are
-- STUCK. That is the more actionable set and it is not the same question.

SELECT
  i->>'image_type'                       AS image_type,
  count(*)                               AS stuck_submissions
FROM public.submissions s
CROSS JOIN LATERAL jsonb_array_elements(
  CASE
    WHEN jsonb_typeof(s.quality_feedback -> 'issues') = 'array'
      THEN s.quality_feedback -> 'issues'
    ELSE '[]'::jsonb
  END
) AS i
WHERE s.status = 'needs_photos'
  AND i->>'severity' = 'block'
  AND i->>'problem'  = 'missing'
GROUP BY 1
ORDER BY 2 DESC;

-- -- The CASE is not defensive dressing: jsonb_array_elements raises on a
-- -- non-array, and one malformed row would end this session before the
-- -- sections after it ran. An unexpected shape yields no rows instead.

-- -- READING THIS: label far ahead of front/back is the tagless case and
-- -- US-2610 is worth building. Roughly level across the three is ordinary
-- -- incomplete uploads, and the fix is upload-time guidance, not a grading
-- -- change. Empty means nobody is stuck today — which does NOT mean it
-- -- never happened, for the reason in the warning above.

-- ════════════════════════════════════════════════════════════════════
-- §28 US-2662 — HAS AN IMPERSONATION EVER BEEN STOPPED?
-- ════════════════════════════════════════════════════════════════════

-- -- WHY THIS IS HERE. /stop calls a GoTrue route that does not exist on
-- -- v2.195.0 (POST /admin/users/:id/logout answers 404 while
-- -- GET /admin/users/:id answers 200 with the same credentials). Prod runs
-- -- v2.174.0, which is OLDER, so it is very unlikely to have a route the
-- -- newer one lacks. If so, every stop left the target refresh token live.
-- --
-- -- This does not prove the route is missing — only Sentry (search
-- -- "GoTrue logout returned" under route impersonation.revoke) or a
-- -- service-role call can. What it answers is the OTHER half: whether the
-- -- defect has ever been reachable, i.e. whether anyone has actually
-- -- impersonated and stopped. Zero rows means the security gap has never
-- -- been exercised, and a Sentry search returning nothing means nothing.

-- -- (a) Sessions by how they ended. end_reason stopped = someone pressed
-- -- Exit and expected a revocation.
SELECT
  COALESCE(end_reason, '(still open)') AS end_reason,
  count(*)                             AS sessions,
  min(started_at)                      AS first_seen,
  max(started_at)                      AS last_seen
FROM public.admin_impersonation_sessions
GROUP BY 1
ORDER BY 2 DESC;

-- -- (b) Distinct targets whose session was never revoked, if the route is
-- -- indeed absent. These are the accounts whose refresh token stayed live
-- -- in an admin browser until it expired on its own.
SELECT count(DISTINCT target_id) AS distinct_targets_affected
FROM public.admin_impersonation_sessions
WHERE end_reason = 'stopped';

-- -- (c) Anything still open past its cap. Reads should already refuse
-- -- these (expiry is decided on read, not by a sweep), so a non-zero here
-- -- is rows never closed rather than sessions still honoured.
SELECT count(*) AS open_past_expiry
FROM public.admin_impersonation_sessions
WHERE ended_at IS NULL AND expires_at < now();

-- -- READING THIS: zero sessions overall means nobody has used
-- -- impersonation and US-2662 is a latent defect rather than a live one —
-- -- fix it before the feature is used, not as an incident. A non-zero
-- -- stopped count with the route absent means that many customer sessions
-- -- were left live, and the remedy is a password reset / forced sign-out
-- -- for the targets in (b) rather than only a code fix.

-- ════════════════════════════════════════════════════════════════════
-- §29 US-2282 / US-3094 — CAN AN ANONYMOUS CALLER MINT CREDITS? (run first)
-- ════════════════════════════════════════════════════════════════════

-- -- ⚠ THIS IS THE ONE TO READ FIRST. On a clean stack built from all 609
-- -- migrations, POST /rest/v1/rpc/grant_grade_credits with ONLY the anon
-- -- key returned 200 and moved a real balance 0 -> 999. debit_grade_credits
-- -- moved it back down. No sign-in, no session — the anon key ships in the
-- -- browser bundle. Each credit is real vision spend.
-- --
-- -- ✅ CLOSED SINCE 00615/00617/00640, AND NOT BY A REVOKE. Those migrations
-- -- put the authorization check in each function BODY, so the call above now
-- -- answers 42501. The EXECUTE grants below are UNCHANGED and are meant to
-- -- stay that way — see the reading note at the end of this section.
-- --
-- -- DO NOT CONFIRM BY CALLING THE FUNCTION. That grants real credits to a
-- -- real account. These queries read pg_proc and change nothing.

-- -- (a) The specific money functions, and whether anon may run them.
-- -- anon_can_run = t is EXPECTED on eight of these ten and is not the
-- -- exploit signal any more. The signal is anon_can_run = t together with
-- -- body_guard = f on the same row: that function is reachable with the
-- -- public anon key and checks nobody. Expected shape (measured on a full
-- -- local stack 2026-09-02, identical to prod): eight rows t/t, and
-- -- admin_adjust_credits + revoke_grade_credits f/f because 00216 revoked
-- -- them. Zero rows should read t/f.
SELECT p.proname,
       p.prosecdef                                      AS security_definer,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_run,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed_can_run,
       (p.prosrc LIKE '%auth.role()%' OR p.prosrc LIKE '%gt_require_role%') AS body_guard
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.prokind = 'f'
  AND p.proname IN (
    'grant_grade_credits', 'debit_grade_credits', 'revoke_grade_credits',
    'grant_appstore_credits', 'grant_buyer_reward_credit',
    'issue_buyer_reward_credit', 'redeem_buyer_reward_credit',
    'reserve_ai_action', 'refund_ai_action', 'admin_adjust_credits'
  )
ORDER BY anon_can_run DESC, p.proname;

-- -- (b) The whole surface, for comparison against the local baseline
-- -- measured 2026-08-16: 175 functions, 86 SECURITY DEFINER, 63 of those
-- -- anon-executable, 65 authenticated. A materially different shape here
-- -- means prod diverged from the migrations and is worth understanding.
-- --
-- -- ⚠ definer_anon_can_run IS EXPECTED TO BE NON-ZERO, PERMANENTLY (US-3094).
-- -- Prod on 2026-09-02: 241 functions, 120 SECURITY DEFINER, 100 of those
-- -- anon-executable. The throwaway local stack the same day: 237 / 119 /
-- -- 101. Prod has NOT diverged — the two agree, which is the finding that
-- -- closed US-3094. That is not drift and it is not a backlog — this repo
-- -- answers the permission question in the function BODY and deliberately
-- -- leaves the grant alone, because a DENIED function call segfaults this
-- -- Postgres image (US-2403). Applying 00723 does NOT move this number; it
-- -- should read about 100 before and after, growing with the schema. The
-- -- number that must be zero is the t/f rows in (a), not this one. Treat a
-- -- SUDDEN DROP here as the alarm: it means a revoke shipped, and every
-- -- function it touched is now an unauthenticated database restart away.
SELECT count(*)                                                                    AS public_functions,
       count(*) FILTER (WHERE p.prosecdef)                                         AS security_definer,
       count(*) FILTER (WHERE p.prosecdef AND has_function_privilege('anon', p.oid, 'EXECUTE'))          AS definer_anon_can_run,
       count(*) FILTER (WHERE p.prosecdef AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS definer_authed_can_run
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f';

-- -- (c) Which SECURITY DEFINER functions anon may run, named. This is the
-- -- list 00527 would revoke, and the list to eyeball for anything worse
-- -- than credits.
SELECT p.proname
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.prokind = 'f' AND p.prosecdef
  AND has_function_privilege('anon', p.oid, 'EXECUTE')
ORDER BY p.proname;

-- -- READING THIS: not every definer function is a hole — admin_revenue_metrics
-- -- is anon-executable AND refuses with "admin role required" because it
-- -- checks internally. So (c) is a list to triage, not a count of
-- -- vulnerabilities; (a) is the one that is already triaged.
-- --
-- -- ⚠ CORRECTED 2026-09-02 (US-3094). This block used to end "the credit
-- -- functions do not check" and "THE FIX IS DEADLOCKED ... apply 00527".
-- -- Both are out of date. The credit functions DO check: 00615, 00617 and
-- -- 00640 added a body guard to every one of them. And the fix is not
-- -- deadlocked, it is DECIDED — the body check IS the remedy, not an interim
-- -- one. 00527 stays parked, 00686 and 00720 each undid a revoke that
-- -- shipped by mistake, and scripts/migrations-lint.mjs plus
-- -- src/test/us2403-function-revoke-gate.test.ts now fail a new one.
-- --
-- -- WHAT TO DO IF (a) SHOWS A t/f ROW: add the guard to that function BODY
-- -- (public.gt_require_role, the shape 00640 settled on). Do not take the
-- -- EXECUTE grant away. scripts/check-credit-function-guards.mjs runs this
-- -- same test in verify and CI against the throwaway stack, so a t/f row
-- -- here means prod diverged from the migrations rather than the corpus
-- -- being wrong.
