// US-394: per-grade Checkout must be idempotent on (user, submission, tier) so a
// double-click or retry cannot create two payable sessions for one grade. The
// dedupe is enforced by passing this deterministic key to Stripe; here we pin
// that the key is stable for identical inputs and distinct across them.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { perGradeIdempotencyKey } from "../routes/payments.ts";

Deno.test("idempotency key is stable for the same (user, submission, tier)", () => {
  const a = perGradeIdempotencyKey("user_1", "sub_1", "standard");
  const b = perGradeIdempotencyKey("user_1", "sub_1", "standard");
  assertEquals(a, b, "concurrent identical requests must share one key (→ one session)");
});

Deno.test("idempotency key differs across user / submission / tier", () => {
  const base = perGradeIdempotencyKey("user_1", "sub_1", "standard");
  assert(base !== perGradeIdempotencyKey("user_2", "sub_1", "standard"));
  assert(base !== perGradeIdempotencyKey("user_1", "sub_2", "standard"));
  // A tier upgrade is a genuinely different purchase → different key/session.
  assert(base !== perGradeIdempotencyKey("user_1", "sub_1", "express"));
});
