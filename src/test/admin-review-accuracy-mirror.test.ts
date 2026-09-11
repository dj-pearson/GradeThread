// US-3323: the two copies of the AI-vs-human baseline rule must agree.
//
// services/edge-functions/src/lib/review-baseline.ts decides the AI side and
// the human side for every SERVER accuracy reader (computeAccuracySummary, the
// confidence-calibration cron, the defect-bias report, the exemplar miner, the
// training export). src/lib/review-accuracy.ts is the same rule for the browser
// console on /admin/ai-models, which computes its own per-version numbers from
// a direct supabase read.
//
// The web copy cannot import the edge one: a page importing across
// services/edge-functions/ breaks `tsc -b` and drags edge code into the client
// bundle. So it is a mirror, and a mirror with nothing enforcing it drifts. If
// these two disagree, /admin/ai-models and the accuracy panel BELOW IT ON THE
// SAME PAGE print different errors for the same garments, and there is no way
// to tell which one is lying.
//
// This compares BEHAVIOUR, not text: the same fixtures go through both and the
// answers must match. The edge module is pure with no imports, which is what
// makes it loadable here at all.
//
// It is loaded through import.meta.glob rather than a plain `import` ON PURPOSE.
// A static import pulls services/edge-functions/ into the WEB tsconfig program,
// where `noUncheckedIndexedAccess` is on and Deno's is not, so `tsc -b` starts
// reporting the edge file's array indexing as errors — this test would have
// made the web build's type-check depend on edge source. The glob is resolved
// by Vite at runtime and typed as `unknown`, so the coupling stays behavioural.
import { beforeAll, describe, expect, it } from "vitest";
import * as web from "@/lib/review-accuracy";

const EDGE_PATH = "../../services/edge-functions/src/lib/review-baseline.ts";

interface EdgeModule {
  REVIEW_FACTOR_KEYS: readonly string[];
  isSendBack: (r: unknown) => boolean;
  buildReviewedGrades: (
    reviews: readonly unknown[],
    reports: ReadonlyMap<string, unknown>,
  ) => ComparableGrade[];
  signedOverallError: (g: never) => number;
  signedFactorErrors: (g: never) => Record<string, number | null>;
}

let edge: EdgeModule;

beforeAll(async () => {
  const loaders = import.meta.glob(
    "../../services/edge-functions/src/lib/review-baseline.ts",
  );
  const load = Object.entries(loaders).find(([k]) => k.endsWith("review-baseline.ts"))?.[1];
  // A missing module must FAIL, not silently skip: a parity test that quietly
  // stops loading one side is indistinguishable from a passing one.
  expect(load, `edge module not found at ${EDGE_PATH}`).toBeTruthy();
  edge = (await load!()) as EdgeModule;
  expect(typeof edge.buildReviewedGrades, "edge module has no buildReviewedGrades")
    .toBe("function");
});

type Row = web.AccuracyReviewRow;

const REPORTS = {
  adjusted: {
    id: "r-adjusted",
    overall_score: 6.5,
    fabric_condition_score: 6.0,
    structural_integrity_score: 6.5,
    cosmetic_appearance_score: 6.5,
    functional_elements_score: 7.0,
    odor_cleanliness_score: 7.0,
  },
  approved: {
    id: "r-approved",
    overall_score: 7.0,
    fabric_condition_score: 7.0,
    structural_integrity_score: 7.0,
    cosmetic_appearance_score: 7.0,
    functional_elements_score: 7.0,
    odor_cleanliness_score: 7.0,
  },
  // Pre-00784 shape: the factor columns exist, the review snapshot does not.
  legacy: {
    id: "r-legacy",
    overall_score: 4.0,
    fabric_condition_score: 4.0,
    structural_integrity_score: 4.0,
    cosmetic_appearance_score: 4.0,
    functional_elements_score: 4.0,
    odor_cleanliness_score: 4.0,
  },
  // A report whose factors never landed — both copies must refuse to invent them.
  partial: {
    id: "r-partial",
    overall_score: 8.0,
    fabric_condition_score: 8.0,
    structural_integrity_score: null,
    cosmetic_appearance_score: 8.0,
    functional_elements_score: 8.0,
    odor_cleanliness_score: 8.0,
  },
};

const REPORT_MAP = new Map(Object.values(REPORTS).map((r) => [r.id, r]));

const snapshot = (v: number) => ({
  original_fabric_condition: v,
  original_structural_integrity: v,
  original_cosmetic_appearance: v,
  original_functional_elements: v,
  original_odor_cleanliness: v,
});

// Each case is a set of review rows exercising one edge of the rule.
const CASES: Record<string, Row[]> = {
  "a plain adjustment": [
    {
      grade_report_id: "r-adjusted",
      reviewed_at: "2026-09-01T10:00:00Z",
      review_action: "adjust",
      original_score: 8.0,
      ...snapshot(8.0),
      adjusted_score: 6.5,
    },
  ],
  "an approval": [
    {
      grade_report_id: "r-approved",
      reviewed_at: "2026-09-01T10:00:00Z",
      review_action: "approve",
      original_score: 7.0,
      ...snapshot(7.0),
      adjusted_score: null,
    },
  ],
  "a send-back": [
    {
      grade_report_id: "r-approved",
      reviewed_at: "2026-09-01T10:00:00Z",
      review_action: "send_back",
      original_score: 7.0,
      ...snapshot(7.0),
      adjusted_score: null,
    },
  ],
  "two reviews of one grade, newest first": [
    {
      grade_report_id: "r-adjusted",
      reviewed_at: "2026-09-02T09:00:00Z",
      review_action: "approve",
      original_score: 6.5,
      ...snapshot(6.5),
      adjusted_score: null,
    },
    {
      grade_report_id: "r-adjusted",
      reviewed_at: "2026-09-01T10:00:00Z",
      review_action: "adjust",
      original_score: 8.0,
      ...snapshot(8.0),
      adjusted_score: 6.5,
    },
  ],
  "a legacy adjustment with no snapshot": [
    {
      grade_report_id: "r-legacy",
      reviewed_at: "2026-01-01T00:00:00Z",
      review_action: null,
      original_score: 6.0,
      adjusted_score: 4.0,
    },
  ],
  "a legacy approval with no snapshot": [
    {
      grade_report_id: "r-legacy",
      reviewed_at: "2026-01-01T00:00:00Z",
      review_action: null,
      original_score: 4.0,
      adjusted_score: null,
    },
  ],
  "a report missing a factor column": [
    {
      grade_report_id: "r-partial",
      reviewed_at: "2026-09-01T10:00:00Z",
      review_action: "approve",
      original_score: 8.0,
      adjusted_score: null,
    },
  ],
  "numeric columns arriving as postgrest strings": [
    {
      grade_report_id: "r-adjusted",
      reviewed_at: "2026-09-01T10:00:00Z",
      review_action: "adjust",
      original_score: "8.0",
      original_fabric_condition: "8.0",
      original_structural_integrity: "8.0",
      original_cosmetic_appearance: "8.0",
      original_functional_elements: "8.0",
      original_odor_cleanliness: "8.0",
      adjusted_score: "6.5",
    },
  ],
  "a review whose report is missing": [
    {
      grade_report_id: "r-nowhere",
      reviewed_at: "2026-09-01T10:00:00Z",
      review_action: "adjust",
      original_score: 8.0,
      ...snapshot(8.0),
      adjusted_score: 6.5,
    },
  ],
  "no reviews at all": [],
};

interface ComparableGrade {
  gradeReportId: string;
  aiOverall: number;
  humanOverall: number;
  aiFactors: Record<string, number> | null;
  humanFactors: Record<string, number> | null;
  everAdjusted: boolean;
}

/** The fields both copies carry, in a stable shape. */
function comparable(
  grades: ComparableGrade[],
  signedOverall: (g: never) => number,
  signedFactors: (g: never) => Record<string, number | null>,
) {
  return grades
    .map((g) => ({
      gradeReportId: g.gradeReportId,
      aiOverall: g.aiOverall,
      humanOverall: g.humanOverall,
      aiFactors: g.aiFactors,
      humanFactors: g.humanFactors,
      everAdjusted: g.everAdjusted,
      signedOverall: signedOverall(g as never),
      signedFactors: signedFactors(g as never),
    }))
    .sort((a, b) => a.gradeReportId.localeCompare(b.gradeReportId));
}

describe("review-baseline edge/web mirror", () => {
  it.each(Object.keys(CASES))("agrees on: %s", (name) => {
    const rows = CASES[name]!;
    const e = comparable(
      edge.buildReviewedGrades(rows, REPORT_MAP),
      edge.signedOverallError,
      edge.signedFactorErrors,
    );
    const w = comparable(
      web.buildReviewedGrades(rows, REPORT_MAP),
      web.signedOverallError,
      web.signedFactorErrors,
    );
    expect(w).toEqual(e);
  });

  it("the fixtures actually exercise the rule", () => {
    // A guard on the guard: if every case collapsed to an empty result, the
    // comparison above would pass while testing nothing. Three of these cases
    // are deliberately empty (send-back, missing report, no reviews), so a real
    // run must still produce grades from the rest.
    const produced = Object.values(CASES).flatMap((rows) =>
      web.buildReviewedGrades(rows, REPORT_MAP)
    );
    expect(produced.length).toBeGreaterThanOrEqual(6);
    // And at least one must have a real, non-zero error, or "both said zero"
    // would be the thing being asserted equal.
    expect(produced.some((g) => web.signedOverallError(g) !== 0)).toBe(true);
    // And at least one must have lost its AI factors, which is the case the
    // two copies are most likely to disagree on.
    expect(produced.some((g) => g.aiFactors === null)).toBe(true);
  });

  it("both copies name the same five factors, in the same order", () => {
    expect([...web.REVIEW_FACTOR_KEYS]).toEqual([...edge.REVIEW_FACTOR_KEYS]);
  });

  it("both copies recognise a send-back by the same value", () => {
    const row = { grade_report_id: "x", original_score: 1, adjusted_score: null };
    for (const action of ["send_back", "approve", "adjust", "dispute", null]) {
      const r = { ...row, review_action: action } as Row;
      expect(web.isSendBack(r), `disagreed on review_action=${action}`)
        .toBe(edge.isSendBack(r));
    }
  });
});
