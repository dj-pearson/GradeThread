// US-3323: an adjusted grade must report its REAL error.
//
// applyGradeAdjustment overwrites grade_reports with the reviewer's scores, so
// "the report's score vs the reviewer's score" is zero on every corrected
// grade. These cases pin the rule that replaced it (lib/review-baseline.ts):
// AI side from the earliest review's snapshot, human side from the report.
//
//   deno test --allow-read src/tests/review-baseline_test.ts

import { assert, assertEquals } from "@std/assert";
import {
  buildReviewedGrades,
  type ReportForBaseline,
  type ReviewBaselineRow,
  reviewSnapshot,
  signedFactorErrors,
  signedOverallError,
} from "../lib/review-baseline.ts";

const AI = {
  fabric_condition_score: 7.0,
  structural_integrity_score: 8.0,
  cosmetic_appearance_score: 7.5,
  functional_elements_score: 8.0,
  odor_cleanliness_score: 8.0,
};

// The weighted overall of AI above: 7*0.3 + 8*0.25 + 7.5*0.2 + 8*0.15 + 8*0.1.
const AI_OVERALL = 7.6;

function snapshotOf(f: typeof AI) {
  return {
    original_fabric_condition: f.fabric_condition_score,
    original_structural_integrity: f.structural_integrity_score,
    original_cosmetic_appearance: f.cosmetic_appearance_score,
    original_functional_elements: f.functional_elements_score,
    original_odor_cleanliness: f.odor_cleanliness_score,
  };
}

function reports(entries: Array<[string, ReportForBaseline]>) {
  return new Map(entries);
}

Deno.test("an ADJUSTED grade reports the reviewer's correction as error, not zero", () => {
  // The report after applyGradeAdjustment: it holds the human's scores now.
  const human = { ...AI, fabric_condition_score: 8.0 };
  const r = reports([["g1", { overall_score: 7.9, ...human }]]);
  const rows: ReviewBaselineRow[] = [{
    grade_report_id: "g1",
    original_score: AI_OVERALL,
    adjusted_score: 7.9,
    reviewed_at: "2026-09-10T10:00:00Z",
    review_action: "adjust",
    ...snapshotOf(AI),
  }];
  const [g] = buildReviewedGrades(rows, r);
  assertEquals(g.aiOverall, AI_OVERALL);
  assertEquals(g.humanOverall, 7.9);
  // The whole defect: the old readers computed |7.9 - 7.9| = 0 here.
  assert(Math.abs(signedOverallError(g) - 0.3) < 1e-9);
  const f = signedFactorErrors(g);
  assertEquals(f.fabric_condition, 1.0); // + = the AI was too harsh
  assertEquals(f.structural_integrity, 0);
});

Deno.test("an approval is zero error, and the untouched report stands in for the AI factors", () => {
  const r = reports([["g1", { overall_score: AI_OVERALL, ...AI }]]);
  const [g] = buildReviewedGrades([{
    grade_report_id: "g1",
    original_score: AI_OVERALL,
    adjusted_score: null,
    reviewed_at: "2026-09-10T10:00:00Z",
    review_action: "approve",
    // No snapshot: a pre-00784 approval. The report was never overwritten,
    // so it still IS the AI's output.
  }], r);
  assertEquals(signedOverallError(g), 0);
  assert(g.aiFactors !== null);
  assertEquals(Object.values(signedFactorErrors(g)), [0, 0, 0, 0, 0]);
});

Deno.test("a legacy ADJUSTED grade keeps its overall error and admits its factors are lost", () => {
  const r = reports([["g1", { overall_score: 8.2, ...AI, fabric_condition_score: 9.0 }]]);
  const [g] = buildReviewedGrades([{
    grade_report_id: "g1",
    original_score: AI_OVERALL,
    adjusted_score: 8.2,
    reviewed_at: "2026-08-01T10:00:00Z",
    // Written before 00784: no snapshot, no review_action.
  }], r);
  assert(Math.abs(signedOverallError(g) - 0.6) < 1e-9);
  // Unknown, never "unchanged": the adjustment overwrote the only copy.
  assertEquals(g.aiFactors, null);
  assertEquals(Object.values(signedFactorErrors(g)), [null, null, null, null, null]);
});

Deno.test("a send-back is not a verdict and is left out entirely", () => {
  const r = reports([["g1", { overall_score: AI_OVERALL, ...AI }]]);
  const out = buildReviewedGrades([{
    grade_report_id: "g1",
    original_score: AI_OVERALL,
    adjusted_score: null,
    reviewed_at: "2026-09-10T10:00:00Z",
    review_action: "send_back",
    ...snapshotOf(AI),
  }], r);
  // Before US-3323 this counted as an approval: "the AI was right".
  assertEquals(out.length, 0);
});

Deno.test("two reviews on one grade: the AI side is the EARLIEST snapshot, whatever the input order", () => {
  const first = { ...AI };
  const afterAdjust = { ...AI, cosmetic_appearance_score: 6.5 };
  const r = reports([["g1", { overall_score: 6.9, ...afterAdjust, fabric_condition_score: 6.0 }]]);
  const adjust: ReviewBaselineRow = {
    grade_report_id: "g1",
    original_score: AI_OVERALL,
    adjusted_score: 7.4,
    reviewed_at: "2026-09-01T10:00:00Z",
    review_action: "adjust",
    ...snapshotOf(first),
  };
  const dispute: ReviewBaselineRow = {
    grade_report_id: "g1",
    original_score: 7.4,
    adjusted_score: 6.9,
    reviewed_at: "2026-09-05T10:00:00Z",
    review_action: "dispute",
    ...snapshotOf(afterAdjust),
  };
  // Readers query newest-first, so the helper must not trust input order.
  for (const rows of [[adjust, dispute], [dispute, adjust]]) {
    const [g] = buildReviewedGrades(rows, r);
    assertEquals(g.aiOverall, AI_OVERALL);
    assertEquals(g.humanOverall, 6.9);
    assertEquals(g.reviewCount, 2);
    assertEquals(g.latest.review_action, "dispute");
    assertEquals(signedFactorErrors(g).fabric_condition, -1.0); // too lenient
  }
});

Deno.test("a review whose report is gone is skipped; one entry per grade", () => {
  const r = reports([["g1", { overall_score: AI_OVERALL, ...AI }]]);
  const out = buildReviewedGrades([
    { grade_report_id: "g1", original_score: AI_OVERALL, adjusted_score: null, reviewed_at: "2026-09-10T10:00:00Z" },
    { grade_report_id: "g1", original_score: AI_OVERALL, adjusted_score: null, reviewed_at: "2026-09-10T11:00:00Z" },
    { grade_report_id: "gone", original_score: 5, adjusted_score: 6, reviewed_at: "2026-09-10T10:00:00Z" },
  ], r);
  assertEquals(out.map((g) => g.gradeReportId), ["g1"]);
});

Deno.test("PostgREST numeric strings are read as numbers", () => {
  const r = reports([["g1", { overall_score: "7.9", ...AI, fabric_condition_score: "8.0" }]]);
  const [g] = buildReviewedGrades([{
    grade_report_id: "g1",
    original_score: "7.6",
    adjusted_score: "7.9",
    reviewed_at: "2026-09-10T10:00:00Z",
    original_fabric_condition: "7.0",
    original_structural_integrity: "8.0",
    original_cosmetic_appearance: "7.5",
    original_functional_elements: "8.0",
    original_odor_cleanliness: "8.0",
  }], r);
  assertEquals(signedFactorErrors(g).fabric_condition, 1.0);
});

Deno.test("reviewSnapshot copies the report's five factors as found", () => {
  assertEquals(reviewSnapshot({ overall_score: AI_OVERALL, ...AI }), snapshotOf(AI));
});

// ── Source guards: the write side and the read side both have to hold ──────

const SRC = new URL("../", import.meta.url);
function read(rel: string): string {
  return Deno.readTextFileSync(new URL(rel, SRC)).replace(/\r\n/g, "\n");
}
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

Deno.test("every human_reviews insert records the snapshot and the review path", () => {
  const files = ["routes/admin-grading.ts", "routes/admin-disputes.ts"];
  let inserts = 0;
  for (const f of files) {
    const src = stripComments(read(f));
    const re = /\.from\("human_reviews"\)\.insert\(\{([\s\S]*?)\}\);/g;
    for (const m of src.matchAll(re)) {
      inserts++;
      const body = m[1];
      assert(body.includes("...reviewSnapshot(report)"), `${f}: an insert without the AI snapshot`);
      assert(/review_action: "(approve|adjust|send_back|dispute)"/.test(body), `${f}: an insert without review_action`);
    }
  }
  // approve, adjust, send-back, dispute. A fifth path must be added here on purpose.
  assertEquals(inserts, 4);
});

Deno.test("no accuracy reader compares the report's CURRENT score with the human's", () => {
  const readers = [
    "lib/accuracy-tracking.ts",
    "lib/defect-accuracy.ts",
    "lib/few-shot-exemplars.ts",
    "routes/jobs-confidence-calibration.ts",
  ];
  const forbidden = [
    /Math\.abs\(\s*report\.overall_score\s*-/,
    /humanFinal\s*-\s*report\.overall_score/,
    /ai_overall_score:\s*report\.overall_score/,
  ];
  for (const f of readers) {
    const src = stripComments(read(f));
    assert(src.includes("buildReviewedGrades("), `${f} no longer goes through buildReviewedGrades`);
    for (const re of forbidden) {
      assert(!re.test(src), `${f} matches ${re}: the report's score is the HUMAN's after an adjustment`);
    }
  }
});
