// US-1812: buyer grade confirm/dispute engine — the pure decision math
// (dispute severity, guarantee eligibility, seller integrity score). No DB.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  deriveDisputeSeverity,
  decideGuaranteeEligible,
  computeSellerIntegrityScore,
  MIN_INTEGRITY_SAMPLE,
  MIN_CONFIRMED_FOR_TIER,
  sellerIntegrityTier,
} = await import("../lib/buyer-grade-confirmation.ts");

const NOW = Date.UTC(2026, 6, 9);
const inDays = (n: number) => new Date(NOW + n * 86_400_000).toISOString();

// ─── deriveDisputeSeverity ──────────────────────────────────────────────────

Deno.test("severity: over-grade at/above threshold is material", () => {
  assertEquals(deriveDisputeSeverity(1.0, 1.0), "material");
  assertEquals(deriveDisputeSeverity(2.5, 1.0), "material");
});

Deno.test("severity: below threshold is cosmetic", () => {
  assertEquals(deriveDisputeSeverity(0.5, 1.0), "cosmetic");
  assertEquals(deriveDisputeSeverity(0, 1.0), "cosmetic");
});

Deno.test("severity: a zero/negative threshold never yields material", () => {
  // A misconfigured threshold must not silently make every nitpick material.
  assertEquals(deriveDisputeSeverity(5, 0), "cosmetic");
});

// ─── decideGuaranteeEligible ────────────────────────────────────────────────

const COVERED = { eligible: true, coveredUntil: inDays(10), gradeDeltaThreshold: 1.0 };

Deno.test("guarantee: material dispute, eligible + in-window + over threshold → eligible", () => {
  assertEquals(
    decideGuaranteeEligible({
      matchStatus: "disputed",
      severity: "material",
      overallDelta: 1.5,
      coverage: COVERED,
      nowMs: NOW,
    }),
    true,
  );
});

Deno.test("guarantee: a confirmation is never eligible", () => {
  assertEquals(
    decideGuaranteeEligible({
      matchStatus: "confirmed",
      severity: "cosmetic",
      overallDelta: 0,
      coverage: COVERED,
      nowMs: NOW,
    }),
    false,
  );
});

Deno.test("guarantee: a cosmetic dispute is never eligible", () => {
  assertEquals(
    decideGuaranteeEligible({
      matchStatus: "disputed",
      severity: "cosmetic",
      overallDelta: 0.5,
      coverage: COVERED,
      nowMs: NOW,
    }),
    false,
  );
});

Deno.test("guarantee: no coverage / ineligible coverage → not eligible", () => {
  const base = { matchStatus: "disputed" as const, severity: "material" as const, overallDelta: 2, nowMs: NOW };
  assertEquals(decideGuaranteeEligible({ ...base, coverage: null }), false);
  assertEquals(
    decideGuaranteeEligible({ ...base, coverage: { ...COVERED, eligible: false } }),
    false,
  );
});

Deno.test("guarantee: outside the window → not eligible", () => {
  assertEquals(
    decideGuaranteeEligible({
      matchStatus: "disputed",
      severity: "material",
      overallDelta: 2,
      coverage: { ...COVERED, coveredUntil: inDays(-1) },
      nowMs: NOW,
    }),
    false,
  );
});

Deno.test("guarantee: delta below the coverage threshold → not eligible", () => {
  assertEquals(
    decideGuaranteeEligible({
      matchStatus: "disputed",
      severity: "material",
      overallDelta: 0.5,
      coverage: { ...COVERED, gradeDeltaThreshold: 2.0 },
      nowMs: NOW,
    }),
    false,
  );
});

// ─── computeSellerIntegrityScore ────────────────────────────────────────────

Deno.test("integrity: a new seller (no outcomes) scores 100", () => {
  assertEquals(
    computeSellerIntegrityScore({
      confirmed_count: 0,
      disputed_count: 0,
      material_dispute_count: 0,
      total_outcomes: 0,
    }),
    100,
  );
});

Deno.test("integrity: all confirmations score 100", () => {
  assertEquals(
    computeSellerIntegrityScore({
      confirmed_count: 20,
      disputed_count: 0,
      material_dispute_count: 0,
      total_outcomes: 20,
    }),
    100,
  );
});

Deno.test("integrity: one material dispute is smoothed, not zero", () => {
  // weightedBad = 1 + 1 = 2; weightedTotal = 1 + 1 = 2; effective = max(2,5)=5
  // score = round(100 * (1 - 2/5)) = 60
  assertEquals(
    computeSellerIntegrityScore({
      confirmed_count: 0,
      disputed_count: 1,
      material_dispute_count: 1,
      total_outcomes: 1,
    }),
    60,
  );
});

Deno.test("integrity: a material dispute weighs double a cosmetic one", () => {
  const cosmetic = computeSellerIntegrityScore({
    confirmed_count: 9,
    disputed_count: 1,
    material_dispute_count: 0,
    total_outcomes: 10,
  });
  const material = computeSellerIntegrityScore({
    confirmed_count: 9,
    disputed_count: 1,
    material_dispute_count: 1,
    total_outcomes: 10,
  });
  // cosmetic: bad=1 total=10 → 90 ; material: bad=2 total=11 → round(100*(1-2/11))=82
  assertEquals(cosmetic, 90);
  assertEquals(material, 82);
});

Deno.test("integrity: score never drops below 0", () => {
  const score = computeSellerIntegrityScore({
    confirmed_count: 0,
    disputed_count: 50,
    material_dispute_count: 50,
    total_outcomes: 50,
  });
  assertEquals(score, 0);
});

Deno.test("integrity: MIN_INTEGRITY_SAMPLE is the smoothing floor", () => {
  assertEquals(MIN_INTEGRITY_SAMPLE, 5);
});

// ─── sellerIntegrityTier (US-1912) ──────────────────────────────────────────

Deno.test("tier: below the confirmed-volume floor is non-displayable 'building'", () => {
  const r = sellerIntegrityTier({ integrityScore: 100, confirmedCount: 3 });
  assertEquals(r.tier, "building");
  assertEquals(r.displayable, false);
  assertEquals(r.nextTier, "verified");
  assertEquals(r.nextTierGaps, [`${MIN_CONFIRMED_FOR_TIER - 3} more confirmed outcomes`]);
});

Deno.test("tier: a low score above the floor is still Verified (never a bad public score)", () => {
  const r = sellerIntegrityTier({ integrityScore: 40, confirmedCount: 12 });
  assertEquals(r.tier, "verified");
  assertEquals(r.displayable, true);
});

Deno.test("tier: reliable at score ≥90 with ≥10 confirmed", () => {
  const r = sellerIntegrityTier({ integrityScore: 92, confirmedCount: 15 });
  assertEquals(r.tier, "reliable");
  assertEquals(r.nextTier, "trusted");
});

Deno.test("tier: trusted requires score+volume+coverage+tenure", () => {
  const base = { integrityScore: 96, confirmedCount: 30, avgCoveragePct: 80, tenureDays: 120, gradedVolume: 60 };
  assertEquals(sellerIntegrityTier(base).tier, "trusted");
  // Missing coverage floor drops it back to reliable.
  assertEquals(sellerIntegrityTier({ ...base, avgCoveragePct: 60 }).tier, "reliable");
  // Too little tenure also drops it.
  assertEquals(sellerIntegrityTier({ ...base, tenureDays: 30 }).tier, "reliable");
});

Deno.test("tier: elite is the top, gated hardest", () => {
  const r = sellerIntegrityTier({ integrityScore: 99, confirmedCount: 60, avgCoveragePct: 95, tenureDays: 200, gradedVolume: 150 });
  assertEquals(r.tier, "elite");
  assertEquals(r.nextTier, null);
  assertEquals(r.nextTierGaps, []);
});

Deno.test("tier: unknown coverage/tenure never blocks (not gated on null)", () => {
  // Score+volume qualify for trusted; coverage/tenure unknown → still trusted.
  const r = sellerIntegrityTier({ integrityScore: 96, confirmedCount: 30, gradedVolume: 60 });
  assertEquals(r.tier, "trusted");
});

Deno.test("tier: gaps explain the path to the next tier", () => {
  const r = sellerIntegrityTier({ integrityScore: 92, confirmedCount: 15, avgCoveragePct: 60, tenureDays: 30, gradedVolume: 20 });
  assertEquals(r.tier, "reliable");
  // needs score≥95, +10 confirmed, coverage≥75, 90d tenure, +20 graded
  assertEquals(r.nextTierGaps.includes("integrity ≥ 95"), true);
  assertEquals(r.nextTierGaps.some((g) => g.includes("confirmed outcomes")), true);
  assertEquals(r.nextTierGaps.includes("avg photo coverage ≥ 75%"), true);
});
