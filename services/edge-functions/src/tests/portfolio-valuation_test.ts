// US-1826: portfolio valuation engine (pure). No DB.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  estimateItemValue,
  computePortfolioTotals,
  depreciationFactor,
} = await import("../lib/portfolio-valuation.ts");

const NONE = {
  realizedMedianCents: null,
  fairValueMedianCents: null,
  fairValueLowCents: null,
  fairValueHighCents: null,
  costBasisCents: null,
  ageDays: null,
};

// ── no fabricated precision ─────────────────────────────────────────────────

Deno.test("valuation: no signal → null estimate, confidence none", () => {
  const v = estimateItemValue(NONE);
  assertEquals(v.estimateCents, null);
  assertEquals(v.confidence, "none");
  assertEquals(v.basis, []);
  assertEquals(v.trend, "unknown");
});

// ── depreciation ────────────────────────────────────────────────────────────

Deno.test("depreciation: shallow, floored at 40%", () => {
  assertEquals(depreciationFactor(null), 1);
  assertEquals(depreciationFactor(0), 1);
  assertEquals(depreciationFactor(365), 0.85); // 1 year → 15% off
  assertEquals(depreciationFactor(365 * 10), 0.4); // floored
});

// ── cost-basis only ─────────────────────────────────────────────────────────

Deno.test("valuation: cost-basis only → low confidence, depreciated", () => {
  const v = estimateItemValue({ ...NONE, costBasisCents: 10000, ageDays: 365 });
  assertEquals(v.confidence, "low");
  assertEquals(v.basis, ["cost_basis"]);
  assertEquals(v.estimateCents, 8500); // 10000 * 0.85
  // wide band at low confidence (±40%)
  assertEquals(v.lowCents, 5100);
  assertEquals(v.highCents, 11900);
  assertEquals(v.trend, "down"); // 8500 < 10000
});

// ── Value Index (fair value) ────────────────────────────────────────────────

Deno.test("valuation: Value Index band → medium confidence, band scaled", () => {
  const v = estimateItemValue({
    ...NONE,
    fairValueMedianCents: 6000,
    fairValueLowCents: 4000,
    fairValueHighCents: 9000,
  });
  assertEquals(v.confidence, "medium");
  assertEquals(v.basis, ["value_index"]);
  assertEquals(v.estimateCents, 6000);
  // ratio 1.0 → band passes through
  assertEquals(v.lowCents, 4000);
  assertEquals(v.highCents, 9000);
});

Deno.test("valuation: blend of Value Index + cost basis (weights 2:1)", () => {
  const v = estimateItemValue({
    ...NONE,
    fairValueMedianCents: 6000,
    costBasisCents: 3000,
    ageDays: 0,
  });
  // (6000*2 + 3000*1) / 3 = 5000
  assertEquals(v.estimateCents, 5000);
  assertEquals(v.basis, ["value_index", "cost_basis"]);
  assertEquals(v.confidence, "medium");
  assertEquals(v.trend, "up"); // 5000 > 3000 paid
});

Deno.test("valuation: realized present → high confidence, strongest weight", () => {
  const v = estimateItemValue({
    ...NONE,
    realizedMedianCents: 8000,
    fairValueMedianCents: 4000,
  });
  // (8000*3 + 4000*2) / 5 = 6400
  assertEquals(v.estimateCents, 6400);
  assertEquals(v.confidence, "high");
  assertEquals(v.basis, ["realized", "value_index"]);
});

// ── portfolio totals ────────────────────────────────────────────────────────

Deno.test("totals: gain/loss only over items with BOTH estimate and cost basis", () => {
  const t = computePortfolioTotals([
    { estimateCents: 5000, costBasisCents: 3000 }, // +2000
    { estimateCents: 2000, costBasisCents: 2500 }, // -500
    { estimateCents: 4000, costBasisCents: null }, // valued, no basis → not in gain
    { estimateCents: null, costBasisCents: 1000 }, // unvalued
  ]);
  assertEquals(t.totalEstimateCents, 11000); // 5000+2000+4000
  assertEquals(t.costBasisCents, 6500); // 3000+2500+1000
  assertEquals(t.unrealizedGainCents, 1500); // (5000+2000) - (3000+2500)
  assertEquals(t.itemsValued, 3);
  assertEquals(t.itemsUnvalued, 1);
});

Deno.test("totals: empty portfolio is all zeros", () => {
  const t = computePortfolioTotals([]);
  assertEquals(t.totalEstimateCents, 0);
  assertEquals(t.unrealizedGainCents, 0);
  assertEquals(t.itemsValued, 0);
});
