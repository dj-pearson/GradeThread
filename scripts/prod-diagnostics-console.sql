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
-- set when you execute a whole file. Run it ONE SECTION AT A TIME — the
-- sections are marked `§1` … `§13` — or use psql with the original file,
-- which prints every result with its banner.
--
-- Still strictly read-only: no INSERT, UPDATE, DELETE, CREATE, ALTER or DROP.
-- ══════════════════════════════════════════════════════════════════

-- READ-ONLY production diagnostics. Answers the prod-data questions that eight
-- open stories are each individually blocked on, in ONE session.
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
-- last acceptance criterion reading "needs prod access". That is eight separate
-- asks of the one person who can answer them, which is how a question stops
-- being asked. One paste, one output, every answer.
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
-- Done. Paste the whole output back — nothing above is a secret.
-- ════════════════════════════════════════════════════════════════
