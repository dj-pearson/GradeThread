-- US-2458 AC5: the buyer half of the dunning clock.
--
-- `past_due_since` (00091) anchors when dunning began for the SELLER
-- subscription, and the operator's past-due panel sorts by it. The buyer
-- product has `buyer_subscription_status` but no equivalent anchor, so a buyer
-- whose card fails is invisible to that panel: support cannot see them, cannot
-- sort them by how long they have been failing, and finds out when the customer
-- writes in.
--
-- Same shape and same lifecycle as its seller twin, deliberately: set on the
-- FIRST transition into past_due and preserved across retries so the clock can
-- actually elapse, cleared on recovery to active/trialing. The pure helper that
-- decides it (`nextPastDueSince`, lib/grade-pricing.ts) is already product-
-- agnostic and needs no change.
--
-- NOT wired to entitlement. The seller column additionally drives
-- `effectivePlanFor()` dropping paid caps after PAST_DUE_GRACE_MS; this one is
-- OPERATOR VISIBILITY ONLY for now. Dropping a buyer's caps on a dunning clock
-- is a product decision that belongs with US-2458 AC4, and doing it silently
-- here would be a pricing change smuggled in as a column.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS buyer_past_due_since timestamptz;

COMMENT ON COLUMN public.users.buyer_past_due_since IS
  'US-2458: timestamp dunning began for the BUYER subscription (first failed renewal). Mirrors past_due_since, which is the seller equivalent. Operator visibility only - it does NOT gate buyer entitlement. Null when not in dunning.';

-- US-1108 self-record footer.
insert into public.applied_migrations (version) values ('00591') on conflict do nothing;
