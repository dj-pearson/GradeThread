// Unit tests for the pure grade-pricing math (US-207). These import only
// grade-pricing.ts — no supabase / Deno.env — so they run with no fixture:
//   deno test src/tests/grade-pricing_test.ts
// (or `deno task test` to run the whole suite).

import {
  assertEquals,
  assert,
} from "@std/assert";
import {
  computeBatchCredits,
  effectivePlanFor,
  INCLUDED_STANDARD_PER_MONTH,
  isGradeTier,
  suggestPack,
  TIER_CREDIT_COST,
  TIER_PRICE_CENTS,
  tierPriceDollars,
} from "../lib/grade-pricing.ts";

Deno.test("isGradeTier accepts only the three tiers", () => {
  assert(isGradeTier("standard"));
  assert(isGradeTier("premium"));
  assert(isGradeTier("express"));
  assert(!isGradeTier("deluxe"));
  assert(!isGradeTier(""));
  assert(!isGradeTier(undefined));
  assert(!isGradeTier(5));
});

Deno.test("tier prices match the published model ($2.99 / $7.99 / $12.99)", () => {
  assertEquals(TIER_PRICE_CENTS.standard, 299);
  assertEquals(TIER_PRICE_CENTS.premium, 799);
  assertEquals(TIER_PRICE_CENTS.express, 1299);
  assertEquals(tierPriceDollars("standard"), 2.99);
  assertEquals(tierPriceDollars("premium"), 7.99);
  assertEquals(tierPriceDollars("express"), 12.99);
});

Deno.test("credit costs are 1 / 3 / 5", () => {
  assertEquals(TIER_CREDIT_COST.standard, 1);
  assertEquals(TIER_CREDIT_COST.premium, 3);
  assertEquals(TIER_CREDIT_COST.express, 5);
});

Deno.test("effectivePlanFor drops paused subs to Free caps", () => {
  assertEquals(effectivePlanFor("pro", "active"), "pro");
  assertEquals(effectivePlanFor("business", null), "business");
  assertEquals(effectivePlanFor("pro", "paused"), "free");
});

Deno.test("effectivePlanFor caps an EXPIRED trial at Free (US-383)", () => {
  const now = new Date("2026-06-03T00:00:00Z");
  const past = new Date("2026-05-20T00:00:00Z").toISOString(); // trial lapsed
  const future = new Date("2026-06-10T00:00:00Z").toISOString(); // still trialing

  // Expired trial → Free, even before the downgrade job flips the row.
  assertEquals(effectivePlanFor("pro", "trialing", past, now), "free");
  // Live trial keeps its trial plan.
  assertEquals(effectivePlanFor("pro", "trialing", future, now), "pro");
  // A trial that converted to an active sub is unaffected by trial_ends_at.
  assertEquals(effectivePlanFor("pro", "active", past, now), "pro");
  // No trial_ends_at (legacy / non-trial) → unchanged.
  assertEquals(effectivePlanFor("pro", "trialing", null, now), "pro");
});

Deno.test("effectivePlanFor does NOT entitle unpaid/lapsed subs (US-392)", () => {
  // `incomplete` maps to 'none' (mapSubscriptionStatus) — must not grant caps
  // before the first payment clears.
  assertEquals(effectivePlanFor("pro", "none"), "free");
  assertEquals(effectivePlanFor("business", "canceled"), "free");
  // Verified-paid + grace states stay entitled.
  assertEquals(effectivePlanFor("pro", "active"), "pro");
  assertEquals(effectivePlanFor("pro", "past_due"), "pro");
  // Legacy null status remains entitling (column is NOT NULL in practice).
  assertEquals(effectivePlanFor("business", null), "business");
});

Deno.test("included caps mirror the plan model", () => {
  assertEquals(INCLUDED_STANDARD_PER_MONTH.free, 3);
  assertEquals(INCLUDED_STANDARD_PER_MONTH.starter, 10);
  assertEquals(INCLUDED_STANDARD_PER_MONTH.pro, 30);
  assertEquals(INCLUDED_STANDARD_PER_MONTH.business, 75);
});

Deno.test("suggestPack picks the smallest pack that covers the cost", () => {
  assertEquals(suggestPack(1).credits, 10);
  assertEquals(suggestPack(10).credits, 10);
  assertEquals(suggestPack(11).credits, 25);
  assertEquals(suggestPack(25).credits, 25);
  assertEquals(suggestPack(40).credits, 50);
  assertEquals(suggestPack(80).credits, 100);
});

Deno.test("computeBatchCredits: included covers standards first", () => {
  // 2 included standard grades remaining, 3 standard items → 1 needs a credit.
  assertEquals(computeBatchCredits(2, ["standard", "standard", "standard"]), 1);
});

Deno.test("computeBatchCredits: included never applies to premium/express", () => {
  // Plenty of included grades, but they only cover standard.
  assertEquals(computeBatchCredits(10, ["premium", "express"]), 3 + 5);
});

Deno.test("computeBatchCredits: mixed batch, partial included coverage", () => {
  // 1 included left; batch = standard(free), standard(1cr), premium(3cr), express(5cr).
  assertEquals(
    computeBatchCredits(1, ["standard", "standard", "premium", "express"]),
    1 + 3 + 5,
  );
});

Deno.test("computeBatchCredits: no included grades, all paid with credits", () => {
  assertEquals(computeBatchCredits(0, ["standard", "standard"]), 2);
});

Deno.test("computeBatchCredits: empty batch costs nothing", () => {
  assertEquals(computeBatchCredits(5, []), 0);
});

Deno.test("computeBatchCredits: negative includedRemaining treated as zero", () => {
  assertEquals(computeBatchCredits(-3, ["standard"]), 1);
});
