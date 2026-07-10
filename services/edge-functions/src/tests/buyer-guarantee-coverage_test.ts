// US-1820: purchase guarantee coverage — the pure eligibility + window math.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { resolveCoverageTerms, DEFAULT_COVERAGE_CONFIG } = await import(
  "../lib/buyer-guarantee-coverage.ts"
);

const NOW = Date.UTC(2026, 6, 9);
const base = { config: DEFAULT_COVERAGE_CONFIG, nowMs: NOW };

Deno.test("ineligible when the plan doesn't include the guarantee", () => {
  const r = resolveCoverageTerms({ hasGuaranteeEntitlement: false, trustLevel: 0, purchasedAt: null, ...base });
  assertEquals(r.eligible, false);
  assertEquals(r.reason, "plan_not_covered");
  assertEquals(r.coveredUntil, null);
  // Terms are still surfaced so the UI can explain what an upgrade unlocks.
  assertEquals(r.payoutCapCents, DEFAULT_COVERAGE_CONFIG.payoutCapCents);
});

Deno.test("ineligible when coverage is globally disabled", () => {
  const r = resolveCoverageTerms({
    hasGuaranteeEntitlement: true,
    trustLevel: 3,
    purchasedAt: null,
    config: { ...DEFAULT_COVERAGE_CONFIG, enabled: false },
    nowMs: NOW,
  });
  assertEquals(r.eligible, false);
  assertEquals(r.reason, "coverage_disabled");
});

Deno.test("eligible: window = base + reputation bonus (US-1817 composition)", () => {
  // New buyer (level 0): +0 bonus → 30-day base window.
  const lvl0 = resolveCoverageTerms({ hasGuaranteeEntitlement: true, trustLevel: 0, purchasedAt: null, ...base });
  assertEquals(lvl0.eligible, true);
  assertEquals(lvl0.windowDays, 30);
  // Connoisseur (level 3): +30 bonus → 60-day window.
  const lvl3 = resolveCoverageTerms({ hasGuaranteeEntitlement: true, trustLevel: 3, purchasedAt: null, ...base });
  assertEquals(lvl3.windowDays, 60);
});

Deno.test("coveredUntil anchors on the purchase date when present", () => {
  const purchasedAt = new Date(Date.UTC(2026, 5, 1)).toISOString(); // Jun 1
  const r = resolveCoverageTerms({ hasGuaranteeEntitlement: true, trustLevel: 0, purchasedAt, ...base });
  // Jun 1 + 30 days = Jul 1.
  assertEquals(r.coveredUntil, new Date(Date.UTC(2026, 6, 1)).toISOString());
});

Deno.test("coveredUntil falls back to now when no purchase date recorded", () => {
  const r = resolveCoverageTerms({ hasGuaranteeEntitlement: true, trustLevel: 0, purchasedAt: null, ...base });
  assertEquals(r.coveredUntil, new Date(NOW + 30 * 86_400_000).toISOString());
});

Deno.test("a garbage purchase date is treated as now (no NaN window)", () => {
  const r = resolveCoverageTerms({ hasGuaranteeEntitlement: true, trustLevel: 0, purchasedAt: "not-a-date", ...base });
  assert(r.coveredUntil !== null && !r.coveredUntil.includes("NaN"));
  assertEquals(r.coveredUntil, new Date(NOW + 30 * 86_400_000).toISOString());
});
