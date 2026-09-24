import { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SUBMISSION_STATUS_TONE,
  getProgressColor,
  getScoreBorderColor,
  getScoreColor,
  getTierBadgeClasses,
} from "@/lib/constants";
import { SUBMISSION_STAGE_COPY } from "@/lib/grading-journey";
import { LIST_STATUS_FILTERS, readListParams } from "@/lib/submissions-list-params";
import { ScoreBandIcon } from "@/components/grade/score-indicator";
import { SubmissionStatusBadge } from "@/components/submission/submission-status-badge";
import type { SubmissionStatus } from "@/types/database";

// SUB-13: one status badge and one score threshold across list and detail.

// SUBMISSION_STAGE_COPY is typed Record<SubmissionStatus, ...>, so its keys
// are every status the type knows.
const ALL_STATUSES = Object.keys(SUBMISSION_STAGE_COPY) as SubmissionStatus[];

function render(node: React.ReactNode): HTMLDivElement {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const el = document.createElement("div");
  const root = createRoot(el);
  act(() => root.render(node));
  return el;
}

describe("every submission status has a tone", () => {
  it("covers the whole type, needs_photos included", () => {
    expect(ALL_STATUSES).toContain("needs_photos");
    for (const s of ALL_STATUSES) {
      expect(SUBMISSION_STATUS_TONE[s], `${s} has no tone`).toBeTruthy();
    }
    // It waits on the seller, so it must not look like a dispute.
    expect(SUBMISSION_STATUS_TONE.needs_photos).not.toBe(SUBMISSION_STATUS_TONE.disputed);
  });

  it("expired can be filtered on the list", () => {
    expect(LIST_STATUS_FILTERS).toContain("expired");
    expect(readListParams(new URLSearchParams("status=expired")).status).toBe("expired");
  });

  it("the badge names the stage and explains it", () => {
    const el = render(<SubmissionStatusBadge status="disputed" />);
    const span = el.querySelector("span")!;
    expect(span.textContent).toBe(SUBMISSION_STAGE_COPY.disputed.label);
    expect(span.getAttribute("title")).toBe(SUBMISSION_STAGE_COPY.disputed.meaning);
  });

  it("both pages use it and neither hand-rolls a status map", () => {
    for (const f of ["src/pages/submissions.tsx", "src/pages/submission-detail.tsx"]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).toContain("<SubmissionStatusBadge status=");
      expect(src, f).not.toContain("function formatLabel(");
    }
    const detail = readFileSync("src/pages/submission-detail.tsx", "utf8");
    expect(detail).not.toContain('submission.status === "needs_photos" &&\n                "border-amber');
  });
});

describe("one score threshold", () => {
  const band = (score: number) => {
    const text = getScoreColor(score);
    return text.includes("emerald") ? "high" : text.includes("amber") ? "mid" : "low";
  };

  for (const [score, expected] of [
    [7.0, "high"],
    [6.9, "mid"],
    [5.0, "mid"],
    [4.9, "low"],
  ] as const) {
    it(`${score.toFixed(1)} is ${expected} in every helper`, () => {
      expect(band(score)).toBe(expected);
      const colour = expected === "high" ? "emerald" : expected === "mid" ? "amber" : "red|rose";
      const re = new RegExp(colour);
      expect(getScoreBorderColor(score)).toMatch(re);
      expect(getProgressColor(score)).toMatch(re);
      expect(getTierBadgeClasses(score)).toMatch(re);
      const label = render(<ScoreBandIcon score={score} />).textContent;
      expect(label).toBe(
        expected === "high"
          ? "Strong condition"
          : expected === "mid"
            ? "Moderate condition"
            : "Low condition",
      );
    });
  }

  it("score text clears contrast: -700 light, -400 dark", () => {
    expect(getScoreColor(8)).toBe("text-emerald-700 dark:text-emerald-400");
    expect(getScoreColor(6)).toBe("text-amber-700 dark:text-amber-400");
  });

  it("the detail ring uses the shared helper", () => {
    const src = readFileSync("src/pages/submission-detail.tsx", "utf8");
    expect(src).toContain("getScoreBorderColor(gradeReport.overall_score)");
    expect(src).not.toContain("gradeReport.overall_score > 7");
  });
});
