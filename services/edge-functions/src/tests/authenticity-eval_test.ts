// US-1770: authenticity golden-set eval gate — pure scoring + gate logic.
// authenticity-eval.ts imports the service-role supabase client at load, so set
// dummy env first and dynamic-import (mirrors ai-authenticity_test.ts).
import { assert, assertEquals } from "@std/assert";
// Type-only imports are erased at compile time, so they don't trigger the
// module's service-role supabase load before the dummy env is set below.
import type { AuthenticityCaseResult, ExpectedLabel } from "../lib/authenticity-eval.ts";
import type { AuthenticityVerdict } from "../lib/ai-authenticity.ts";

Deno.env.set("SUPABASE_URL", "https://example.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "dummy");

const {
  verdictToLabel,
  caseAgrees,
  isDangerousMiss,
  aggregateAuthenticityEval,
  authenticityEvalMinAgreement,
  gateStatusFromRun,
  summarizeCaseCoverage,
  validateAuthenticityCase,
} = await import("../lib/authenticity-eval.ts");

// ── US-2131: golden-set curation ────────────────────────────────────────────

Deno.test("coverage: a brand needs BOTH an authentic and a counterfeit case to be usable", () => {
  const c = summarizeCaseCoverage([
    { brand_key: "gucci", expected_label: "authentic", is_active: true },
    { brand_key: "gucci", expected_label: "counterfeit", is_active: true },
    // Authentic-only: a perfect score here proves nothing, because the one error
    // the gate exists to catch (a known fake called authentic) cannot occur.
    { brand_key: "coach", expected_label: "authentic", is_active: true },
    { brand_key: "coach", expected_label: "authentic", is_active: true },
  ]);
  assert(c.brands.gucci?.usable);
  assertEquals(c.brands.coach?.usable, false);
  assertEquals(c.usable_brands, 1);
  assertEquals(c.total_active, 4);
});

Deno.test("coverage: retired cases are excluded", () => {
  const c = summarizeCaseCoverage([
    { brand_key: "gucci", expected_label: "authentic", is_active: true },
    { brand_key: "gucci", expected_label: "counterfeit", is_active: false },
  ]);
  assertEquals(c.total_active, 1);
  assertEquals(c.brands.gucci?.usable, false, "a retired counterfeit no longer backs the brand");
});

Deno.test("validate: rejects a case the eval would choke on", () => {
  const ok = {
    label: "Gucci Marmont, boutique",
    brand_key: "gucci",
    expected_label: "authentic",
    images: [{ image_type: "serial", storage_path: "u/1/serial.jpg" }],
  };
  assertEquals(validateAuthenticityCase(ok), null);

  assert(validateAuthenticityCase({ ...ok, label: "  " })?.includes("label"));
  assert(validateAuthenticityCase({ ...ok, brand_key: undefined })?.includes("brand_key"));
  assert(validateAuthenticityCase({ ...ok, expected_label: "probably" })?.includes("expected_label"));
  // Empty images is the one runAuthenticityEval throws on mid-run, after it has
  // already spent vision calls on earlier cases — so reject it at write time.
  assert(validateAuthenticityCase({ ...ok, images: [] })?.includes("images"));
  assert(validateAuthenticityCase({ ...ok, images: [{ image_type: "serial" }] })?.includes("storage_path"));
});

// ── US-2130: the gate decision fails closed ─────────────────────────────────
// Both "no passing run" and "the query blew up" must report ungated. A pass has
// to be positively evidenced — never inferred from silence.

Deno.test("gate: a passing run on the serving model is gated", () => {
  const s = gateStatusFromRun(
    "authenticity_v1",
    "claude-x",
    { agreement_rate: 0.91, created_at: "2026-07-19T00:00:00Z" },
    null,
  );
  assert(s.gated);
  assertEquals(s.reason, null);
  assertEquals(s.agreement_rate, 0.91);
});

Deno.test("gate: no passing run → NOT gated, with a reason naming the version", () => {
  const s = gateStatusFromRun("authenticity_v1", "claude-x", null, null);
  assertEquals(s.gated, false);
  assert(s.reason?.includes("authenticity_v1"), "reason should name the version");
  assertEquals(s.agreement_rate, null);
});

Deno.test("gate: a failed query is NOT a pass (fail closed)", () => {
  // The regression that matters: treating an unreadable ledger as "fine" is how
  // a gate silently stops gating.
  const s = gateStatusFromRun("authenticity_v1", "claude-x", null, "connection reset");
  assertEquals(s.gated, false);
  assert(s.reason?.includes("connection reset"));
});

// ── verdict → label mapping ─────────────────────────────────────────────────
Deno.test("verdictToLabel maps the verdict vocabulary onto the golden-set labels", () => {
  assertEquals(verdictToLabel("likely_authentic"), "authentic");
  assertEquals(verdictToLabel("red_flags"), "counterfeit");
  assertEquals(verdictToLabel("inconclusive"), "inconclusive");
});

Deno.test("caseAgrees is an exact class match", () => {
  assert(caseAgrees("authentic", "likely_authentic"));
  assert(caseAgrees("counterfeit", "red_flags"));
  assert(!caseAgrees("counterfeit", "inconclusive"));
});

Deno.test("isDangerousMiss: only a known counterfeit called likely-authentic", () => {
  assert(isDangerousMiss("counterfeit", "likely_authentic"));
  assert(!isDangerousMiss("counterfeit", "inconclusive"), "a cautious miss is not dangerous");
  assert(!isDangerousMiss("authentic", "likely_authentic"));
});

// ── aggregation + gate ──────────────────────────────────────────────────────
function mk(
  brand: string,
  expected: ExpectedLabel,
  verdict: AuthenticityVerdict,
): AuthenticityCaseResult {
  return {
    case_id: `${brand}-${verdict}`,
    label: brand,
    brand_key: brand,
    expected_label: expected,
    verdict,
    verdict_confidence: 0.8,
    agreed: caseAgrees(expected, verdict),
    dangerous_miss: isDangerousMiss(expected, verdict),
  };
}

Deno.test("aggregate: overall + per-brand accuracy, gate passes when clean & above threshold", () => {
  const perCase = [
    mk("gucci", "authentic", "likely_authentic"),
    mk("gucci", "counterfeit", "red_flags"),
    mk("coach", "authentic", "likely_authentic"),
    mk("coach", "authentic", "inconclusive"), // a miss, but not dangerous
  ];
  const agg = aggregateAuthenticityEval(perCase, 0.7);
  assertEquals(agg.cases_total, 4);
  assertEquals(agg.cases_agreed, 3);
  assertEquals(agg.agreement_rate, 0.75);
  assertEquals(agg.dangerous_misses, 0);
  assertEquals(agg.passed, true, "0.75 ≥ 0.7 and no dangerous miss → passes");
  assertEquals(agg.per_brand.gucci.agreement_rate, 1);
  assertEquals(agg.per_brand.coach.agreement_rate, 0.5);
});

Deno.test("gate FAILS on any dangerous miss even with high agreement", () => {
  const perCase = [
    mk("lv", "authentic", "likely_authentic"),
    mk("lv", "authentic", "likely_authentic"),
    mk("lv", "authentic", "likely_authentic"),
    mk("lv", "counterfeit", "likely_authentic"), // DANGEROUS: fake called authentic
  ];
  const agg = aggregateAuthenticityEval(perCase, 0.7);
  assertEquals(agg.agreement_rate, 0.75, "still 75% agreement");
  assertEquals(agg.dangerous_misses, 1);
  assertEquals(agg.passed, false, "a dangerous miss fails the gate regardless of agreement");
});

Deno.test("gate FAILS when agreement is below threshold", () => {
  const perCase = [
    mk("nike", "authentic", "likely_authentic"),
    mk("nike", "counterfeit", "inconclusive"), // miss (not dangerous)
    mk("nike", "counterfeit", "inconclusive"), // miss (not dangerous)
  ];
  const agg = aggregateAuthenticityEval(perCase, 0.8);
  assert(agg.agreement_rate < 0.8);
  assertEquals(agg.dangerous_misses, 0);
  assertEquals(agg.passed, false);
});

Deno.test("empty set never passes the gate", () => {
  assertEquals(aggregateAuthenticityEval([], 0.8).passed, false);
});

Deno.test("min-agreement default is a sane conservative fraction", () => {
  const t = authenticityEvalMinAgreement();
  assert(t > 0 && t <= 1);
});
