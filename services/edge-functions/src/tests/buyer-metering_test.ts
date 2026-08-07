// US-1800 + US-1813: buyer metered-action reserve/refund contract with the
// reward-credit fallback leg. Deps injected so this runs without a DB.
import { assertEquals, assertRejects } from "@std/assert";

Deno.env.set("SUPABASE_URL", "https://example.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "dummy");

const {
  withBuyerMeter,
  BuyerQuotaExhaustedError,
  BUYER_METER_ALLOWANCE,
  debitBuyerMeter,
  refundBuyerMeterSource,
} = await import("../lib/buyer-metering.ts");

// All four deps with safe no-op defaults; override the leg under test.
function deps(over: Partial<{
  reserve: () => Promise<boolean>;
  refund: (o: string, m: string) => Promise<void>;
  redeemReward: () => Promise<boolean>;
  refundReward: (o: string, m: string) => Promise<void>;
}> = {}) {
  return {
    reserve: over.reserve ?? (() => Promise.resolve(true)),
    refund: over.refund ?? (() => Promise.resolve()),
    // Default OFF so cap tests fall through to the throw unless told otherwise.
    redeemReward: over.redeemReward ?? (() => Promise.resolve(false)),
    refundReward: over.refundReward ?? (() => Promise.resolve()),
  } as Parameters<typeof withBuyerMeter>[4];
}

Deno.test("withBuyerMeter: runs the action when the monthly allowance reserves", async () => {
  let refunded = 0;
  let redeemed = 0;
  const out = await withBuyerMeter("u1", "extension_checks", 10, () => Promise.resolve("ok"), deps({
    reserve: () => Promise.resolve(true),
    refund: () => { refunded++; return Promise.resolve(); },
    redeemReward: () => { redeemed++; return Promise.resolve(true); },
  }));
  assertEquals(out, "ok");
  assertEquals(refunded, 0);
  // Reward credits are NOT touched when the monthly allowance covered it.
  assertEquals(redeemed, 0);
});

Deno.test("withBuyerMeter: at the cap, redeems a reward credit and runs", async () => {
  let ran = 0, redeemed = 0;
  const out = await withBuyerMeter("u1", "authenticity_credits", 0, () => { ran++; return Promise.resolve("x"); }, deps({
    reserve: () => Promise.resolve(false),
    redeemReward: () => { redeemed++; return Promise.resolve(true); },
  }));
  assertEquals(out, "x");
  assertEquals(ran, 1);
  assertEquals(redeemed, 1);
});

Deno.test("withBuyerMeter: throws when both the allowance AND reward credits are exhausted", async () => {
  let ran = 0, refunded = 0, refundedReward = 0;
  await assertRejects(
    () =>
      withBuyerMeter("u1", "authenticity_credits", 3, () => { ran++; return Promise.resolve("x"); }, deps({
        reserve: () => Promise.resolve(false),
        redeemReward: () => Promise.resolve(false),
        refund: () => { refunded++; return Promise.resolve(); },
        refundReward: () => { refundedReward++; return Promise.resolve(); },
      })),
    BuyerQuotaExhaustedError,
  );
  assertEquals(ran, 0);
  assertEquals(refunded, 0);
  assertEquals(refundedReward, 0);
});

Deno.test("withBuyerMeter: a monthly-reserved failure refunds the monthly counter, not a reward credit", async () => {
  let refunded: string | null = null;
  let refundedReward = 0;
  await assertRejects(
    () =>
      withBuyerMeter("u1", "video_grades", 2, () => Promise.reject(new Error("boom")), deps({
        reserve: () => Promise.resolve(true),
        refund: (_o, meter) => { refunded = meter; return Promise.resolve(); },
        refundReward: () => { refundedReward++; return Promise.resolve(); },
      })),
    Error,
    "boom",
  );
  assertEquals(refunded, "video_grades");
  assertEquals(refundedReward, 0);
});

Deno.test("withBuyerMeter: a reward-paid failure refunds the reward credit, not the monthly counter", async () => {
  let refunded = 0;
  let refundedReward: string | null = null;
  await assertRejects(
    () =>
      withBuyerMeter("u1", "video_grades", 0, () => Promise.reject(new Error("boom")), deps({
        reserve: () => Promise.resolve(false),
        redeemReward: () => Promise.resolve(true),
        refund: () => { refunded++; return Promise.resolve(); },
        refundReward: (_o, meter) => { refundedReward = meter; return Promise.resolve(); },
      })),
    Error,
    "boom",
  );
  assertEquals(refundedReward, "video_grades");
  assertEquals(refunded, 0);
});

Deno.test("BUYER_METER_ALLOWANCE maps each meter to its allowance cap key", () => {
  assertEquals(BUYER_METER_ALLOWANCE.extension_checks, "extensionChecksPerMonth");
  assertEquals(BUYER_METER_ALLOWANCE.authenticity_credits, "authenticityCreditsPerMonth");
  assertEquals(BUYER_METER_ALLOWANCE.video_grades, "videoGradeCreditsPerMonth");
});

// ── US-1841: the precedence, used directly ───────────────────────────────────
//
// A buyer video grade pays at the gate and the work it bought finishes in a
// background pipeline minutes later, so it cannot sit inside withBuyerMeter's
// try/finally. It calls the same two halves instead — which is only safe if
// those halves ARE the precedence, not a second copy of it.

Deno.test("debitBuyerMeter: reports which pocket paid, allowance first", async () => {
  assertEquals(
    await debitBuyerMeter("u1", "video_grades", 2, deps({ reserve: () => Promise.resolve(true) })),
    "allowance",
  );
  // At the cap it falls through to a reward credit — and SAYS so, because the
  // refund has to know. Recording "paid" without recording "from where" is how a
  // refund launders an allowance into a permanent credit.
  assertEquals(
    await debitBuyerMeter("u1", "video_grades", 0, deps({
      reserve: () => Promise.resolve(false),
      redeemReward: () => Promise.resolve(true),
    })),
    "reward",
  );
});

Deno.test("debitBuyerMeter: returns null when neither pocket can pay", async () => {
  // Null, not a throw: the caller (the grade route) answers with its own 402
  // carrying the upgrade action, rather than catching an exception to build one.
  assertEquals(
    await debitBuyerMeter("u1", "video_grades", 0, deps({
      reserve: () => Promise.resolve(false),
      redeemReward: () => Promise.resolve(false),
    })),
    null,
  );
});

Deno.test("debitBuyerMeter: never redeems a reward credit when the allowance covered it", async () => {
  let redeemed = 0;
  await debitBuyerMeter("u1", "video_grades", 5, deps({
    reserve: () => Promise.resolve(true),
    redeemReward: () => { redeemed++; return Promise.resolve(true); },
  }));
  assertEquals(redeemed, 0);
});

Deno.test("refundBuyerMeterSource: returns the unit to the pocket that paid, never the other", async () => {
  let toCounter = 0, toReward = 0;
  const d = deps({
    refund: () => { toCounter++; return Promise.resolve(); },
    refundReward: () => { toReward++; return Promise.resolve(); },
  });
  await refundBuyerMeterSource("u1", "video_grades", "allowance", d);
  assertEquals([toCounter, toReward], [1, 0]);
  await refundBuyerMeterSource("u1", "video_grades", "reward", d);
  assertEquals([toCounter, toReward], [1, 1]);
});
