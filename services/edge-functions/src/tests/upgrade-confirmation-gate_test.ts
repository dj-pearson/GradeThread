// US-2118 — an in-place plan upgrade charges a prorated amount immediately, so
// the mutation MUST NOT fire before the client has disclosed the amount and
// captured consent (confirmUpgrade). A new subscription passes through Stripe
// Checkout's price disclosure; this path had none — the click WAS the purchase.
//
// Asserted against the payments.ts source (the route mixes Stripe + service-role
// calls that are impractical to invoke in isolation, so this repo guards such
// logic structurally — same approach as subscription-ack-disclosure_test.ts).
// A refactor that DROPS the gate, or reorders it AFTER the mutation, fails here.
import { assert } from "@std/assert";

const src = Deno.readTextFileSync(
  new URL("../routes/payments.ts", import.meta.url),
);

// Isolate the in-place upgrade block: from the "already has a subscription"
// guard to the end of the /flipdesk/subscribe handler's try, so an index compare
// can't accidentally match the same tokens in an unrelated route.
function inPlaceBlock(): string {
  const start = src.indexOf("if (user.flipdesk_subscription_id");
  assert(start > -1, "in-place upgrade guard not found — renamed?");
  const end = src.indexOf("paymentRoutes.post(\"/flipdesk/upgrade-preview\"", start);
  assert(end > -1, "upgrade-preview route not found after the in-place block");
  return src.slice(start, end);
}

Deno.test("US-2118 AC4: the confirmation gate precedes subscriptions.update", () => {
  const block = inPlaceBlock();
  const idxGate = block.indexOf("UPGRADE_CONFIRMATION_REQUIRED");
  const idxUpdate = block.indexOf("subscriptions.update(user.flipdesk_subscription_id");
  assert(idxGate > -1, "the confirmUpgrade gate (UPGRADE_CONFIRMATION_REQUIRED) is missing");
  assert(idxUpdate > -1, "the in-place subscriptions.update call is missing");
  assert(
    idxGate < idxUpdate,
    "the confirmation gate must come BEFORE the mutation — otherwise the click " +
      "still charges before the user has confirmed",
  );
});

Deno.test("US-2118 AC4: the gate keys on confirmUpgrade from the request body", () => {
  const block = inPlaceBlock();
  assert(
    /if \(!confirmUpgrade\)/.test(block),
    "the mutation must be gated on !confirmUpgrade so the default (unconfirmed) " +
      "click returns requiresConfirmation instead of charging",
  );
  assert(
    /requiresConfirmation:\s*true/.test(block),
    "the gated response must carry requiresConfirmation:true for the client",
  );

  // ⚠ AND THE DERIVATION, NOT JUST THE USE. Found by mutation on 2026-08-09:
  // replacing the definition with `const confirmUpgrade = true` left this whole
  // file GREEN while every unconfirmed click charged again. The two assertions
  // above only prove the gate READS a variable — they say nothing about where
  // its value comes from, and the definition sits ABOVE inPlaceBlock()'s start
  // so the block slice never saw the change.
  //
  // That is the worst shape a compliance guard can have: it keeps passing over
  // a gate that no longer gates. Pin the derivation to the request body.
  assert(
    /const confirmUpgrade\s*=\s*\(\s*body[^;]*confirmUpgrade[^;]*===\s*true/.test(src),
    "confirmUpgrade must be DERIVED from the request body — a constant, or a " +
      "value from anywhere else, makes the gate vacuous while this file stays green",
  );
  assert(
    !/const confirmUpgrade\s*=\s*(true|false)\s*;/.test(src),
    "confirmUpgrade must never be a literal: the client's consent is the only " +
      "thing that may open this gate",
  );
});

Deno.test("US-2118 AC1: a proration preview endpoint exists for the disclosure", () => {
  assert(
    src.includes('paymentRoutes.post("/flipdesk/upgrade-preview"'),
    "the /flipdesk/upgrade-preview endpoint (amount today, new recurring, next " +
      "renewal) must exist so the dialog can disclose real numbers",
  );
  assert(
    src.includes("retrieveUpcoming") && src.includes("subscription_items"),
    "the preview must simulate the item swap via retrieveUpcoming so amount_due " +
      "reflects the real proration, not the static plan-table price",
  );
});

Deno.test("US-2118 AC2: a consent artifact is recorded on a confirmed change", () => {
  const block = inPlaceBlock();
  assert(
    block.includes("flipdesk_subscription_events") &&
      block.includes("in_place_change_confirmed"),
    "the confirmed in-place change must write a consent artifact to " +
      "flipdesk_subscription_events (the equivalent of Checkout's disclosure)",
  );
});
