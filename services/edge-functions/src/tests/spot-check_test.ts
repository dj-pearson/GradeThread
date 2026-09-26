// US-3524: blind spot checks on auto-approved grades.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { shouldSpotCheck, spotCheckRate } from "../lib/spot-check.ts";
import {
  buildReviewedGrades,
  signedOverallError,
} from "../lib/review-baseline.ts";
import { blindSummary } from "../lib/accuracy-tracking.ts";

const AI = {
  original_fabric_condition: 9,
  original_structural_integrity: 9,
  original_cosmetic_appearance: 9,
  original_functional_elements: 9,
  original_odor_cleanliness: 9,
};
const REPORT = {
  overall_score: 9.0,
  fabric_condition_score: 9,
  structural_integrity_score: 9,
  cosmetic_appearance_score: 9,
  functional_elements_score: 9,
  odor_cleanliness_score: 9,
};

Deno.test("US-3524: the sample rate defaults to 3%, clamps, and 0 turns it off", () => {
  assertEquals(spotCheckRate(undefined), 0.03);
  assertEquals(spotCheckRate(""), 0.03);
  assertEquals(spotCheckRate("0.1"), 0.1);
  assertEquals(spotCheckRate("7"), 1);
  assertEquals(spotCheckRate("-1"), 0);
  assertEquals(spotCheckRate("nope"), 0.03);
  assertEquals(shouldSpotCheck(0, () => 0), false);
  assertEquals(shouldSpotCheck(0.03, () => 0.02), true);
  assertEquals(shouldSpotCheck(0.03, () => 0.5), false);
});

Deno.test("US-3524: a spot check's human answer is its blind score, not the unchanged report", () => {
  const [g] = buildReviewedGrades(
    [{
      grade_report_id: "r1",
      original_score: 9.0,
      adjusted_score: 7.6,
      review_action: "spot_check",
      reviewed_at: "2026-09-26T10:00:00Z",
      ...AI,
    }],
    new Map([["r1", REPORT]]),
  );
  assert(g);
  assertEquals(g.blind, true);
  assertEquals(g.aiOverall, 9.0);
  assertEquals(g.humanOverall, 7.6);
  assertEquals(Number(signedOverallError(g).toFixed(1)), -1.4);
  assertEquals(g.humanFactors, null);
});

Deno.test("US-3524: an ordinary review is not blind and still reads the report", () => {
  const [g] = buildReviewedGrades(
    [{
      grade_report_id: "r2",
      original_score: 8.0,
      adjusted_score: null,
      review_action: "approve",
      ...AI,
    }],
    new Map([["r2", { ...REPORT, overall_score: 8.0 }]]),
  );
  assertEquals(g!.blind, false);
  assertEquals(g!.humanOverall, 8.0);
});

Deno.test("US-3524: blind accuracy counts only blind grades", () => {
  const s = blindSummary([
    { blind: true, aiOverall: 9.0, humanOverall: 7.6 },
    { blind: true, aiOverall: 8.0, humanOverall: 8.2 },
    { blind: false, aiOverall: 5.0, humanOverall: 9.0 },
  ]);
  assertEquals(s.count, 2);
  assertEquals(Number(s.mean_absolute_error.toFixed(2)), 0.8);
  assertEquals(s.agreement_rate, 0.5);
  assertEquals(Number(s.mean_signed_error.toFixed(2)), -0.6);
  assertEquals(blindSummary([]).count, 0);
});

Deno.test("US-3524: the list route never returns a score, and the pipeline samples only auto-approvals", async () => {
  const routes = await Deno.readTextFile(
    new URL("../routes/admin-grading.ts", import.meta.url),
  );
  const list = routes.slice(
    routes.indexOf('adminGradingRoutes.get("/spot-checks"'),
    routes.indexOf('adminGradingRoutes.post("/spot-checks/:id"'),
  );
  for (
    const leak of [
      "overall_score",
      "grade_tier",
      "confidence",
      "ai_summary",
      "defects",
    ]
  ) {
    assert(!list.includes(leak), `list route must not read ${leak}`);
  }
  const pipe = await Deno.readTextFile(
    new URL("../lib/grading-pipeline.ts", import.meta.url),
  );
  const auto = pipe.indexOf(
    "await finalizeGradeReview(gradeReport.id, { reviewerId: null, modified: false });",
  );
  const sample = pipe.indexOf(
    "if (shouldSpotCheck()) void requestSpotCheck(gradeReport.id);",
  );
  assert(auto > 0 && sample > auto && sample - auto < 400);
});
