import { assert, assertEquals } from "@std/assert";
import {
  aggregateClaimSignals,
  type ClaimIssue,
  type ClaimSignalRow,
  factorForDefect,
  mapClaimIssuesToFactorDeltas,
  normalizeClaimIssues,
  severityWeight,
} from "../lib/claim-accuracy.ts";

// US-1113: pure buyer-guarantee-claim → grading-factor calibration math.

Deno.test("factorForDefect maps keywords to the most-specific factor", () => {
  assertEquals(factorForDefect("Broken zipper pull"), "functional_elements");
  assertEquals(factorForDefect("strong smoke odor"), "odor_cleanliness");
  assertEquals(factorForDefect("open seam at the shoulder"), "structural_integrity");
  assertEquals(factorForDefect("large coffee stain on front"), "fabric_condition");
  assertEquals(factorForDefect("logo print is cracked"), "cosmetic_appearance");
  // Unknown defect text falls back to cosmetic appearance (never throws).
  assertEquals(factorForDefect("something is off"), "cosmetic_appearance");
});

Deno.test("severityWeight: minor/moderate/major + default", () => {
  assertEquals(severityWeight("minor"), 0.5);
  assertEquals(severityWeight("moderate"), 1.0);
  assertEquals(severityWeight("MAJOR"), 2.0);
  // Unknown severity defaults to moderate.
  assertEquals(severityWeight("catastrophic"), 1.0);
});

Deno.test("mapClaimIssuesToFactorDeltas: per-factor + rubric-weighted overall", () => {
  const issues: ClaimIssue[] = [
    { defect: "broken zipper", severity: "major", location: "front" }, // functional +2.0
    { defect: "musty smell", severity: "moderate", location: "" }, // odor +1.0
    { defect: "small stain", severity: "minor", location: "cuff" }, // fabric +0.5
  ];
  const { deltas, overall_delta, issue_count } = mapClaimIssuesToFactorDeltas(issues);
  assertEquals(issue_count, 3);
  assertEquals(deltas.functional_elements, 2.0);
  assertEquals(deltas.odor_cleanliness, 1.0);
  assertEquals(deltas.fabric_condition, 0.5);
  assertEquals(deltas.structural_integrity, 0);
  assertEquals(deltas.cosmetic_appearance, 0);
  // overall = 2.0*0.15 + 1.0*0.10 + 0.5*0.30 = 0.30 + 0.10 + 0.15 = 0.55
  assertEquals(overall_delta, 0.55);
});

Deno.test("mapClaimIssuesToFactorDeltas: empty issues never fabricate a signal", () => {
  const { deltas, overall_delta, issue_count } = mapClaimIssuesToFactorDeltas([]);
  assertEquals(issue_count, 0);
  assertEquals(overall_delta, 0);
  for (const v of Object.values(deltas)) assertEquals(v, 0);
});

Deno.test("normalizeClaimIssues: tolerant of malformed jsonb", () => {
  const raw = [
    { defect: "  hole  ", severity: "major", location: "knee" },
    { defect: "", severity: "minor" }, // dropped (no defect)
    "not an object", // dropped
    { severity: "moderate" }, // dropped (no defect)
    { defect: "fade", location: 3 }, // severity missing → default moderate
  ];
  const out = normalizeClaimIssues(raw);
  assertEquals(out.length, 2);
  assertEquals(out[0].defect, "hole");
  assertEquals(out[1].defect, "fade");
  assertEquals(out[1].severity, "moderate");
  assertEquals(normalizeClaimIssues(null), []);
  assertEquals(normalizeClaimIssues("nope"), []);
});

Deno.test("aggregateClaimSignals: per-factor counts, totals, means", () => {
  const rows: ClaimSignalRow[] = [
    {
      factor_deltas: { fabric_condition: 1.0, functional_elements: 2.0 },
      overall_delta: 0.6,
      issue_count: 2,
    },
    {
      factor_deltas: { fabric_condition: 0.5 },
      overall_delta: 0.15,
      issue_count: 1,
    },
    {
      // A claim that flagged no factor (no structured issues) still counts.
      factor_deltas: {},
      overall_delta: 0,
      issue_count: 0,
    },
  ];
  const report = aggregateClaimSignals(rows, "2026-06-20T00:00:00.000Z");
  assertEquals(report.total_claims, 3);
  assertEquals(report.total_issues, 3);

  const fabric = report.factors.find((f) => f.factor === "fabric_condition")!;
  assertEquals(fabric.claims, 2);
  assertEquals(fabric.total_delta, 1.5);
  assertEquals(fabric.mean_delta, 0.75);

  const functional = report.factors.find((f) => f.factor === "functional_elements")!;
  assertEquals(functional.claims, 1);
  assertEquals(functional.total_delta, 2.0);

  // A factor no claim flagged reports zeros, never NaN.
  const odor = report.factors.find((f) => f.factor === "odor_cleanliness")!;
  assertEquals(odor.claims, 0);
  assertEquals(odor.mean_delta, 0);

  // mean overall over (0.6 + 0.15 + 0) / 3 = 0.25
  assertEquals(report.mean_overall_delta, 0.25);
  // Worst (highest total_delta) factor first.
  assertEquals(report.factors[0].factor, "functional_elements");
});

Deno.test("aggregateClaimSignals: no rows → clean zeros", () => {
  const report = aggregateClaimSignals([], "2026-06-20T00:00:00.000Z");
  assertEquals(report.total_claims, 0);
  assertEquals(report.mean_overall_delta, 0);
  assert(report.factors.every((f) => f.claims === 0 && f.total_delta === 0));
});
