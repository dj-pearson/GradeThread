// US-2458: the subscription shape the admin billing tab renders.
//
// Extracted so the SELLER and BUYER summaries cannot drift into two different
// shapes — the agent reading them is comparing one against the other, and a
// field present for one and missing for the other reads as "the buyer has no
// renewal date" rather than as a bug.
//
// It lives in lib/ rather than beside the route, and that is not a style
// preference. scripts/audit-admin-mutations.mjs classifies every admin mutation
// by slicing each route's body and appending the body of any TOP-LEVEL
// DECLARATION it references, where a declaration's body runs to the next
// declaration in the file. Adding one to an admin route file therefore moves
// those boundaries, and adding this helper there made three unrelated routes —
// /pending-refunds/:id/resolve, /webhook-dead-letters/:id/resolve and the
// reconciliation resync — report as writing no audit row, failing the US-2355
// policy guard. They audit fine; the classifier's slice had changed underneath
// them. A presentational mapper is not worth perturbing that.

import type Stripe from "stripe";

export interface AdminSubscriptionSummary {
  id: string;
  status: string;
  current_period_end: number | null;
  cancel_at_period_end: boolean;
  items: Array<{
    price_id: string;
    unit_amount: number | null;
    interval: string | undefined;
    lookup_key: string | null;
  }>;
}

export function summarizeAdminSubscription(
  sub: Stripe.Subscription | null,
): AdminSubscriptionSummary | null {
  if (!sub) return null;
  return {
    id: sub.id,
    status: sub.status,
    current_period_end: sub.current_period_end ?? null,
    cancel_at_period_end: sub.cancel_at_period_end ?? false,
    items: sub.items.data.map((it: Stripe.SubscriptionItem) => ({
      price_id: it.price.id,
      unit_amount: it.price.unit_amount,
      interval: it.price.recurring?.interval,
      lookup_key: it.price.lookup_key,
    })),
  };
}
