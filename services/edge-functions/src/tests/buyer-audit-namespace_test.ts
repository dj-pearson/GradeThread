// US-2457: a buyer audit row must not be readable as a seller signal.
//
// `flipdesk_subscription_events` holds rows for BOTH products. App Store and
// Play rows have always been namespaced (`appstore.`, `googleplay.`); the buyer
// rows added on 2026-08-10 carried the RAW Stripe event type, so a buyer's
// cancellation was byte-identical to a seller's in the only columns
// `reconciliation_candidates` returns.
//
// That query is DISTINCT ON (user_id) with no product filter, so the newest row
// wins whichever product it belongs to. `deriveExpectedState` then maps
// `customer.subscription.deleted` → {canceled, free} and
// `invoice.payment_failed` → {past_due, …}, and `detectDivergence` compares
// that against the SELLER columns. A seller in good standing who cancelled
// their buyer plan would be flagged; a buyer whose card failed would put that
// seller in the operator dunning queue.
//
// And the remedy for such a flag is a resync that can write the BUYER
// subscription id into `flipdesk_subscription_id`. So a false flag here is not
// noise — it is a loaded destructive action.

import { assert, assertEquals } from "@std/assert";
import {
  BUYER_EVENT_PREFIX,
  buyerEventType,
  detectDivergence,
  isBuyerProductEvent,
} from "../lib/billing-reconciliation.ts";
import { code } from "./_source-scan.ts";

const WEBHOOKS = code(
  await Deno.readTextFile(new URL("../routes/webhooks.ts", import.meta.url)),
);
const PAYMENTS = code(
  await Deno.readTextFile(new URL("../routes/payments.ts", import.meta.url)),
);

Deno.test("US-2457: a buyer event never diverges the seller subscription", () => {
  // The four derivations that were actively harmful, each against a healthy
  // seller. Before the namespace, every one of these flagged.
  const healthySeller = { status: "active", plan: "pro" };
  for (const raw of [
    "customer.subscription.deleted",
    "invoice.payment_failed",
    "invoice.payment_succeeded",
    "invoice.upcoming",
  ]) {
    const result = detectDivergence(healthySeller, {
      eventType: buyerEventType(raw),
      toPlan: "free",
      rawStatus: null,
    });
    assertEquals(
      result.diverged,
      false,
      `${raw} on the BUYER product must say nothing about the seller's`,
    );
    assertEquals(result.reasons, []);
    // And it must not invent an expectation either — there is no buyer column
    // in CachedSubscriptionState to have compared against.
    assertEquals(result.expected, { status: null, plan: null });
  }
});

Deno.test("US-2457: the same events on the SELLER product still diverge", () => {
  // The other half. A skip that swallowed real seller signals would be a much
  // more expensive fix than the flag it prevented.
  const healthySeller = { status: "active", plan: "pro" };
  const result = detectDivergence(healthySeller, {
    eventType: "customer.subscription.deleted",
    toPlan: "free",
    rawStatus: null,
  });
  assert(result.diverged, "a real seller cancellation must still flag");
  assert(result.statusDiverged);
});

Deno.test("US-2457: the namespace helpers agree with each other", () => {
  assert(isBuyerProductEvent(buyerEventType("customer.subscription.deleted")));
  assert(!isBuyerProductEvent("customer.subscription.deleted"));
  assert(!isBuyerProductEvent("appstore.verify"));
  assert(buyerEventType("x").startsWith(BUYER_EVENT_PREFIX));
});

Deno.test("US-2457 AC3: every buyer audit write is namespaced — discovered, not listed", () => {
  // Derived so a NEW buyer audit row cannot ship raw. Each buyer-only helper is
  // sliced and required to namespace the event type it records.
  const BUYER_WRITERS = [
    { file: "webhooks.ts", src: WEBHOOKS, fn: "async function sendBuyerRenewalReceipt" },
    { file: "webhooks.ts", src: WEBHOOKS, fn: "async function sendBuyerBillingProblem" },
  ];
  for (const w of BUYER_WRITERS) {
    const at = w.src.indexOf(w.fn);
    assert(at > -1, `${w.file}: ${w.fn} not found — renamed?`);
    const next = w.src.indexOf("\nasync function ", at + 10);
    const body = w.src.slice(at, next === -1 ? w.src.length : next);
    assert(
      body.includes("recordEvent("),
      `${w.fn} no longer records an audit row — if that is deliberate, this ` +
        "entry should go with it",
    );
    assert(
      body.includes("buyerEventType("),
      `${w.fn} records a raw event type. A buyer row that looks like a seller ` +
        "row is read as one by reconciliation_candidates, which has no product " +
        "filter — see BUYER_EVENT_PREFIX.",
    );
  }

  // The two branch-level writes (buyer deletion, buyer consent artifact).
  const deletion = WEBHOOKS.slice(WEBHOOKS.indexOf("async function handleSubscriptionDeleted"));
  const buyerBranch = deletion.slice(
    deletion.indexOf("if (subscriptionIsBuyer(sub)) {"),
    deletion.indexOf('buyer_plan: "free"'),
  );
  assert(
    buyerBranch.includes("buyerEventType("),
    "the buyer cancellation audit row must be namespaced — un-namespaced it " +
      "derives to {canceled, free} against the seller's live state",
  );
  assert(
    /event_type: buyerEventType\("in_place_change_confirmed"\)/.test(PAYMENTS),
    "the buyer consent artifact must be namespaced too — benign for divergence, " +
      "but it still DISPLACES the seller's genuine latest event in a " +
      "distinct-on-user query and silently stops reconciling them",
  );
});

Deno.test("US-2457: no buyer write site records a bare event.type", () => {
  // The shape a new one would take. Each buyer helper must pass the namespaced
  // value, and the shared handler must branch rather than record raw.
  const upcoming = WEBHOOKS.slice(WEBHOOKS.indexOf("async function handleInvoiceUpcoming"));
  const body = upcoming.slice(0, upcoming.indexOf("\n}"));
  assert(
    /isBuyer \? buyerEventType\(event\.type\) : event\.type/.test(body),
    "handleInvoiceUpcoming serves both products from one recordEvent call, so it " +
      "must namespace conditionally rather than record whichever type arrived",
  );
});
