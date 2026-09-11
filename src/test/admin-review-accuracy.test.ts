// US-3323: the admin AI Models console must report the error a reviewer
// actually found, not zero.
//
// THE DEFECT. applyGradeAdjustment (services/edge-functions/src/lib/
// grade-adjustment.ts) writes the reviewer's correction over
// grade_reports.overall_score and the five factor columns. The accuracy block
// on /admin/ai-models then read `report.overall_score` as "the AI's grade" and
// compared it with `review.adjusted_score ?? review.original_score`, which
// after an adjustment is THE SAME NUMBER. Every corrected grade scored a
// perfect 0.00 error, so the page reported the AI as most accurate exactly
// where a human had just overruled it, and the "Accuracy Below Threshold"
// banner could never fire.
//
// The AI side has to come from the review row's own snapshot: each review
// records the report as it FOUND it (`original_score`, and since migration
// 00784 the five `original_*` factors). The human side is the report's current
// state. Two different objects, so a real difference can exist.
//
// Mirrors services/edge-functions/src/lib/review-baseline.ts; the parity of the
// two is guarded in admin-review-accuracy-mirror.test.ts.
import { describe, expect, it } from "vitest";
import {
  type AccuracyReportRow,
  type AccuracyReviewRow,
  computeVersionAccuracy,
  isSendBack,
} from "@/lib/review-accuracy";

// One garment the AI graded 8.0 and a reviewer corrected to 6.5. The report row
// below is what the DB holds AFTER applyGradeAdjustment: the human's numbers.
const ADJUSTED_REPORT: AccuracyReportRow = {
  id: "report-adjusted",
  model_version: "v3",
  overall_score: 6.5,
  fabric_condition_score: 6.0,
  structural_integrity_score: 6.5,
  cosmetic_appearance_score: 6.5,
  functional_elements_score: 7.0,
  odor_cleanliness_score: 7.0,
};

// A grade the reviewer approved untouched. AI and human agree for real.
const APPROVED_REPORT: AccuracyReportRow = {
  id: "report-approved",
  model_version: "v3",
  overall_score: 7.0,
  fabric_condition_score: 7.0,
  structural_integrity_score: 7.0,
  cosmetic_appearance_score: 7.0,
  functional_elements_score: 7.0,
  odor_cleanliness_score: 7.0,
};

// Photos too poor to grade. Not a verdict on the AI either way.
const SENT_BACK_REPORT: AccuracyReportRow = {
  id: "report-sent-back",
  model_version: "v3",
  overall_score: 5.0,
  fabric_condition_score: 5.0,
  structural_integrity_score: 5.0,
  cosmetic_appearance_score: 5.0,
  functional_elements_score: 5.0,
  odor_cleanliness_score: 5.0,
};

const ADJUST_REVIEW: AccuracyReviewRow = {
  grade_report_id: "report-adjusted",
  reviewed_at: "2026-09-01T10:00:00Z",
  review_action: "adjust",
  // What the reviewer FOUND — the AI's own grade.
  original_score: 8.0,
  original_fabric_condition: 8.0,
  original_structural_integrity: 8.0,
  original_cosmetic_appearance: 8.0,
  original_functional_elements: 8.0,
  original_odor_cleanliness: 8.0,
  // What the reviewer decided.
  adjusted_score: 6.5,
};

const APPROVE_REVIEW: AccuracyReviewRow = {
  grade_report_id: "report-approved",
  reviewed_at: "2026-09-01T11:00:00Z",
  review_action: "approve",
  original_score: 7.0,
  original_fabric_condition: 7.0,
  original_structural_integrity: 7.0,
  original_cosmetic_appearance: 7.0,
  original_functional_elements: 7.0,
  original_odor_cleanliness: 7.0,
  adjusted_score: null,
};

const SEND_BACK_REVIEW: AccuracyReviewRow = {
  grade_report_id: "report-sent-back",
  reviewed_at: "2026-09-01T12:00:00Z",
  review_action: "send_back",
  original_score: 5.0,
  original_fabric_condition: 5.0,
  original_structural_integrity: 5.0,
  original_cosmetic_appearance: 5.0,
  original_functional_elements: 5.0,
  original_odor_cleanliness: 5.0,
  adjusted_score: null,
};

const REPORTS = new Map<string, AccuracyReportRow>([
  [ADJUSTED_REPORT.id, ADJUSTED_REPORT],
  [APPROVED_REPORT.id, APPROVED_REPORT],
  [SENT_BACK_REPORT.id, SENT_BACK_REPORT],
]);

function v3(rows: AccuracyReviewRow[]) {
  const out = computeVersionAccuracy(rows, REPORTS);
  const found = out.find((v) => v.versionName === "v3");
  expect(found, "no v3 group produced").toBeTruthy();
  return found!;
}

describe("US-3323 — a corrected grade reports its real error", () => {
  it("a 1.5-point correction is 1.5 points of error, not zero", () => {
    const v = v3([ADJUST_REVIEW]);
    // The reviewer moved this grade from 8.0 to 6.5. Anything less than 1.5
    // means the AI side and the human side are the same object again.
    expect(v.meanAbsoluteError).toBeCloseTo(1.5, 6);
    expect(v.agreementRate).toBe(0);
  });

  it("the sign says which way the AI is wrong", () => {
    // human - AI = 6.5 - 8.0. Negative: the AI graded this garment too LENIENT.
    expect(v3([ADJUST_REVIEW]).meanSignedError).toBeCloseTo(-1.5, 6);
  });

  it("a genuine approval still reads as zero error", () => {
    const v = v3([APPROVE_REVIEW]);
    expect(v.meanAbsoluteError).toBe(0);
    expect(v.agreementRate).toBe(1);
  });

  it("mixes a correction and an approval into a real average", () => {
    const v = v3([ADJUST_REVIEW, APPROVE_REVIEW]);
    expect(v.totalReviews).toBe(2);
    expect(v.meanAbsoluteError).toBeCloseTo(0.75, 6);
    expect(v.meanSignedError).toBeCloseTo(-0.75, 6);
    expect(v.agreementRate).toBeCloseTo(0.5, 6);
  });

  it("per-factor error is the measured difference, not a scaled guess", () => {
    const v = v3([ADJUST_REVIEW]);
    const byFactor = new Map(v.factorAccuracies.map((f) => [f.factor, f]));
    // fabric: human 6.0 vs AI 8.0.
    expect(byFactor.get("fabric_condition")!.mae).toBeCloseTo(2.0, 6);
    expect(byFactor.get("fabric_condition")!.meanSignedError).toBeCloseTo(-2.0, 6);
    // functional: human 7.0 vs AI 8.0.
    expect(byFactor.get("functional_elements")!.mae).toBeCloseTo(1.0, 6);
    expect(byFactor.get("functional_elements")!.count).toBe(1);
  });

  it("send-backs are excluded, not counted as agreement", () => {
    expect(isSendBack(SEND_BACK_REVIEW)).toBe(true);
    const v = v3([ADJUST_REVIEW, SEND_BACK_REVIEW]);
    // Only the adjustment is a verdict on the grade.
    expect(v.totalReviews).toBe(1);
    expect(v.meanAbsoluteError).toBeCloseTo(1.5, 6);
  });

  it("a pre-00784 adjustment keeps its overall error and drops its factors", () => {
    // Legacy row: original_score survived, the original_* factors never existed.
    const legacy: AccuracyReviewRow = {
      grade_report_id: "report-adjusted",
      reviewed_at: "2026-01-01T00:00:00Z",
      review_action: null,
      original_score: 8.0,
      adjusted_score: 6.5,
    };
    const v = v3([legacy]);
    expect(v.meanAbsoluteError).toBeCloseTo(1.5, 6);
    // Unknown must never read as "unchanged" — that is the same zero-error lie
    // one level down. The factor carries no sample at all.
    for (const f of v.factorAccuracies) {
      expect(f.count, `${f.factor} invented a sample it does not have`).toBe(0);
    }
  });

  it("a never-adjusted grade may use the report as its own AI factors", () => {
    const v = v3([{ ...APPROVE_REVIEW, original_fabric_condition: undefined }]);
    const fabric = v.factorAccuracies.find((f) => f.factor === "fabric_condition")!;
    // Nothing overwrote this report, so its columns still are the AI's.
    expect(fabric.count).toBe(1);
    expect(fabric.mae).toBe(0);
  });

  it("the newest review is the human answer, the oldest is the AI baseline", () => {
    // Adjusted to 6.5, then a second reviewer approved that. The AI side must
    // stay 8.0 — not the 6.5 the second review found.
    const second: AccuracyReviewRow = {
      grade_report_id: "report-adjusted",
      reviewed_at: "2026-09-02T09:00:00Z",
      review_action: "approve",
      original_score: 6.5,
      original_fabric_condition: 6.0,
      original_structural_integrity: 6.5,
      original_cosmetic_appearance: 6.5,
      original_functional_elements: 7.0,
      original_odor_cleanliness: 7.0,
      adjusted_score: null,
    };
    const v = v3([second, ADJUST_REVIEW]); // newest-first, as the query returns
    expect(v.totalReviews).toBe(1); // one GRADE, not two review rows
    expect(v.meanAbsoluteError).toBeCloseTo(1.5, 6);
  });
});
