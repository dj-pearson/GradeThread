-- US-1799: buyer subscription state on public.users.
--
-- The Buyer Platform (US-1794/1795) sells a recurring buyer subscription
-- (Free / Guard / Connoisseur) that is SEPARATE from any FlipDesk/seller plan.
-- One person can hold BOTH on one Stripe customer, so buyer subscription state
-- lives in its own column family (buyer_*) alongside the existing flipdesk_*
-- family — never sharing a column, so the webhook can resolve+store each product
-- independently (plan resolved by matching the price id, US-1799).
--
-- Reuses the existing public.subscription_status enum (none/trialing/active/
-- past_due/paused/canceled) for buyer_subscription_status. Adds a buyer_plan enum
-- mirroring BUYER_PLANS in src/lib/constants.ts.
--
-- These are BILLING columns: they are added to guard_users_protected_columns so
-- the account owner cannot self-grant a buyer plan from the browser (US-347). The
-- edge (service-role) + Stripe webhook are the only writers.

-- ── buyer_plan enum ─────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE public.buyer_plan AS ENUM ('free', 'guard', 'connoisseur');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── users: buyer subscription columns ───────────────────────────────
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS buyer_plan public.buyer_plan NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS buyer_interval text
    CHECK (buyer_interval IS NULL OR buyer_interval IN ('monthly', 'yearly')),
  ADD COLUMN IF NOT EXISTS buyer_subscription_status public.subscription_status
    NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS buyer_subscription_id text,
  ADD COLUMN IF NOT EXISTS buyer_period_end timestamptz,
  ADD COLUMN IF NOT EXISTS buyer_cancel_at_period_end boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.users.buyer_plan IS
  'US-1799: active buyer-platform plan (free/guard/connoisseur). Separate from flipdesk_plan; both can be paid on one Stripe customer.';
COMMENT ON COLUMN public.users.buyer_subscription_id IS
  'US-1799: Stripe subscription id for the BUYER product (distinct from flipdesk_subscription_id).';

-- ── Freeze the new billing columns against browser self-update ──────
-- CREATE OR REPLACE over 00331: identical guard plus the buyer_* billing columns.
CREATE OR REPLACE FUNCTION public.guard_users_protected_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only end-user (browser) updates are guarded. Service-role (edge functions),
  -- SECURITY DEFINER triggers, and direct DB/admin sessions run under a
  -- different role and are permitted to manage these columns.
  IF auth.role() IS DISTINCT FROM 'authenticated' THEN
    RETURN NEW;
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role
     OR NEW.suspended IS DISTINCT FROM OLD.suspended
     OR NEW.plan IS DISTINCT FROM OLD.plan
     OR NEW.grades_used_this_month IS DISTINCT FROM OLD.grades_used_this_month
     OR NEW.grade_reset_at IS DISTINCT FROM OLD.grade_reset_at
     OR NEW.grade_credit_balance IS DISTINCT FROM OLD.grade_credit_balance
     OR NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id
     OR NEW.flipdesk_plan IS DISTINCT FROM OLD.flipdesk_plan
     OR NEW.flipdesk_interval IS DISTINCT FROM OLD.flipdesk_interval
     OR NEW.subscription_status IS DISTINCT FROM OLD.subscription_status
     OR NEW.flipdesk_subscription_id IS DISTINCT FROM OLD.flipdesk_subscription_id
     OR NEW.flipdesk_period_end IS DISTINCT FROM OLD.flipdesk_period_end
     OR NEW.flipdesk_pause_until IS DISTINCT FROM OLD.flipdesk_pause_until
     OR NEW.flipdesk_cancel_at_period_end IS DISTINCT FROM OLD.flipdesk_cancel_at_period_end
     OR NEW.trial_ends_at IS DISTINCT FROM OLD.trial_ends_at
     OR NEW.pending_flipdesk_plan IS DISTINCT FROM OLD.pending_flipdesk_plan
     OR NEW.pending_flipdesk_interval IS DISTINCT FROM OLD.pending_flipdesk_interval
     -- US-1799: buyer subscription billing columns (edge/webhook-only writers).
     OR NEW.buyer_plan IS DISTINCT FROM OLD.buyer_plan
     OR NEW.buyer_interval IS DISTINCT FROM OLD.buyer_interval
     OR NEW.buyer_subscription_status IS DISTINCT FROM OLD.buyer_subscription_status
     OR NEW.buyer_subscription_id IS DISTINCT FROM OLD.buyer_subscription_id
     OR NEW.buyer_period_end IS DISTINCT FROM OLD.buyer_period_end
     OR NEW.buyer_cancel_at_period_end IS DISTINCT FROM OLD.buyer_cancel_at_period_end
  THEN
    RAISE EXCEPTION
      'users: protected account columns (role/suspension/plan/billing/usage) cannot be modified by the account owner';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.guard_users_protected_columns() IS
  'US-347 (00331) + US-1799: freezes role/suspension/plan/billing/usage columns (incl. buyer_* subscription state) against end-user (authenticated-role) self-updates. Service-role and SECURITY DEFINER paths bypass via the auth.role() check.';

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00402')
ON CONFLICT (version) DO NOTHING;
