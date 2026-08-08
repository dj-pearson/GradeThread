-- US-2287: users_billing_source_chk rejects 'googleplay'.
--
-- 00104_appstore_billing.sql created the constraint allowing only
-- ('stripe','appstore') and no later migration ever widened it, while the
-- Google Play grant path stamps billing_source='googleplay'. Every Play
-- subscription grant UPDATE therefore fails with 23514: the customer is
-- charged by Google and receives no entitlement.
--
-- Three sibling constraints WERE widened for Play (00354 dead-letter provider,
-- 00414 buyer_billing_source, 00486 agreed-terms source) which is why a grep
-- for 'googleplay' in the migration corpus looks reassuring. Only the
-- seller-side users constraint was left behind.
--
-- The allowed set below is the exact set of literals the code writes:
--   'stripe'     routes/webhooks.ts
--   'appstore'   lib/appstore/reconcile.ts
--   'googleplay' lib/google-play/products.ts
-- src/test/billing-source-constraint.test.ts pins that correspondence so a
-- fourth processor cannot be added in code without this constraint following.

-- Idempotent: drop-then-add, so re-running the directory converges on the
-- widened definition rather than skipping on an IF NOT EXISTS probe (which is
-- what let the stale 00104 definition survive every subsequent apply).
ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_billing_source_chk;

ALTER TABLE public.users
  ADD CONSTRAINT users_billing_source_chk
  CHECK (billing_source IS NULL OR billing_source IN ('stripe', 'appstore', 'googleplay'));

COMMENT ON CONSTRAINT users_billing_source_chk ON public.users IS
  'US-2287: allowed set must match the billing_source literals the code writes (stripe/appstore/googleplay).';

-- US-1108: self-record this migration's version so the edge schema-version
-- guard (US-778) stays in sync regardless of apply method.
INSERT INTO public.applied_migrations (version) VALUES ('00558')
ON CONFLICT (version) DO NOTHING;
