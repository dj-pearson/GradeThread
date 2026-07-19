-- US-2117: keep a record of what each user actually agreed to.
--
-- Today price is resolved LIVE on every read from pricing_plans, and
-- pricing_plans is mutated in place with only an updated_at trigger. There is no
-- history table and no versioning. So if a price changes, THE HISTORICAL RECORD
-- CHANGES WITH IT — there is no way to reconstruct what any user was shown or
-- agreed to on any past date.
--
-- That is a record-keeping problem, not a disclosure-copy problem: US-2114 gates
-- what the copy SAYS, this gates whether we can still prove what it said.
--
-- Four pieces, matching the story's ACs:
--   1. subscription_agreements — an IMMUTABLE snapshot per purchase
--   2. pricing_plan_revisions  — append-only history of pricing_plans
--   3. flipdesk_subscription_events.billing_interval (the gap 00215 noted)
--   4. subscription_cancellations — append-only, replacing the single mutable
--      users.cancellation_reason that each cancel overwrote

-- ── 1. The agreed-terms snapshot ────────────────────────────────────
--
-- IMMUTABILITY IS ENFORCED, not just intended: a BEFORE UPDATE trigger raises.
-- A comment asking people not to update a compliance record is not a control —
-- and this table's entire value is that its contents cannot drift.
CREATE TABLE IF NOT EXISTS public.subscription_agreements (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- What they agreed to, captured at the moment of purchase.
  plan                 text NOT NULL,
  billing_interval     text NOT NULL CHECK (billing_interval IN ('monthly', 'yearly')),
  amount_cents         integer NOT NULL CHECK (amount_cents >= 0),
  currency             text NOT NULL DEFAULT 'usd',
  -- Trial terms as presented (null when the purchase carried no trial).
  trial_days           integer CHECK (trial_days IS NULL OR trial_days >= 0),
  trial_ends_at        timestamptz,
  -- Which version of the disclosure copy was on screen. Nullable because the
  -- copy is versioned by US-2114/US-2115, which have not landed — recording the
  -- POINTER now means the column does not need a second migration later.
  disclosure_version   text,
  -- Provenance, so a row can be tied back to the Stripe object that created it.
  stripe_subscription_id text,
  stripe_price_id      text,
  source               text NOT NULL DEFAULT 'stripe'
                         CHECK (source IN ('stripe', 'appstore', 'google_play', 'manual')),
  agreed_at            timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscription_agreements_user
  ON public.subscription_agreements(user_id, agreed_at DESC);

-- One agreement per Stripe subscription per plan+interval+amount. A webhook
-- redelivery must not mint a second "agreement" for the same purchase.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_subscription_agreements_stripe
  ON public.subscription_agreements(stripe_subscription_id, plan, billing_interval, amount_cents)
  WHERE stripe_subscription_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.forbid_agreement_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'subscription_agreements is append-only (US-2117): a record of what a user agreed to must not be editable. Insert a new row instead.';
END;
$$;

DROP TRIGGER IF EXISTS trg_subscription_agreements_immutable ON public.subscription_agreements;
CREATE TRIGGER trg_subscription_agreements_immutable
  BEFORE UPDATE OR DELETE ON public.subscription_agreements
  FOR EACH ROW EXECUTE FUNCTION public.forbid_agreement_mutation();

COMMENT ON TABLE public.subscription_agreements IS
  'US-2117: IMMUTABLE snapshot of the terms a user agreed to at purchase. Enforced append-only by trigger. Exists because price is otherwise resolved live from a mutable pricing_plans row, so a price change silently rewrote history.';

-- ── 2. pricing_plans history ────────────────────────────────────────
--
-- Append-only revisions written by a trigger on pricing_plans, so a past price
-- is reconstructable WITHOUT anyone remembering to record one. A history table
-- that depends on the writer remembering is a history table with gaps.
CREATE TABLE IF NOT EXISTS public.pricing_plan_revisions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_key              text NOT NULL,
  price_monthly_cents   integer NOT NULL,
  price_yearly_cents    integer NOT NULL,
  stripe_price_monthly  text,
  stripe_price_yearly   text,
  -- Full row snapshot, so a column added to pricing_plans later is still
  -- captured historically without another migration here.
  snapshot              jsonb NOT NULL,
  revised_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pricing_plan_revisions_key_time
  ON public.pricing_plan_revisions(plan_key, revised_at DESC);

CREATE OR REPLACE FUNCTION public.record_pricing_plan_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Record the OLD row on update (what the price WAS), and the NEW row on
  -- insert (the starting point). Skip no-op updates that touch neither price.
  IF TG_OP = 'UPDATE'
     AND OLD.price_monthly_cents IS NOT DISTINCT FROM NEW.price_monthly_cents
     AND OLD.price_yearly_cents IS NOT DISTINCT FROM NEW.price_yearly_cents
     AND OLD.stripe_price_monthly IS NOT DISTINCT FROM NEW.stripe_price_monthly
     AND OLD.stripe_price_yearly IS NOT DISTINCT FROM NEW.stripe_price_yearly
  THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.pricing_plan_revisions (
    plan_key, price_monthly_cents, price_yearly_cents,
    stripe_price_monthly, stripe_price_yearly, snapshot
  )
  SELECT
    r.key, r.price_monthly_cents, r.price_yearly_cents,
    r.stripe_price_monthly, r.stripe_price_yearly, to_jsonb(r)
  FROM (SELECT (CASE WHEN TG_OP = 'UPDATE' THEN OLD ELSE NEW END).*) AS r;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pricing_plans_revision ON public.pricing_plans;
CREATE TRIGGER trg_pricing_plans_revision
  AFTER INSERT OR UPDATE ON public.pricing_plans
  FOR EACH ROW EXECUTE FUNCTION public.record_pricing_plan_revision();

COMMENT ON TABLE public.pricing_plan_revisions IS
  'US-2117: append-only history of pricing_plans, written by trigger so a past price is reconstructable without anyone remembering to record one.';

-- Seed the current state as revision zero, so the history has a floor rather
-- than starting empty and implying prices never existed before today.
INSERT INTO public.pricing_plan_revisions (
  plan_key, price_monthly_cents, price_yearly_cents,
  stripe_price_monthly, stripe_price_yearly, snapshot
)
SELECT p.key, p.price_monthly_cents, p.price_yearly_cents,
       p.stripe_price_monthly, p.stripe_price_yearly, to_jsonb(p)
FROM public.pricing_plans p
WHERE NOT EXISTS (
  SELECT 1 FROM public.pricing_plan_revisions r WHERE r.plan_key = p.key
);

-- ── 3. The billing interval 00215 noted was missing ─────────────────
ALTER TABLE public.flipdesk_subscription_events
  ADD COLUMN IF NOT EXISTS billing_interval text;

COMMENT ON COLUMN public.flipdesk_subscription_events.billing_interval IS
  'US-2117: monthly|yearly. 00215 recorded that this gap made a plan change ambiguous — from_plan/to_plan alone cannot distinguish a monthly→yearly switch from a no-op.';

-- ── 4. Append-only cancellations ────────────────────────────────────
--
-- users.cancellation_reason is a single mutable text column, so a second cancel
-- overwrote the first. Someone who cancelled, resubscribed and cancelled again
-- left one reason on the record and no trace that it happened twice.
CREATE TABLE IF NOT EXISTS public.subscription_cancellations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  reason            text,
  plan_at_cancel    text,
  interval_at_cancel text,
  cancelled_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscription_cancellations_user
  ON public.subscription_cancellations(user_id, cancelled_at DESC);

COMMENT ON TABLE public.subscription_cancellations IS
  'US-2117: append-only cancellation history. users.cancellation_reason is a single mutable column that each cancel overwrote, so a repeat canceller left no trace of the earlier one. That column is KEPT for now (readers still use it); this is the durable record.';

-- Backfill the one reason we still hold, so the history is not falsely empty
-- for users who have already cancelled.
INSERT INTO public.subscription_cancellations (user_id, reason, cancelled_at)
SELECT u.id, u.cancellation_reason, COALESCE(u.updated_at, now())
FROM public.users u
WHERE u.cancellation_reason IS NOT NULL
  AND btrim(u.cancellation_reason) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM public.subscription_cancellations c WHERE c.user_id = u.id
  );

-- ── RLS: operator surfaces, service-role only ───────────────────────
--
-- These are compliance records read by admin/support tooling through the
-- service-role client (which bypasses RLS). No user-facing policy: a seller has
-- no route that reads them, and a deny-all default is the safe posture for a
-- table whose whole purpose is evidentiary.
ALTER TABLE public.subscription_agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pricing_plan_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_cancellations ENABLE ROW LEVEL SECURITY;

insert into public.applied_migrations (version) values ('00486') on conflict do nothing;
