// Unit tests for the confidence-calibration math (US-331).
//
// buildCalibration is pure. accuracy-tracking.ts imports the service-role
// supabase client at load, so set dummy env BEFORE the dynamic import.
//
//   deno test --allow-env src/tests/calibration_test.ts

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { buildCalibration } = await import("../lib/accuracy-tracking.ts");

// Build n pairs at a given confidence with a fraction that "agree" (error 0).
function pairs(confidence: number, n: number, agreeFraction: number) {
  return Array.from({ length: n }, (_, i) => ({
    confidence,
    error: i < Math.round(n * agreeFraction) ? 0 : 1, // 0 agrees, 1 disagrees
  }));
}

Deno.test("empty input → zeroed bins, null recommendation", () => {
  const r = buildCalibration([], 0.75);
  assertEquals(r.total, 0);
  assertEquals(r.bins.length, 10);
  assertEquals(r.recommended_threshold, null);
  assertEquals(r.agreement_at_current, null);
});

Deno.test("bins capture per-bucket agreement", () => {
  // 20 grades at confidence 0.95 (high bin), 80% agree.
  const r = buildCalibration(pairs(0.95, 20, 0.8), 0.75);
  const top = r.bins[9]; // [0.9, 1.0]
  assertEquals(top.count, 20);
  assert(Math.abs(top.agreement_rate - 0.8) < 1e-9);
});

Deno.test("recommends the lowest threshold meeting the target agreement", () => {
  // Low-confidence grades (0.5) agree only 50%; high-confidence (0.95) agree 95%.
  const data = [...pairs(0.5, 40, 0.5), ...pairs(0.95, 40, 0.95)];
  const r = buildCalibration(data, 0.75, 0.9);
  // Everything at/above 0.6 is the high-confidence group (95% agree), and the
  // 0.5 group is excluded there — so 0.6 is the lowest threshold that still
  // ships >=90%-agreement grades.
  assertEquals(r.recommended_threshold, 0.6);
  // At/above the current 0.75 threshold, only the 0.95 group qualifies → 95%.
  assert(r.agreement_at_current !== null && r.agreement_at_current > 0.9);
});

Deno.test("no threshold reaches target → null recommendation", () => {
  // Everything agrees only 60%, nowhere near 0.9.
  const r = buildCalibration(pairs(0.8, 50, 0.6), 0.75, 0.9);
  assertEquals(r.recommended_threshold, null);
});

Deno.test("subset below the minimum sample is not used for a recommendation", () => {
  // Only 3 perfect grades — too small to recommend off of.
  const r = buildCalibration(pairs(0.99, 3, 1.0), 0.75, 0.9);
  assertEquals(r.recommended_threshold, null);
});
