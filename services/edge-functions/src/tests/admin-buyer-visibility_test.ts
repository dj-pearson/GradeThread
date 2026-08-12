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
  // The mapper lives in lib/, not beside the route — see its own header. Adding
  // a top-level declaration to an admin route file moves the boundaries
  // scripts/audit-admin-mutations.mjs slices on, and putting it there made
  // three unrelated routes report as writing no audit row.
  const SUMMARY_MODULE = code(
    Deno.readTextFileSync(
      new URL("../lib/admin-subscription-summary.ts", import.meta.url),
    ),
  );
  const body = fnBody(SUMMARY_MODULE, "export function summarizeAdminSubscription");
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

Deno.test("US-2458: the field is RENDERED, not just returned", () => {
  // The failure this whole session keeps finding, committed by me an hour ago:
  // I added `buyerSubscription` to the API and no surface displayed it, so
  // support still saw nothing. A route with no caller is invisible to tsc, to
  // lint, and to every test that exercises the route directly — which is
  // exactly how US-2145's contest endpoint sat unreachable behind a missing
  // button, and how the confirm-signup evidence path recorded nothing for
  // months.
  const card = code(
    Deno.readTextFileSync(
      new URL("../../../../src/components/admin/billing-actions-card.tsx", import.meta.url),
    ),
  );
  assert(
    card.includes("buyerSubscription"),
    "the admin billing card must consume buyerSubscription — returning it and " +
      "rendering nothing leaves the gap exactly where it was",
  );
  assert(
    /subscription=\{payments\.data\.buyerSubscription\}/.test(card),
    "it must be passed to the summary, not merely typed",
  );
  // Labelled: two subscriptions can be on screen at once and the agent is about
  // to act on whichever they believe they are looking at.
  assert(
    /label="Buyer subscription"/.test(card) && /label="FlipDesk subscription"/.test(card),
    "each subscription must be labelled by product",
  );
  // One shared block, so a field cannot render for one product and not the
  // other — which reads as "the buyer has no renewal date" rather than as a bug.
  const uses = [...card.matchAll(/<SubscriptionSummary\b/g)];
  assert(uses.length === 2, `expected both to use the shared block, found ${uses.length}`);
});

// ── US-2458 AC5: buyer past-due accounts reach the operator ──────────────
//
// The reconciliation panel filters `users.subscription_status`, which is the
// SELLER column. A buyer whose card failed appeared in no operator surface at
// all, so support found out when the customer wrote in.

const WEBHOOKS = code(
  await Deno.readTextFile(new URL("../routes/webhooks.ts", import.meta.url)),
);

/** The reconciliation route, from its registration to the next one. */
const RECONCILIATION_ROUTE = (() => {
  const at = ADMIN_BILLING.indexOf('adminBillingRoutes.get("/billing/reconciliation"');
  if (at === -1) throw new Error("the reconciliation route was renamed");
  const next = ADMIN_BILLING.indexOf("adminBillingRoutes.", at + 30);
  return ADMIN_BILLING.slice(at, next === -1 ? ADMIN_BILLING.length : next);
})();

Deno.test("US-2458 AC5: buyer past-due accounts are queried at all", () => {
  assert(
    /buyer_subscription_status/.test(RECONCILIATION_ROUTE),
    "the reconciliation panel does not look at buyer_subscription_status, so a " +
      "buyer in dunning is invisible to support",
  );
  assert(
    /buyer_past_due_since/.test(RECONCILIATION_ROUTE),
    "the buyer list is not ordered by its dunning anchor, so support cannot " +
      "tell a card that failed today from one failing for three weeks",
  );
});

Deno.test("US-2458 AC5: the two products are separate lists, never merged", () => {
  // THE POINT OF THE WHOLE STORY. AC3 exists because conflating the two is the
  // mistake the reconciliation resync already made once (US-2457 AC5): it
  // adopted a buyer subscription into flipdesk_subscription_id, and the remedy
  // an operator reaches for next could push a FlipDesk price onto someone's
  // Guard plan. A merged list would put that ambiguity back on screen.
  assert(
    /buyerPastDue:/.test(RECONCILIATION_ROUTE),
    "the response no longer carries a distinct buyerPastDue list",
  );
  assert(
    /pastDue: \{ data: pastDue/.test(RECONCILIATION_ROUTE),
    "the seller pastDue list changed shape — AC2 requires the existing field " +
      "keep its exact meaning so current consumers are unchanged",
  );
  // The seller query must still filter the SELLER column only.
  //
  // Anchored on CODE, not on the '(a)' / '(a2)' section comments: the shared
  // `code()` helper strips comments before any of this runs, so a
  // comment-based slice silently matched nothing and this case failed against
  // correct code. That is the same class the source-scan helper has been bitten
  // by twice before.
  const sellerFilter = RECONCILIATION_ROUTE.indexOf(
    '.in("subscription_status", ["past_due", "paused"])',
  );
  assert(sellerFilter > -1, "the seller past-due filter was restructured");
  const sellerQuery = RECONCILIATION_ROUTE.slice(
    Math.max(0, sellerFilter - 600),
    sellerFilter,
  );
  assert(
    !/buyer_/.test(sellerQuery),
    "the seller past-due query now reads a buyer column, which is exactly the " +
      "conflation AC3 forbids",
  );
});

Deno.test("US-2458 AC5: the buyer dunning clock is stamped where status is", () => {
  assert(
    /buyer_past_due_since: nextPastDueSince\(/.test(WEBHOOKS),
    "the buyer dunning anchor is not set from nextPastDueSince, so it will not " +
      "survive a retry and the clock can never elapse",
  );
  // It must be stamped beside buyer_subscription_status, NOT from an invoice
  // handler — the file's own comment explains that writing buyer status from an
  // invoice event makes the stored state depend on Stripe's delivery order.
  const at = WEBHOOKS.indexOf("buyer_past_due_since: nextPastDueSince(");
  const window = WEBHOOKS.slice(Math.max(0, at - 900), at);
  assert(
    /buyer_subscription_status: status/.test(window),
    "the buyer dunning anchor is written somewhere other than the " +
      "customer.subscription.updated handler that owns buyer status",
  );
});
