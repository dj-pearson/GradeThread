-- Pricing model split (US-201): FlipDesk subscription + GradeThread per-grade.
--
-- Until now, users.plan (free|starter|professional|enterprise) conflated both
-- products under one subscription. We're splitting them:
--   • FlipDesk is the subscription side — users.flipdesk_plan tracks tier
--     (free|starter|pro|business) and subscription_status tracks the Stripe
--     lifecycle (none|trialing|active|past_due|paused|canceled).
--   • GradeThread is consumption — users.grade_credit_balance holds prepaid
--     credits (1 credit = 1 Standard grade; Premium = 3, Express = 5). The
--     legacy users.grades_used_this_month column is REPURPOSED to mean
--     "included monthly grades used" so a FlipDesk subscriber can burn down
--     their tier's bundled allowance before debiting credits.
--
-- Legacy users.plan is kept for now and backfilled (US-225). It will be
-- dropped only after one full billing cycle confirms no code references it.
--
-- This migration is additive and idempotent: it can be re-run safely.

-- ── Enums ─────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE public.flipdesk_plan AS ENUM ('free', 'starter', 'pro', 'business');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.subscription_status AS ENUM (
    'none', 'trialing', 'active', 'past_due', 'paused', 'canceled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── users: new columns ────────────────────────────────────────────
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS flipdesk_plan public.flipdesk_plan NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS flipdesk_interval text
    CHECK (flipdesk_interval IS NULL OR flipdesk_interval IN ('monthly', 'yearly')),
  ADD COLUMN IF NOT EXISTS subscription_status public.subscription_status
    NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS flipdesk_subscription_id text,
  ADD COLUMN IF NOT EXISTS flipdesk_period_end timestamptz,
  ADD COLUMN IF NOT EXISTS flipdesk_pause_until timestamptz,
  ADD COLUMN IF NOT EXISTS flipdesk_cancel_at_period_end boolean
    NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS grade_credit_balance integer NOT NULL DEFAULT 0
    CHECK (grade_credit_balance >= 0),
  ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;

COMMENT ON COLUMN public.users.flipdesk_plan IS
  'FlipDesk subscription tier (US-200). Source of truth for active-listings cap, '
  'AI-actions cap, marketplace count, and included Standard grades per month.';

COMMENT ON COLUMN public.users.subscription_status IS
  'Stripe-driven subscription lifecycle. Free users without Stripe = ''none''. '
  'Paused subscribers retain credits + data but caps drop to Free in plan-gate (US-208).';

COMMENT ON COLUMN public.users.flipdesk_subscription_id IS
  'Stripe Subscription ID. Set on customer.subscription.created webhook (US-206).';

COMMENT ON COLUMN public.users.grade_credit_balance IS
  'GradeThread credit wallet. 1 credit = 1 Standard grade. Debit precedence in '
  'US-207: included grades → credits → one-time Checkout. Never expires.';

COMMENT ON COLUMN public.users.grades_used_this_month IS
  'REPURPOSED (US-201): now counts INCLUDED Standard grades used in the current '
  'billing cycle against the FlipDesk tier''s monthly bundle (Free 3, Starter 10, '
  'Pro 30, Business 75). Resets on invoice.payment_succeeded (US-206).';

COMMENT ON COLUMN public.users.trial_ends_at IS
  '14-day Pro trial expiry, set once by handle_new_user. One trial per user, ever (US-219).';

-- Partial unique index — at most one active Stripe subscription per user.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_flipdesk_subscription_id
  ON public.users(flipdesk_subscription_id)
  WHERE flipdesk_subscription_id IS NOT NULL;

-- ── grade_credit_transactions: append-only ledger ─────────────────
CREATE TABLE IF NOT EXISTS public.grade_credit_transactions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  delta                     integer NOT NULL,
  reason                    text NOT NULL CHECK (reason IN (
    'pack_purchase',
    'grade_debit',
    'included_grant',
    'admin_grant',
    'refund',
    'expiration'
  )),
  balance_after             integer NOT NULL CHECK (balance_after >= 0),
  submission_id             uuid REFERENCES public.submissions(id) ON DELETE SET NULL,
  stripe_payment_intent_id  text,
  notes                     text,
  created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_grade_credit_transactions_user_id_created_at
  ON public.grade_credit_transactions(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_grade_credit_transactions_submission_id
  ON public.grade_credit_transactions(submission_id)
  WHERE submission_id IS NOT NULL;

ALTER TABLE public.grade_credit_transactions ENABLE ROW LEVEL SECURITY;

-- Users read their own ledger; service-role writes only (functions below
-- run as SECURITY DEFINER, webhook + admin go through supabaseAdmin).
DROP POLICY IF EXISTS "Users read own credit ledger" ON public.grade_credit_transactions;
CREATE POLICY "Users read own credit ledger"
  ON public.grade_credit_transactions FOR SELECT
  USING (auth.uid() = user_id);

-- ── flipdesk_subscription_events: webhook idempotency + audit trail ──
CREATE TABLE IF NOT EXISTS public.flipdesk_subscription_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  stripe_event_id   text UNIQUE,
  event_type        text NOT NULL,
  from_plan         public.flipdesk_plan,
  to_plan           public.flipdesk_plan,
  raw_payload       jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flipdesk_subscription_events_user_id_created_at
  ON public.flipdesk_subscription_events(user_id, created_at DESC);

ALTER TABLE public.flipdesk_subscription_events ENABLE ROW LEVEL SECURITY;
-- No user-facing policy — admin reads via supabaseAdmin only.

-- ── debit_grade_credits ───────────────────────────────────────────
-- Atomic credit-spend with row lock. Raises INSUFFICIENT_CREDITS so the
-- caller can fall through to checkout (US-207).
CREATE OR REPLACE FUNCTION public.debit_grade_credits(
  p_user_id        uuid,
  p_credits        integer,
  p_submission_id  uuid,
  p_notes          text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance integer;
BEGIN
  IF p_credits <= 0 THEN
    RAISE EXCEPTION 'INVALID_CREDIT_AMOUNT: must be positive (got %)', p_credits;
  END IF;

  SELECT grade_credit_balance INTO v_balance
    FROM public.users
    WHERE id = p_user_id
    FOR UPDATE;

  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'USER_NOT_FOUND: %', p_user_id;
  END IF;

  IF v_balance < p_credits THEN
    RAISE EXCEPTION 'INSUFFICIENT_CREDITS: balance % < requested %', v_balance, p_credits;
  END IF;

  v_balance := v_balance - p_credits;

  UPDATE public.users
    SET grade_credit_balance = v_balance,
        updated_at = now()
    WHERE id = p_user_id;

  INSERT INTO public.grade_credit_transactions
    (user_id, delta, reason, balance_after, submission_id, notes)
    VALUES (p_user_id, -p_credits, 'grade_debit', v_balance, p_submission_id, p_notes);

  RETURN v_balance;
END;
$$;

-- ── grant_grade_credits ───────────────────────────────────────────
-- Atomic credit-grant for pack purchases, admin comps, and refund
-- reversals. Reason must match the ledger CHECK constraint.
CREATE OR REPLACE FUNCTION public.grant_grade_credits(
  p_user_id                uuid,
  p_credits                integer,
  p_reason                 text,
  p_stripe_payment_intent  text DEFAULT NULL,
  p_notes                  text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance integer;
BEGIN
  IF p_credits <= 0 THEN
    RAISE EXCEPTION 'INVALID_CREDIT_AMOUNT: must be positive (got %)', p_credits;
  END IF;

  IF p_reason NOT IN ('pack_purchase', 'admin_grant', 'refund') THEN
    RAISE EXCEPTION 'INVALID_GRANT_REASON: %', p_reason;
  END IF;

  SELECT grade_credit_balance INTO v_balance
    FROM public.users
    WHERE id = p_user_id
    FOR UPDATE;

  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'USER_NOT_FOUND: %', p_user_id;
  END IF;

  v_balance := v_balance + p_credits;

  UPDATE public.users
    SET grade_credit_balance = v_balance,
        updated_at = now()
    WHERE id = p_user_id;

  INSERT INTO public.grade_credit_transactions
    (user_id, delta, reason, balance_after, stripe_payment_intent_id, notes)
    VALUES (p_user_id, p_credits, p_reason, v_balance, p_stripe_payment_intent, p_notes);

  RETURN v_balance;
END;
$$;

-- ── handle_new_user: auto-start 14-day Pro trial (US-219) ──────────
-- Overrides the trigger from 00001. New signups land on Pro with
-- subscription_status='trialing' and trial_ends_at 14 days out. A daily
-- cron job (introduced with US-219) flips them to Free if they haven't
-- added a card by then. No Stripe subscription is created until the
-- user explicitly upgrades — we don't collect cards upfront.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.users (
    id, email, full_name, avatar_url,
    flipdesk_plan, subscription_status, trial_ends_at
  )
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data ->> 'full_name',
    NEW.raw_user_meta_data ->> 'avatar_url',
    'pro',
    'trialing',
    now() + interval '14 days'
  );
  RETURN NEW;
END;
$$;
