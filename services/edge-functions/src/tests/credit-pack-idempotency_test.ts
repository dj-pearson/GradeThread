// US-1469: credit-pack Checkout must absorb a double-submit / client retry into
// ONE payable session, while still allowing a deliberate later repurchase
// (packs are repeatable, unlike per-grade/subscribe). The dedupe is enforced by
// passing this deterministic, time-bucketed key to Stripe; here we pin that the
// key is stable within a bucket, distinct across users/packs, and rolls over to
// a fresh key in a later window.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  CREDIT_PACK_IDEMPOTENCY_WINDOW_MS,
  creditPackIdempotencyKey,
} from "../routes/payments.ts";

Deno.test("key is stable within the same time bucket (double-submit → one session)", () => {
  const t = 1_000_000_000_000;
  const a = creditPackIdempotencyKey("user_1", "25", t);
  const b = creditPackIdempotencyKey("user_1", "25", t + 500); // same bucket
  assertEquals(a, b, "rapid duplicate POSTs in one window must share one key");
});

Deno.test("key differs across user and pack size", () => {
  const t = 1_000_000_000_000;
  const base = creditPackIdempotencyKey("user_1", "25", t);
  assert(base !== creditPackIdempotencyKey("user_2", "25", t));
  assert(base !== creditPackIdempotencyKey("user_1", "50", t));
});

Deno.test("key rolls over in a later window (deliberate repurchase → new session)", () => {
  const t = 1_000_000_000_000;
  const base = creditPackIdempotencyKey("user_1", "25", t);
  const later = creditPackIdempotencyKey(
    "user_1",
    "25",
    t + CREDIT_PACK_IDEMPOTENCY_WINDOW_MS,
  );
  assert(
    base !== later,
    "a repurchase a full window later must get a distinct key/session",
  );
});
