// US-2118 — an in-place plan upgrade charges a prorated amount immediately, so
// the mutation MUST NOT fire before the client has disclosed the amount and
// captured consent (confirmUpgrade). A new subscription passes through Stripe
// Checkout's price disclosure; this path had none — the click WAS the purchase.
//
// Asserted against the payments.ts source (the route mixes Stripe + service-role
// calls that are impractical to invoke in isolation, so this repo guards such
// logic structurally — same approach as subscription-ack-disclosure_test.ts).
// A refactor that DROPS the gate, or reorders it AFTER the mutation, fails here.
//
// ⚠ THIS FILE USED TO NAME ONE ROUTE, AND THAT IS HOW THE SECOND ONE STAYED
// BARE FOR MONTHS. The gate shipped on /flipdesk/subscribe in July 2026 and
// these tests pinned it by name; /buyer/subscribe has an identical in-place
// branch and never got one, so a Guard subscriber clicking Connoisseur was
// still charged on a single click with no interstitial. Every assertion here is
// now driven off PRODUCTS, and the last test in the file discovers prorating
// mutations from the source rather than from this list — so a THIRD subscription
// product cannot repeat it.
import { assert, assertEquals } from "@std/assert";

const src = Deno.readTextFileSync(
  new URL("../routes/payments.ts", import.meta.url),
);

interface Product {
  /** For test names. */
  label: string;
  /** The subscription-id column the in-place branch keys on. */
  subIdColumn: string;
  /** The route that follows the in-place block, used to bound the slice. */
  blockEndsAt: string;
  previewRoute: string;
}

const PRODUCTS: Product[] = [
  {
    label: "flipdesk",
    subIdColumn: "flipdesk_subscription_id",
    blockEndsAt: 'paymentRoutes.post("/flipdesk/upgrade-preview"',
    previewRoute: '/flipdesk/upgrade-preview',
  },
  {
    label: "buyer",
    subIdColumn: "buyer_subscription_id",
    blockEndsAt: 'paymentRoutes.post("/buyer/upgrade-preview"',
    previewRoute: '/buyer/upgrade-preview',
  },
];

// Isolate one product's in-place upgrade block: from its "already has a
// subscription" guard to the end of that handler, so an index compare can't
// accidentally match the same tokens in an unrelated route.
function inPlaceBlock(p: Product): string {
  const start = src.indexOf(`if (user.${p.subIdColumn}`);
  assert(start > -1, `${p.label}: in-place upgrade guard not found — renamed?`);
  const end = src.indexOf(p.blockEndsAt, start);
  assert(end > -1, `${p.label}: ${p.blockEndsAt} not found after the in-place block`);
  return src.slice(start, end);
}

for (const p of PRODUCTS) {
  Deno.test(`US-2118 AC4 (${p.label}): the confirmation gate precedes subscriptions.update`, () => {
    const block = inPlaceBlock(p);
    const idxGate = block.indexOf("UPGRADE_CONFIRMATION_REQUIRED");
    const idxUpdate = block.indexOf(`subscriptions.update(user.${p.subIdColumn}`);
    assert(idxGate > -1, `${p.label}: the confirmUpgrade gate (UPGRADE_CONFIRMATION_REQUIRED) is missing`);
    assert(idxUpdate > -1, `${p.label}: the in-place subscriptions.update call is missing`);
    assert(
      idxGate < idxUpdate,
      `${p.label}: the confirmation gate must come BEFORE the mutation — otherwise ` +
        "the click still charges before the user has confirmed",
    );
  });

  Deno.test(`US-2118 AC4 (${p.label}): the gate keys on confirmUpgrade from the request body`, () => {
    const block = inPlaceBlock(p);
    assert(
      /if \(!confirmUpgrade\)/.test(block),
      `${p.label}: the mutation must be gated on !confirmUpgrade so the default ` +
        "(unconfirmed) click returns requiresConfirmation instead of charging",
    );
    assert(
      /requiresConfirmation:\s*true/.test(block),
      `${p.label}: the gated response must carry requiresConfirmation:true for the client`,
    );
  });

  Deno.test(`US-2118 AC1 (${p.label}): a proration preview endpoint exists for the disclosure`, () => {
    assert(
      src.includes(`paymentRoutes.post("${p.previewRoute}"`),
      `${p.previewRoute} (amount today, new recurring, next renewal) must exist ` +
        "so the dialog can disclose real numbers",
    );
  });

  Deno.test(`US-2118 AC2 (${p.label}): a consent artifact is recorded on a confirmed change`, () => {
    const block = inPlaceBlock(p);
    assert(
      block.includes("flipdesk_subscription_events") &&
        block.includes("in_place_change_confirmed"),
      `${p.label}: the confirmed in-place change must write a consent artifact ` +
        "(the equivalent of Checkout's disclosure)",
    );
  });
}

Deno.test("US-2118 AC4: confirmUpgrade is derived from the request body, once per product", () => {
  // ⚠ THE DERIVATION, NOT JUST THE USE. Found by mutation on 2026-08-09:
  // replacing the definition with `const confirmUpgrade = true` left this whole
  // file GREEN while every unconfirmed click charged again. The per-product
  // assertions above only prove the gate READS a variable — they say nothing
  // about where its value comes from, and each definition sits ABOVE its
  // block slice's start marker, so the slice never sees the change.
  //
  // That is the worst shape a compliance guard can have: it keeps passing over
  // a gate that no longer gates.
  const derivations = src.match(
    /const confirmUpgrade\s*=\s*\(\s*body[^;]*confirmUpgrade[^;]*===\s*true/g,
  ) ?? [];
  assertEquals(
    derivations.length,
    PRODUCTS.length,
    "each in-place upgrade path must DERIVE confirmUpgrade from its own request " +
      "body — a constant, or a value from anywhere else, makes the gate vacuous " +
      "while this file stays green",
  );
  assert(
    !/const confirmUpgrade\s*=\s*(true|false)\s*;/.test(src),
    "confirmUpgrade must never be a literal: the client's consent is the only " +
      "thing that may open this gate",
  );
});

Deno.test("US-2118 AC1: each preview simulates the real item swap", () => {
  // The static plan-table price is not the prorated figure. A dialog that shows
  // it would state a WRONG amount, which is worse than today's silence: it
  // converts an omission into an affirmative misstatement about a charge.
  const previews = src.match(/subscription_proration_behavior:\s*"create_prorations"/g) ?? [];
  assertEquals(
    previews.length,
    PRODUCTS.length,
    "every upgrade-preview route must call retrieveUpcoming with " +
      "subscription_items + subscription_proration_behavior so amount_due is the " +
      "real proration",
  );
  assert(src.includes("retrieveUpcoming"));
});

Deno.test("US-2118 AC4: EVERY prorating subscription mutation is gated — discovered, not listed", () => {
  // THE GUARD THAT WOULD HAVE CAUGHT THE BUYER PATH. The tests above check the
  // products this file knows about; this one finds them in the source instead,
  // so a third subscription product added tomorrow cannot ship an ungated
  // click-to-charge just because nobody remembered to extend PRODUCTS.
  //
  // Every stripe.subscriptions.update that creates prorations charges money
  // immediately. Each one must have a confirmation gate between the start of
  // its handler and the call.
  const calls: number[] = [];
  const re = /await stripe\.subscriptions\.update\(/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    // Only the prorating ones: a proration_behavior of "none" (a scheduled
    // downgrade) takes no money today and needs no interstitial.
    const tail = src.slice(m.index, m.index + 900);
    if (tail.includes('proration_behavior: "create_prorations"')) calls.push(m.index);
  }
  assert(
    calls.length >= PRODUCTS.length,
    `expected at least ${PRODUCTS.length} prorating subscription updates, found ` +
      `${calls.length} — if the in-place upgrade paths were rewritten, this guard ` +
      "needs rewriting with them rather than deleting",
  );

  for (const at of calls) {
    // Look back to the nearest route registration: that is the start of the
    // handler this call lives in.
    const handlerStart = src.lastIndexOf("paymentRoutes.post(", at);
    assert(handlerStart > -1, "a prorating update outside any route handler");
    const handler = src.slice(handlerStart, at);
    const route = src.slice(handlerStart, src.indexOf('"', handlerStart + 20) + 1);
    assert(
      handler.includes("UPGRADE_CONFIRMATION_REQUIRED"),
      `${route}: this handler charges a prorated amount with no confirmation gate ` +
        "before the mutation. A single click is the purchase. Add the 409 " +
        "UPGRADE_CONFIRMATION_REQUIRED gate and a preview endpoint, the way " +
        "/flipdesk/subscribe and /buyer/subscribe do.",
    );
  }
});
