// US-2456: a buyer must not be billed twice for the same entitlement.
//
// US-807 and US-2126 built double-billing precedence across all three
// processors. Every guard reads the SELLER column family — billing_source,
// subscription_status, flipdesk_subscription_id — and they are wired into
// /flipdesk/subscribe, /flipdesk/cancel and /flipdesk/downgrade.
// POST /buyer/subscribe had NONE. So a buyer holding a live App Store or Google
// Play subscription could start a Stripe one on top and be charged twice, on
// two cards, for the same thing. Apple's half is not refundable from here.
//
// The reverse direction WAS covered — hand-rolled inline in routes/appstore.ts,
// twice, both copies omitting past_due — and that is exactly why nobody noticed
// the other half was missing: the rule lived in the file that happened to need
// it rather than in the module that owns it.

import { assert, assertEquals } from "@std/assert";
import {
  buyerEntitlingProcessor,
  buyerMobileSubscriptionBlocksStripe,
  buyerStripeSubscriptionBlocksMobile,
} from "../lib/appstore/precedence.ts";
import { code } from "./_source-scan.ts";

/**
 * One route handler's source: from its registration to the next one.
 *
 * NOT fnBody(). That walks the parameter parens of a function DECLARATION, and
 * `paymentRoutes.post("/x", async (c) => {` is a call whose parens close after
 * the whole handler — so the brace it finds is the one after the route, and the
 * slice is empty. Different shape, different slicer.
 */
function route(src: string, path: string): string {
  const at = src.indexOf(`paymentRoutes.post("${path}"`);
  if (at === -1) throw new Error(`route ${path} not found — renamed?`);
  const next = src.indexOf("paymentRoutes.post(", at + 20);
  return src.slice(at, next === -1 ? src.length : next);
}

const PAYMENTS = code(
  await Deno.readTextFile(new URL("../routes/payments.ts", import.meta.url)),
);
const APPSTORE = code(
  await Deno.readTextFile(new URL("../routes/appstore.ts", import.meta.url)),
);

Deno.test("US-2456: a live mobile buyer subscription blocks a Stripe one", () => {
  for (const source of ["appstore", "googleplay"] as const) {
    for (const status of ["active", "trialing", "past_due"]) {
      assertEquals(
        buyerMobileSubscriptionBlocksStripe({
          buyer_billing_source: source,
          buyer_subscription_status: status,
        }),
        source,
        `${source}/${status} must block`,
      );
    }
  }
});

Deno.test("US-2456: past_due is entitling — a retried card is still a subscription", () => {
  // The inline copies in routes/appstore.ts omitted it, so a buyer whose Stripe
  // card was failing could stack an Apple subscription and be charged by both.
  // The seller guard has always counted past_due (STRIPE_ENTITLING_STATUSES).
  assert(
    buyerStripeSubscriptionBlocksMobile({
      buyer_billing_source: "stripe",
      buyer_subscription_status: "past_due",
    }),
  );
});

Deno.test("US-2456: a lapsed or absent buyer subscription blocks nothing", () => {
  for (const status of ["canceled", "none", "paused", "", undefined]) {
    assertEquals(
      buyerEntitlingProcessor({
        buyer_billing_source: "appstore",
        buyer_subscription_status: status ?? null,
      }),
      null,
      `status ${String(status)} must not entitle`,
    );
  }
  assertEquals(buyerEntitlingProcessor({}), null);
  assertEquals(
    buyerEntitlingProcessor({
      buyer_billing_source: "somethingelse",
      buyer_subscription_status: "active",
    }),
    null,
    "an unknown processor is not an entitlement",
  );
});

Deno.test("US-2456: the buyer guard reads the BUYER columns, never the seller's", () => {
  // THE FAILURE THAT CAUSED THIS STORY. A helper that reads the wrong column
  // family answers confidently about the wrong subscription — and the answer
  // looks right in every test written with a one-product fixture.
  const sellerOnly = {
    billing_source: "appstore",
    subscription_status: "active",
    flipdesk_subscription_id: "sub_123",
  } as Record<string, string>;
  assertEquals(buyerMobileSubscriptionBlocksStripe(sellerOnly), null);
  assertEquals(buyerStripeSubscriptionBlocksMobile(sellerOnly), false);
});

Deno.test("US-2456 AC1: /buyer/subscribe refuses before it charges", () => {
  const body = route(PAYMENTS, "/buyer/subscribe");
  const idxGuard = body.indexOf("buyerMobileSubscriptionBlocksStripe(");
  const idxCheckout = body.indexOf("checkout.sessions.create");
  const idxUpdate = body.indexOf("subscriptions.update(");
  assert(idxGuard > -1, "the buyer subscribe path has no precedence guard");
  assert(idxCheckout > -1 || idxUpdate > -1, "no purchase found — restructured?");
  for (const [label, idx] of [["checkout", idxCheckout], ["in-place update", idxUpdate]] as const) {
    if (idx > -1) {
      assert(idxGuard < idx, `the guard must precede the ${label}`);
    }
  }
  assert(
    /ACTIVE_APPSTORE_SUBSCRIPTION/.test(body) && /ACTIVE_GOOGLEPLAY_SUBSCRIPTION/.test(body),
    "the refusal must name WHICH store, or the customer cannot be told where to " +
      "go — Apple and Google only let them cancel where they bought it",
  );
  assert(
    !/subscriptions\.cancel|cancel_at_period_end: true/.test(
      body.slice(idxGuard, idxGuard + 800),
    ),
    "never auto-cancel the other processor; 409 and steer, as the seller path does",
  );
});

Deno.test("US-2456 AC4: EVERY subscription purchase is gated — discovered, not listed", () => {
  // The guard that would have caught this. The per-route checks above cover the
  // routes this file knows about; this one finds them in the source, so a
  // fourth purchase path cannot ship ungated because nobody remembered to
  // extend a list.
  const PRECEDENCE = [
    "appstoreSubscriptionBlocksStripe(",
    "googleplaySubscriptionActive(",
    "buyerMobileSubscriptionBlocksStripe(",
    "decideAppstorePrecedence(",
  ];
  const sites: number[] = [];
  const re = /mode: "subscription"/g;
  for (let m = re.exec(PAYMENTS); m; m = re.exec(PAYMENTS)) sites.push(m.index);
  assert(
    sites.length >= 3,
    `expected the known subscription checkouts, found ${sites.length} — the scan ` +
      "has probably stopped working rather than the routes having been deleted",
  );

  for (const at of sites) {
    const handlerStart = PAYMENTS.lastIndexOf("paymentRoutes.post(", at);
    assert(handlerStart > -1, "a subscription checkout outside any route handler");
    const route = PAYMENTS.slice(
      handlerStart,
      PAYMENTS.indexOf('"', handlerStart + 20) + 1,
    );
    const handler = PAYMENTS.slice(handlerStart, at);
    assert(
      PRECEDENCE.some((p) => handler.includes(p)),
      `${route}: creates a subscription with no double-billing precedence guard ` +
        "before it. A customer already subscribed through another processor would " +
        "be charged twice, and an Apple or Google charge cannot be refunded from here.",
    );
  }
});

Deno.test("US-2456: the App Store buyer checks go through the shared rule", () => {
  // Two hand-rolled copies lived here, both omitting past_due. A rule that
  // lives in the file that needed it is a rule the next file will re-derive
  // slightly differently.
  const uses = [...APPSTORE.matchAll(/buyerStripeSubscriptionBlocksMobile\(/g)];
  assertEquals(uses.length, 2, "both the lapse guard and the verify guard must use it");
  assert(
    !/buyer_billing_source === "stripe"/.test(APPSTORE),
    "an inline copy of the buyer precedence rule is back in routes/appstore.ts",
  );
  // And the verify branch must still refuse before it grants.
  const branch = APPSTORE.slice(APPSTORE.indexOf('if (mapping.kind === "buyer_subscription")'));
  const idxGuard = branch.indexOf("buyerStripeSubscriptionBlocksMobile(");
  const idxApply = branch.indexOf("applyBuyerSubscription(");
  assert(idxGuard > -1 && idxApply > idxGuard, "the guard must precede the grant");
});
