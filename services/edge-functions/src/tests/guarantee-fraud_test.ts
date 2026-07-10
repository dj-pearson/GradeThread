// US-1823: buyer guarantee anti-fraud signal scoring (pure). No DB.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  evaluateFraudSignals,
  normalizeGuaranteeFraudConfig,
  DEFAULT_GUARANTEE_FRAUD_CONFIG,
} = await import("../lib/guarantee-fraud.ts");

const CFG = DEFAULT_GUARANTEE_FRAUD_CONFIG; // maxClaims 3, maxRejected 2, minTrust 1, threshold 3, evidence req

const clean = {
  claimsThisPeriod: 0,
  recentRejectedClaims: 0,
  trustLevel: 2,
  hasFullArrivalEvidence: true,
  gradeAuthenticityFlagged: false,
};

Deno.test("fraud: a clean claim is not suspicious", () => {
  const v = evaluateFraudSignals(clean, CFG);
  assertEquals(v.suspicious, false);
  assertEquals(v.score, 0);
  assertEquals(v.reasons, []);
});

Deno.test("fraud: low trust alone (weight 1) is below threshold", () => {
  const v = evaluateFraudSignals({ ...clean, trustLevel: 0 }, CFG);
  assertEquals(v.reasons, ["low_trust"]);
  assertEquals(v.score, 1);
  assertEquals(v.suspicious, false);
});

Deno.test("fraud: velocity (2) + low trust (1) reaches the threshold", () => {
  const v = evaluateFraudSignals({ ...clean, claimsThisPeriod: 3, trustLevel: 0 }, CFG);
  assertEquals(v.reasons.sort(), ["low_trust", "velocity"]);
  assertEquals(v.score, 3);
  assertEquals(v.suspicious, true);
});

Deno.test("fraud: a tamper-flagged grade (2) + thin evidence (1) trips it", () => {
  const v = evaluateFraudSignals(
    { ...clean, gradeAuthenticityFlagged: true, hasFullArrivalEvidence: false },
    CFG,
  );
  assertEquals(v.reasons.sort(), ["grade_tampered", "thin_evidence"]);
  assertEquals(v.suspicious, true);
});

Deno.test("fraud: repeat-rejection pattern (2) needs one more signal", () => {
  const two = evaluateFraudSignals({ ...clean, recentRejectedClaims: 2 }, CFG);
  assertEquals(two.suspicious, false); // 2 < 3
  const three = evaluateFraudSignals({ ...clean, recentRejectedClaims: 2, trustLevel: 0 }, CFG);
  assertEquals(three.suspicious, true); // 2 + 1
});

Deno.test("fraud: thin evidence ignored when the config doesn't require it", () => {
  const v = evaluateFraudSignals({ ...clean, hasFullArrivalEvidence: false }, {
    ...CFG,
    require_full_arrival_evidence: false,
  });
  assertEquals(v.reasons, []);
});

Deno.test("config: garbage → defaults; invalid ints clamp to 0", () => {
  assertEquals(normalizeGuaranteeFraudConfig(undefined), DEFAULT_GUARANTEE_FRAUD_CONFIG);
  assertEquals(normalizeGuaranteeFraudConfig({ max_claims_per_period: -1 }).max_claims_per_period, 0);
  assertEquals(normalizeGuaranteeFraudConfig({ require_full_arrival_evidence: false }).require_full_arrival_evidence, false);
});
