-- 00109_stripe_live_cutover_reset.sql
--
-- Stripe test → live cutover cleanup.
--
-- We switched the edge service from Stripe TEST keys to LIVE keys. Every
-- Stripe object id we persisted while on test keys (customer `cus_…`,
-- subscription `sub_…`) is a sandbox object that does NOT exist under the live
-- keys — Stripe returns `resource_missing` ("No such customer: cus_…") for it.
-- That broke billing-summary (logged noise), and would hard-fail checkout, the
-- billing portal, and subscribe.
--
-- Fix: null out the stale Stripe linkage and reset the FlipDesk subscription
-- state to the free/none baseline for every row that ever touched test Stripe.
-- The app re-creates a fresh LIVE customer lazily on the next billing action
-- (ensureStripeCustomer), and these users simply have no live subscription
-- until they subscribe again with a live payment method — which is correct,
-- since their test subscription never existed under the live account.
--
-- Grade-credit balances are deliberately PRESERVED (they are earned/granted
-- ledger state, not a Stripe object reference). If you want a fully clean
-- launch that also voids credits bought with test cards, run the optional
-- block at the bottom.
--
-- Idempotent: safe to re-run. Only touches rows that still carry a Stripe id.

BEGIN;

UPDATE public.users
SET
  stripe_customer_id            = NULL,
  flipdesk_subscription_id      = NULL,
  subscription_status           = 'none',
  flipdesk_plan                 = 'free',
  flipdesk_interval             = NULL,
  flipdesk_period_end           = NULL,
  flipdesk_pause_until          = NULL,
  flipdesk_cancel_at_period_end = FALSE,
  pending_flipdesk_plan         = NULL,
  pending_flipdesk_interval     = NULL,
  pending_effective_at          = NULL
WHERE stripe_customer_id IS NOT NULL
   OR flipdesk_subscription_id IS NOT NULL;

COMMIT;

-- ── OPTIONAL: also void test-mode grade credits for a clean launch ──────────
-- Uncomment and re-run ONLY if you want everyone's credit balance zeroed.
-- This does NOT write ledger rows; it is a hard reset of the cached balance.
--
-- BEGIN;
-- UPDATE public.users
-- SET grade_credit_balance = 0
-- WHERE grade_credit_balance <> 0;
-- COMMIT;
