// The legacy POST /api/payments/subscribe alias opened a Stripe subscription
// Checkout with no live-subscription guard and no idempotency key, so a seller
// who already paid could be sold a second, parallel subscription. Its sibling
// alias POST /checkout-session had no caller left either. Both were removed;
// this test reads the live Hono router so neither can quietly come back.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { paymentRoutes } from "../routes/payments.ts";

const paths = paymentRoutes.routes.map((r) => `${r.method} ${r.path}`);

Deno.test("payments router has no legacy /subscribe route", () => {
  assertEquals(
    paymentRoutes.routes.filter((r) => r.path === "/subscribe"),
    [],
    "POST /subscribe is back: it can open a second paid subscription",
  );
});

Deno.test("payments router has no legacy /checkout-session alias", () => {
  assertEquals(
    paymentRoutes.routes.filter((r) => r.path === "/checkout-session"),
    [],
  );
});

Deno.test("the guarded replacements are still registered", () => {
  // Proves the router was actually read, so the two empty checks above are
  // not passing against an empty route table.
  for (const p of [
    "POST /flipdesk/subscribe",
    "POST /buyer/subscribe",
    "POST /gradethread/per-grade",
  ]) {
    assert(paths.includes(p), `${p} missing from payments router`);
  }
});
