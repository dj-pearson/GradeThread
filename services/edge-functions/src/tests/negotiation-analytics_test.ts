// US-1168 / US-1169: pure logic behind the AI negotiation guardrail and the
// analytics-narrative normalizer. The LLM drafters (generateNegotiationReply /
// generateAnalyticsNarrative) are not unit-tested here — like the rest of the
// AI lib, only the deterministic helpers are. ai-extract.ts pulls ai-config ->
// Anthropic, which is import-safe, but we dummy-env + dynamic-import to match
// the repo's other AI-lib tests.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { validateCounterOffer, deriveAnalyticsMetrics } = await import(
  "../lib/ai-extract.ts"
);

// ── validateCounterOffer ────────────────────────────────────────────────────

Deno.test("counter suggestion meets in the middle of offer and ask", () => {
  const v = validateCounterOffer({ offerPrice: 40, askingPrice: 60, costBasis: 20 });
  assertEquals(v.suggestedCounter, 50); // midpoint
  assertEquals(v.belowCost, false);
  assertEquals(v.warnings.length, 0);
});

Deno.test("offer at/below cost flags belowCost and warns", () => {
  const v = validateCounterOffer({ offerPrice: 18, askingPrice: 60, costBasis: 20 });
  assert(v.belowCost);
  assert(v.warnings.some((w) => w.toLowerCase().includes("cost")));
});

Deno.test("suggested counter is floored to cost when midpoint would lose money", () => {
  // Offer 10, ask 22 -> midpoint 16, but cost is 18, so floor at cost.
  const v = validateCounterOffer({ offerPrice: 10, askingPrice: 22, costBasis: 18 });
  assertEquals(v.suggestedCounter, 18);
});

Deno.test("suggested counter never lands at/below the offer with no ask", () => {
  const v = validateCounterOffer({ offerPrice: 30, askingPrice: null, costBasis: null });
  assert(v.suggestedCounter !== null && v.suggestedCounter > 30);
  assertEquals(v.suggestedCounter, 33); // 10% nudge
});

Deno.test("suggested counter is capped at the asking price", () => {
  // cost 100 > midpoint, but ask is 50 -> cap at ask.
  const v = validateCounterOffer({ offerPrice: 40, askingPrice: 50, costBasis: 100 });
  assertEquals(v.suggestedCounter, 50);
});

Deno.test("proposed counter at/below offer warns and flags atOrBelowOffer", () => {
  const v = validateCounterOffer({ offerPrice: 40, askingPrice: 60, costBasis: 20 }, 40);
  assert(v.atOrBelowOffer);
  assert(v.warnings.some((w) => w.toLowerCase().includes("accept the offer")));
});

Deno.test("proposed counter above asking warns and flags aboveAsking", () => {
  const v = validateCounterOffer({ offerPrice: 40, askingPrice: 60, costBasis: 20 }, 70);
  assert(v.aboveAsking);
  assert(v.warnings.some((w) => w.toLowerCase().includes("asking")));
});

Deno.test("proposed counter below cost warns", () => {
  const v = validateCounterOffer({ offerPrice: 40, askingPrice: 60, costBasis: 50 }, 45);
  assert(v.warnings.some((w) => w.toLowerCase().includes("lose money")));
});

// ── deriveAnalyticsMetrics ──────────────────────────────────────────────────

Deno.test("derives net profit, margin and roi from a rollup", () => {
  const m = deriveAnalyticsMetrics({
    periodLabel: "June",
    grossRevenue: 1000,
    fees: 130,
    cogs: 400,
    unitsSold: 12,
  });
  assertEquals(m.netProfit, 470); // 1000 - 130 - 400
  assertEquals(m.margin, 0.47); // 470 / 1000
  assertEquals(m.roi, 1.18); // 470 / 400, rounded to 2dp (1.175 -> 1.18)
  assertEquals(m.currency, "USD");
});

Deno.test("a loss yields a negative net profit (no spin)", () => {
  const m = deriveAnalyticsMetrics({
    periodLabel: "May",
    grossRevenue: 200,
    fees: 30,
    cogs: 300,
    unitsSold: 5,
  });
  assert(m.netProfit < 0);
  assertEquals(m.netProfit, -130);
});

Deno.test("zero cogs yields null roi, never a divide-by-zero", () => {
  const m = deriveAnalyticsMetrics({
    periodLabel: "Q1",
    grossRevenue: 500,
    fees: 50,
    cogs: 0,
    unitsSold: 4,
  });
  assertEquals(m.roi, null);
  assertEquals(m.margin, 0.9);
});

Deno.test("negative/NaN inputs are floored, optional fields normalized", () => {
  const m = deriveAnalyticsMetrics({
    periodLabel: "bad",
    grossRevenue: -100,
    fees: Number.NaN,
    cogs: -5,
    unitsSold: 3.7,
    sellThroughRate: 1.4, // clamped to 1
    gradingRoiLift: 12.345,
    topBrand: "  ",
    currency: "EUR",
  });
  assertEquals(m.grossRevenue, 0);
  assertEquals(m.fees, 0);
  assertEquals(m.cogs, 0);
  assertEquals(m.unitsSold, 4); // rounded
  assertEquals(m.sellThroughRate, 1);
  assertEquals(m.gradingRoiLift, 12.35);
  assertEquals(m.topBrand, null); // blank trimmed away
  assertEquals(m.currency, "EUR");
});
