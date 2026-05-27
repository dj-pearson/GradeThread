-- Legacy user backfill (US-225).
--
-- 00037 added users.flipdesk_plan + subscription_status with safe defaults
-- ('free' / 'none'), and a new handle_new_user trigger that puts every NEW
-- signup on a 14-day Pro trial. Existing rows still have:
--   • plan ∈ {'free','starter','professional','enterprise'} (legacy)
--   • flipdesk_plan = 'free' (the default applied by ALTER TABLE)
--   • subscription_status = 'none' (default)
--
-- That's wrong for users who already had a paid legacy plan + an active
-- Stripe subscription. This migration backfills them.
--
-- The legacy plan column is INTENTIONALLY KEPT here. It will be dropped in
-- a later cleanup migration once we've verified no code path reads it and
-- one full billing cycle has rolled over (so we can compare).
--
-- Mapping (per US-200):
--   free          → free
--   starter       → starter   (price unchanged at $29)
--   professional  → pro       (price was $99, will need a Stripe price swap; see Stripe reconciliation note below)
--   enterprise    → business  (was "Custom" — now a flat $99 Business tier; admin must reconcile high-tier customers manually)
--
-- subscription_status:
--   NULL/no Stripe customer  → 'none'
--   Has stripe_customer_id   → 'active' (best guess; the Stripe reconciliation
--                              script verifies and corrects past_due/canceled/paused)
--
-- IMPORTANT: Stripe subscriptions are NOT touched by this migration. The
-- mapping above means "professional" users on the old $99 Stripe price
-- still get billed $99 — they just receive the new "pro" feature set
-- (which is $59 worth) until ops manually swaps their price via the
-- Stripe portal or a separate reconciliation script. Customers who paid
-- for legacy "enterprise" (which had no fixed price) need admin attention
-- — they're flagged via the subscription_status='active' + legacy plan
-- mismatch query below.
--
-- Idempotent: the predicate `flipdesk_plan = 'free' AND plan != 'free'`
-- ensures we don't reprocess rows that have already been touched (either
-- by this migration or by US-204's webhook).

-- ── Backfill ──────────────────────────────────────────────────────
UPDATE public.users
   SET flipdesk_plan = CASE plan
         WHEN 'free'         THEN 'free'
         WHEN 'starter'      THEN 'starter'
         WHEN 'professional' THEN 'pro'
         WHEN 'enterprise'   THEN 'business'
         ELSE 'free'
       END::public.flipdesk_plan,
       subscription_status = CASE
         WHEN stripe_customer_id IS NULL THEN 'none'::public.subscription_status
         ELSE 'active'::public.subscription_status
       END,
       -- We don't know the Stripe interval at the DB level — default to monthly.
       -- The Stripe reconciliation script corrects this from the live Stripe sub.
       flipdesk_interval = CASE
         WHEN stripe_customer_id IS NULL THEN NULL
         ELSE 'monthly'
       END
 WHERE flipdesk_plan = 'free'          -- haven't been backfilled yet
   AND plan != 'free';                 -- legacy plan was something other than free

-- ── Operator review query (informational only) ────────────────────
--
-- Run after the backfill to find users whose Stripe price ID likely needs
-- to be reconciled manually:
--
--   SELECT id, email, plan AS legacy_plan, flipdesk_plan, stripe_customer_id
--     FROM public.users
--    WHERE stripe_customer_id IS NOT NULL
--      AND ((plan = 'professional' AND flipdesk_plan = 'pro')
--           OR (plan = 'enterprise' AND flipdesk_plan = 'business'))
--    ORDER BY plan, email;
--
-- For each row in that query, ops should: (a) look up the active Stripe
-- subscription, (b) check whether the existing price matches the new
-- catalog from 00037+US-203, and (c) if not, schedule a subscription
-- price swap via the Stripe dashboard or a script (see US-225 AC for the
-- scripts/backfill-stripe-state.ts spec).

-- ── Telemetry sentinel ────────────────────────────────────────────
--
-- A one-shot row in flipdesk_subscription_events so the backfill is
-- auditable from the same admin queue as live webhook events. Uses a
-- synthetic event id so the unique constraint will reject a re-run.
INSERT INTO public.flipdesk_subscription_events (
    user_id, stripe_event_id, event_type, from_plan, to_plan, raw_payload
  )
  SELECT
    id,
    'migration_00039_' || id::text,
    'pricing.migrated',
    'free'::public.flipdesk_plan,
    flipdesk_plan,
    jsonb_build_object(
      'legacy_plan', plan,
      'migrated_at', now()::text,
      'has_stripe_customer', stripe_customer_id IS NOT NULL
    )
  FROM public.users
  WHERE plan != 'free'
    AND flipdesk_plan != 'free'
ON CONFLICT (stripe_event_id) DO NOTHING;
