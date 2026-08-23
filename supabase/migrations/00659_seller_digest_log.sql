-- US-2828: the weekly seller digest's idempotency ledger and its opt-out.
--
-- Two objects, both additive, both idempotent. Nothing existing changes shape or
-- behaviour, and nothing is revoked (US-2403: a denied anon/authenticated call
-- segfaults this Postgres image).
--
-- ── WHY A TABLE AND NOT A FLAG SOMEWHERE ────────────────────────────────────
--
-- AC5 asks that the job record a delivery outcome per seller per channel, so
-- that US-2003's "nobody was paged" is provable rather than assumed. AC1 needs
-- once-per-week idempotency so an overlapping or retried cron cannot mail the
-- same seller twice. Those are the same row: a claim taken before sending, then
-- stamped with what actually went out.
--
-- Modelled on public.buyer_notification_log (00412), deliberately and almost
-- column for column, because that table already answers this exact pair of
-- questions for buyers and the cron that reads it is the pattern this job will
-- copy. A second shape for the same job on the other side of the product would
-- be two things to learn instead of one.
--
--   dedupe_key   one unit of work. For this job, the ISO date of the run's
--                Monday, so a re-run inside the week is a no-op.
--   channels     what actually went out. EMPTY IS MEANINGFUL and is the AC4
--                no-op: a row with sent_at set and no channels says the digest
--                was composed, found nothing worth sending, and was logged
--                rather than mailed. Distinguishing that from "never ran" is
--                the whole point of writing the row at all.
--   sent_at      NULL while claimed and not yet resolved.
--
-- ── RLS ─────────────────────────────────────────────────────────────────────
--
-- A seller may READ their own delivery history — being able to answer "did you
-- try to email me" is the point of AC5 — and may not write it. There is no
-- INSERT, UPDATE or DELETE policy, so only the service-role job writes. That
-- makes it a partially-policied table rather than a deny-all one, so it does NOT
-- belong in rls-guard's SERVICE_ROLE_ONLY set: it has a policy, and the guard's
-- question is whether a zero-policy table has been classified.

BEGIN;

-- 1. The ledger.
CREATE TABLE IF NOT EXISTS public.seller_digest_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  dedupe_key    text NOT NULL,
  channels      text[] NOT NULL DEFAULT '{}',
  sent_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);

COMMENT ON TABLE public.seller_digest_log IS
  'US-2828: one row per seller per weekly digest period. The UNIQUE (user_id, dedupe_key) '
  'insert is the idempotency claim; channels records what was delivered, and an EMPTY '
  'channels array with a non-null sent_at is the AC4 no-op (composed, nothing to report, '
  'logged rather than mailed).';

CREATE INDEX IF NOT EXISTS idx_seller_digest_log_user_created
  ON public.seller_digest_log (user_id, created_at DESC);

-- Partial index for the cron to find claims it took and never resolved — a run
-- that died between claiming and sending leaves exactly these rows.
CREATE INDEX IF NOT EXISTS idx_seller_digest_log_unresolved
  ON public.seller_digest_log (user_id) WHERE sent_at IS NULL;

ALTER TABLE public.seller_digest_log ENABLE ROW LEVEL SECURITY;

-- `(select auth.uid())`, not a bare call: auth.uid() is STABLE, so the two are
-- semantically identical, but the planner hoists the subquery form into a single
-- InitPlan evaluated once per query while the bare call is re-evaluated PER
-- CANDIDATE ROW (00451, US-1927). Copying 00412's bare form here is exactly the
-- regression 00474 shipped, and rls-guard_test.ts caught it.
DROP POLICY IF EXISTS "Sellers read own digest log" ON public.seller_digest_log;
CREATE POLICY "Sellers read own digest log"
  ON public.seller_digest_log FOR SELECT USING ((select auth.uid()) = user_id);

-- 2. The opt-out (AC6).
--
-- A COLUMN on users, not a row in a preferences table, because AC6 requires the
-- opt-out to be honoured in the SAME query that selects recipients rather than
-- filtered afterwards — and the recipient scan already reads users. A join is
-- one more thing that can be forgotten in exactly the way AC6 is written to
-- prevent.
--
-- DEFAULT false: an existing seller is opted IN, which is the behaviour the
-- story describes. NOT NULL so the recipient query never has to reason about a
-- third state.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS seller_digest_opt_out boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.users.seller_digest_opt_out IS
  'US-2828 AC6: true means the weekly seller analytics digest is not sent. Read in the '
  'recipient-selection query itself, never as a post-fetch filter.';

insert into public.applied_migrations (version) values ('00659') on conflict do nothing;

COMMIT;
