// US-391: pure decision for linking a Stripe customer to a user, so the
// "one user → exactly one customer" reconciliation is unit-testable without a
// DB or Stripe. The webhook (linkStripeCustomer) acts on the result:
//   "noop"     → stored id already matches; nothing to do.
//   "set"      → no customer linked yet; persist this one.
//   "conflict" → a DIFFERENT customer is already linked (a duplicate exists);
//                keep the stored canonical id and alert for manual merge.
export type CustomerLinkAction = "set" | "noop" | "conflict";

export function reconcileCustomerLink(
  current: string | null,
  incoming: string,
): CustomerLinkAction {
  if (current === incoming) return "noop";
  if (current === null || current === "") return "set";
  return "conflict";
}

// US-391: the stable idempotency key for lazily creating a user's Stripe
// customer. A concurrent first-checkout race calls customers.create with the
// SAME key, so Stripe returns one customer to all racers (no duplicates).
export function customerCreateIdempotencyKey(userId: string): string {
  return `customer-create:${userId}`;
}
