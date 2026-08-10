// US-2457 AC5: the operator resync must never adopt the BUYER subscription into
// the seller columns.
//
// Buyer and seller subscriptions ride the SAME Stripe customer. The resync's
// fallback listed that customer's subscriptions with no product filter, so for
// a buyer-only account — or a seller whose own subscription had lapsed — it
// returned the buyer subscription and wrote its id into
// `flipdesk_subscription_id`, its status into `subscription_status`, and
// `mapSubscriptionToFlipdeskPlan(buyerSub) ?? "free"` into `flipdesk_plan`.
//
// The second-order damage is what makes this urgent rather than untidy:
// POST /users/:id/change-plan acts on `flipdesk_subscription_id`, so support
// changing that person's FlipDesk plan afterwards would push a FlipDesk price
// onto their Guard or Connoisseur subscription. A real charge, on the wrong
// product, started by someone trying to help.
//
// Source-scanned: the resync mixes Stripe + service-role writes and cannot be
// invoked in isolation, and the property under test is which candidates the
// picker is allowed to see.

import { assert } from "@std/assert";
import { code, fnBody } from "./_source-scan.ts";

const ADMIN_BILLING = code(
  await Deno.readTextFile(new URL("../routes/admin-billing.ts", import.meta.url)),
);

Deno.test("US-2457 AC5: the picker only ever considers SELLER subscriptions", () => {
  const body = fnBody(ADMIN_BILLING, "function pickRelevantSubscription");
  assert(
    /subs\.filter\(\(s\) => !subscriptionIsBuyer\(s\)\)/.test(body),
    "the candidate list must exclude buyer subscriptions BEFORE the live/newest " +
      "pick — both products share one Stripe customer",
  );
  // Every subsequent read must be off the filtered list, or the filter is
  // decoration: picking `live` from `subs` and falling back to `sellerSubs`
  // (or the reverse) would still return a buyer subscription half the time.
  for (const stray of ["subs.find(", "[...subs]"]) {
    assert(
      !body.includes(stray),
      `pickRelevantSubscription still reads the UNFILTERED list via ${stray}`,
    );
  }
});

Deno.test("US-2457 AC5: an all-buyer customer yields no seller subscription", () => {
  // Returning null is the correct answer, not a degraded one: the caller then
  // records "no seller subscription", which is true. Borrowing the other
  // product's is what created the defect.
  const body = fnBody(ADMIN_BILLING, "function pickRelevantSubscription");
  assert(
    /if \(sellerSubs\.length === 0\) return null;/.test(body),
    "with no seller subscription the picker must return null rather than fall " +
      "back to the unfiltered list",
  );
});

Deno.test("US-2457 AC5: a stored id that already points at the buyer sub is not compounded", () => {
  // The repair half. An earlier unfiltered resync could already have written a
  // buyer subscription id into flipdesk_subscription_id; retrieving it and
  // resyncing from it would keep the corruption alive forever, because the
  // retrieve path short-circuits the customer lookup.
  const resync = ADMIN_BILLING.slice(
    ADMIN_BILLING.indexOf('adminBillingRoutes.post("/billing/reconciliation/users/:id/resync"'),
  );
  const lookup = resync.slice(0, resync.indexOf("// Compute the cached state"));
  assert(
    /if \(sub && subscriptionIsBuyer\(sub\)\) sub = null;/.test(lookup),
    "a retrieved buyer subscription must be discarded so the run falls through " +
      "to the (now filtered) customer lookup and CORRECTS the row",
  );
  const idxRetrieve = lookup.indexOf("subscriptions.retrieve(");
  const idxGuard = lookup.indexOf("subscriptionIsBuyer(sub)");
  const idxList = lookup.indexOf("subscriptions.list(");
  assert(idxGuard > idxRetrieve, "the guard must follow the retrieve");
  assert(idxList > idxGuard, "and precede the fallback list, or it cannot correct anything");
});

Deno.test("US-2457 AC5: the resync writes SELLER columns only", () => {
  // Guards the blast radius rather than the selection. If this ever starts
  // writing buyer_* columns, the two products stop being independent and every
  // argument above changes.
  const resync = ADMIN_BILLING.slice(
    ADMIN_BILLING.indexOf('adminBillingRoutes.post("/billing/reconciliation/users/:id/resync"'),
  );
  const update = resync.slice(resync.indexOf('.from("users")'), resync.indexOf('.eq("id", user.id)'));
  for (const buyerColumn of [
    "buyer_plan",
    "buyer_subscription_id",
    "buyer_subscription_status",
    "buyer_period_end",
  ]) {
    assert(
      !update.includes(buyerColumn),
      `the seller resync writes ${buyerColumn}. Buyer state is owned by ` +
        "customer.subscription.updated, and this route has no buyer reconciliation " +
        "behind it (US-2457 AC4).",
    );
  }
});

// ── The other end of the same false flag (US-2457) ──────────────────────────

const RECON_JOB = code(
  await Deno.readTextFile(
    new URL("../routes/jobs-billing-reconciliation.ts", import.meta.url),
  ),
);

Deno.test("US-2457: the Stripe sweep does not map a buyer subscription onto the seller", () => {
  // The map built here is keyed by CUSTOMER and compared against the SELLER
  // cached columns — and both products share one customer. Without the filter,
  // an account with an active Guard plan and a canceled FlipDesk one produces a
  // `stripe_divergence` flag claiming Stripe thinks they are active. That flag's
  // remedy is the resync above, so the two defects fed each other: a false flag
  // pointing at a button that adopted the buyer subscription.
  const body = fnBody(RECON_JOB, "async function fetchStripeSubscriptions");
  const idxFilter = body.indexOf("subscriptionIsBuyer(sub)");
  const idxSet = body.indexOf("byCustomer.set(");
  assert(idxFilter > -1, "the Stripe sweep must exclude buyer subscriptions");
  assert(idxFilter < idxSet, "the filter must precede the map write");
  assert(
    /if \(subscriptionIsBuyer\(sub\)\) continue;/.test(body),
    "skip the buyer subscription outright — keeping it under a different key " +
      "would still leave it available to a seller comparison",
  );
});

Deno.test("US-2457: the sweep still keeps CANCELED seller subscriptions", () => {
  // The filter must not become a general tidy-up. `status: "all"` is
  // load-bearing: "Stripe says canceled while we say active" is the most
  // expensive divergence there is — a customer served a paid plan for free —
  // and filtering it out would hide exactly what this fetch exists to find.
  const body = fnBody(RECON_JOB, "async function fetchStripeSubscriptions");
  assert(/status: "all"/.test(body), "the sweep must still list canceled subscriptions");
  assert(
    /existing\.status === "canceled" && sub\.status !== "canceled"/.test(body),
    "the prefer-live-over-canceled rule must survive the filter",
  );
});
