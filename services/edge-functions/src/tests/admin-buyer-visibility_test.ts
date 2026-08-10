// US-2458: support can see a buyer subscription.
//
// No admin route read buyer_plan, buyer_subscription_status or
// buyer_subscription_id. GET /users/:id/payments selected only
// flipdesk_subscription_id, so an agent opening a Guard or Connoisseur
// subscriber saw `subscription: null` — no way to tell whether they were
// subscribed, to what, or when it renewed.
//
// It went unnoticed because the CHARGES were fine: they are listed
// customer-wide and both products ride one Stripe customer, so the money half
// of a support conversation worked while the state half was blank.

import { assert } from "@std/assert";
import { callArgs, code, fnBody } from "./_source-scan.ts";

const ADMIN_BILLING = code(
  await Deno.readTextFile(new URL("../routes/admin-billing.ts", import.meta.url)),
);

/** The payments route, from its registration to the next one. */
const PAYMENTS_ROUTE = (() => {
  const at = ADMIN_BILLING.indexOf('adminBillingRoutes.get("/users/:id/payments"');
  if (at === -1) throw new Error("the payments route was renamed");
  const next = ADMIN_BILLING.indexOf("adminBillingRoutes.", at + 30);
  return ADMIN_BILLING.slice(at, next === -1 ? ADMIN_BILLING.length : next);
})();

Deno.test("US-2458 AC1: the buyer subscription is loaded and returned", () => {
  // Scoped to the SELECT LIST, not the route. The identifier also appears in
  // the retrieve below, so a route-wide check stayed green when the column was
  // dropped from the select — and an unselected column reads as `undefined`,
  // so the buyer subscription silently becomes null again with no error
  // anywhere. Same use-versus-source miss as the guards US-2454 catalogues.
  const selectArgs = callArgs(PAYMENTS_ROUTE, ".select");
  assert(
    selectArgs.includes("buyer_subscription_id"),
    "buyer_subscription_id must be in the SELECT — unselected it is undefined, " +
      "the retrieve is skipped, and the agent sees the same blank as before",
  );
  assert(
    /buyerSubscription: summarizeAdminSubscription\(buyerSubscription\)/.test(PAYMENTS_ROUTE),
    "the buyer subscription must be returned to the client",
  );
});

Deno.test("US-2458 AC2: the seller field keeps its exact meaning", () => {
  // Additive on purpose. Repurposing `subscription` to mean "whichever they
  // have" would break every consumer AND repeat the conflation this fixes.
  assert(
    /subscription: summarizeAdminSubscription\(subscription\)/.test(PAYMENTS_ROUTE),
    "`subscription` must still be the SELLER subscription",
  );
  // The no-customer early return has to carry the new field too, or a caller
  // that reads it gets `undefined` on one path and `null` on the other.
  assert(
    /return c\.json\(\{ charges: \[\], subscription: null, buyerSubscription: null \}\)/
      .test(PAYMENTS_ROUTE),
    "the no-customer response must include buyerSubscription: null",
  );
});

Deno.test("US-2458 AC3: the two subscriptions are never conflated", () => {
  // Each is retrieved by its OWN stored id. Listing the customer and choosing
  // is exactly what let the reconciliation resync adopt the buyer subscription
  // into the seller columns (US-2457 AC5) — the ids are recorded separately
  // precisely so nobody has to guess.
  const args = callArgs(PAYMENTS_ROUTE, "Promise.all");
  assert(
    /targetUser\.flipdesk_subscription_id\s*\r?\n?\s*\?\s*stripe\.subscriptions\.retrieve\(targetUser\.flipdesk_subscription_id\)/
      .test(args),
    "the seller field must come from flipdesk_subscription_id",
  );
  assert(
    /targetUser\.buyer_subscription_id\s*\r?\n?\s*\?\s*stripe\.subscriptions\.retrieve\(targetUser\.buyer_subscription_id\)/
      .test(args),
    "the buyer field must come from buyer_subscription_id",
  );
  assert(
    !/subscriptions\.list\(/.test(PAYMENTS_ROUTE),
    "this route must never LIST the customer's subscriptions and choose — that " +
      "is the shape that produced US-2457 AC5",
  );
});

Deno.test("US-2458: both summaries share one shape", () => {
  // An agent is comparing one against the other. Two hand-written shapes drift,
  // and the drift shows up as a field that is present for sellers and missing
  // for buyers, which reads as "the buyer has no renewal date".
  const body = fnBody(ADMIN_BILLING, "function summarizeAdminSubscription");
  for (const field of [
    "id:",
    "status:",
    "current_period_end:",
    "cancel_at_period_end:",
    "items:",
  ]) {
    assert(body.includes(field), `the shared summary lost ${field}`);
  }
  const uses = [...PAYMENTS_ROUTE.matchAll(/summarizeAdminSubscription\(/g)];
  assert(
    uses.length === 2,
    `expected both subscriptions to go through the shared summary, found ${uses.length}`,
  );
});
