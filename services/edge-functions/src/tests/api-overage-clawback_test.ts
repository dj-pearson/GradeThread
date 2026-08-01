// US-2293 [P1]: refunding an API overage pack must take the credits back.
//
// `charge.refunded` dispatched on `per_grade` and `credit_pack` and logged
// everything else as "no DB change". But checkout.session.completed grants
// THREE products — the third, `api_overage`, had no matching arm on the refund
// path. So a refunded overage pack returned the money and left the credits in
// the wallet. Free credits, on request.
//
// It is a whole missing branch rather than a wrong number, which is why no
// existing test caught it: every test that ran was about a product this code
// path did handle.
//
// The clamp is the interesting half. API credits are spent as they are used, so
// a customer who bought 1,000, used 900 and then refunded can only give back
// the 100 they still hold. Revoking 1,000 would drive the wallet negative and
// bill them for calls they already paid for — turning a refund into a charge.

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { planApiOverageClawback } = await import("../routes/webhooks.ts");

Deno.test("US-2293: a full refund with credits untouched takes them all back", () => {
  assertEquals(
    planApiOverageClawback({ granted: 1000, refunded: 5000, total: 5000, balance: 1000 }),
    { revoke: 1000, shortfall: 0 },
  );
});

Deno.test("US-2293: grant then refund is a net-zero credit change", () => {
  // The story's own acceptance criterion, stated directly: whatever was granted
  // comes back out, provided it is still there.
  const granted = 250;
  const { revoke, shortfall } = planApiOverageClawback({
    granted,
    refunded: 2000,
    total: 2000,
    balance: granted,
  });
  assertEquals(granted - revoke, 0);
  assertEquals(shortfall, 0);
});

Deno.test("US-2293: the clawback is clamped to the CURRENT balance", () => {
  // Bought 1,000, used 900, refunded. Only 100 can come back. Taking 1,000
  // would put the wallet at -900 and bill them for calls already paid for.
  assertEquals(
    planApiOverageClawback({ granted: 1000, refunded: 5000, total: 5000, balance: 100 }),
    { revoke: 100, shortfall: 900 },
  );
});

Deno.test("US-2293: the shortfall is reported, not swallowed", () => {
  // A refund whose credits were entirely consumed is a real commercial event
  // (and a plausible abuse signal). A clawback that takes what it can and
  // reports success hides it.
  const r = planApiOverageClawback({
    granted: 1000,
    refunded: 5000,
    total: 5000,
    balance: 0,
  });
  assertEquals(r.revoke, 0);
  assertEquals(r.shortfall, 1000);
});

Deno.test("US-2293: a PARTIAL refund claws back proportionally", () => {
  // Half the money back, half the credits — the same rule the credit-pack path
  // uses (US-1919), so the two products behave consistently.
  assertEquals(
    planApiOverageClawback({ granted: 1000, refunded: 2500, total: 5000, balance: 1000 }),
    { revoke: 500, shortfall: 0 },
  );
  // …and the clamp still applies on top of it.
  assertEquals(
    planApiOverageClawback({ granted: 1000, refunded: 2500, total: 5000, balance: 200 }),
    { revoke: 200, shortfall: 300 },
  );
});

Deno.test("US-2293: a zero refund takes nothing", () => {
  assertEquals(
    planApiOverageClawback({ granted: 1000, refunded: 0, total: 5000, balance: 1000 }),
    { revoke: 0, shortfall: 0 },
  );
});

Deno.test("US-2293: a missing or nonsense balance fails SAFE at zero", () => {
  // Better to revoke nothing and log a shortfall than to hand NaN to a wallet
  // debit. Failing closed here costs us credits; failing open corrupts a
  // customer's balance.
  for (const balance of [Number.NaN, -50]) {
    const r = planApiOverageClawback({ granted: 1000, refunded: 5000, total: 5000, balance });
    assertEquals(r.revoke, 0);
    assertEquals(r.shortfall, 1000);
  }
});

Deno.test("US-2293: never revokes more than granted, or more than held", () => {
  // The two invariants, asserted across the grid rather than case by case.
  for (const granted of [1, 50, 1000]) {
    for (const refunded of [0, 1, 2500, 5000, 9999]) {
      for (const total of [0, 5000]) {
        for (const balance of [0, 10, 1000, 100000]) {
          const r = planApiOverageClawback({ granted, refunded, total, balance });
          assert(r.revoke >= 0 && r.revoke <= granted);
          assert(r.revoke <= Math.max(0, balance));
          assert(r.shortfall >= 0);
        }
      }
    }
  }
});

Deno.test("US-2293: the refund path dispatches on api_overage", () => {
  // A source assertion because the defect was a MISSING BRANCH — there is no
  // wrong value to catch, only an arm that was never written. It also pins the
  // separation that matters: overage credits live in api_credit_wallet (00415),
  // NOT the grading wallet, so routing them through revoke_grade_credits would
  // take credits the customer still paid for and leave the refunded ones.
  const src = Deno.readTextFileSync(
    new URL("../routes/webhooks.ts", import.meta.url),
  );
  assert(src.includes('product === "api_overage"'), "no api_overage arm on charge.refunded");
  assert(src.includes("clawbackApiOverage"));
  assert(src.includes("debit_api_credits"));
});
