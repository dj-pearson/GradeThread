-- 00110_super_admin_business_plan.sql
--
-- Give the platform owner (role = 'super_admin') a Business-tier account so the
-- billing UI and any plan-driven logic treat them as Business. Runs AFTER
-- 00109's Stripe live-cutover reset (which set every row, including the owner,
-- back to free/none) so it must re-elevate the super_admin here.
--
-- Unlimited GRADING for the super_admin is enforced in code, not data:
--   • grade-billing.ts runPaymentPrecedence() — super_admin grades are free +
--     uncapped (no credit debit, no monthly cap).
--   • plan-gate.ts requireFlipdesk() — super_admin bypasses all caps/features.
-- This migration only sets the *displayed* plan/status.
--
-- subscription_status = 'active' (not 'trialing'/'none') so effectivePlanFor()
-- resolves to Business and never downgrades to Free. No Stripe subscription
-- backs this — the super_admin is comped, never charged. stripe_customer_id is
-- intentionally left as-is (null after 00109); the owner has no live customer
-- and needs none.
--
-- Scoped strictly to role = 'super_admin' — regular admins/reviewers/users are
-- untouched. Idempotent: safe to re-run.

BEGIN;

UPDATE public.users
SET
  flipdesk_plan       = 'business',
  subscription_status = 'active',
  trial_ends_at       = NULL,
  past_due_since      = NULL,
  -- Also set the DEPRECATED legacy single-plan column (different enum:
  -- free|starter|professional|enterprise) to its top tier. A handful of
  -- frontend surfaces still read users.plan (settings AI cap, api-keys
  -- gating, dashboard, bulk flows) until US-225 finishes migrating them to
  -- flipdesk_plan; without this the owner would still look "Free" there.
  plan                = 'enterprise'
WHERE role = 'super_admin';

COMMIT;
