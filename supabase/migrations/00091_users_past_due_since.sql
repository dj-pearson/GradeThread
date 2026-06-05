-- US-395: downgrade entitlement on exhausted dunning.
--
-- A failing renewal moves the subscription to `past_due` (mapSubscriptionStatus
-- also folds Stripe's `unpaid` end-state into `past_due`). Previously a past_due
-- subscription kept its paid FlipDesk caps indefinitely, so a permanently-dead
-- card never lost Pro/Business access. We now anchor when dunning began so
-- effectivePlanFor() (lib/grade-pricing.ts) can drop the account to Free caps
-- once a grace window (PAST_DUE_GRACE_MS = 14 days) elapses, while a transient
-- decline + Stripe Smart-Retry success inside the window keeps caps intact.
--
-- The webhook sets this on the FIRST failed invoice and preserves it across
-- retries (so the clock can actually elapse); any successful payment / recovery
-- to active|trialing clears it back to null.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS past_due_since timestamptz;

COMMENT ON COLUMN public.users.past_due_since IS
  'US-395: timestamp dunning began for this subscription (first failed renewal). Anchors the grace window after which a past_due/unpaid sub loses paid caps; null when not in dunning.';
