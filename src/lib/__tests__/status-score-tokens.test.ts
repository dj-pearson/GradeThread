import { describe, it, expect } from "vitest";
import {
  getScoreColor,
  getScoreBorderColor,
  getProgressColor,
  getTierBadgeClasses,
  getStatusBadgeClasses,
  SUBMISSION_STATUS_TONE,
  STATUS_TONE_CLASSES,
} from "@/lib/constants";

// These centralized tokens are the single source of grade-score / status
// coloring (US-605). The tests pin the three score bands and prove submission
// statuses resolve through the shared tone scale, so a palette change here
// stays consistent across every page that imports them.

describe("score color tokens", () => {
  it("colors high / mid / low score bands distinctly", () => {
    expect(getScoreColor(8)).toBe("text-emerald-500");
    expect(getScoreColor(6)).toBe("text-amber-500");
    expect(getScoreColor(3)).toBe("text-brand-red-text");
  });

  it("uses the 7 and 5 boundaries consistently across helpers", () => {
    // > 7 is "high", [5, 7] is "mid", < 5 is "low"
    expect(getScoreColor(7)).toBe("text-amber-500");
    expect(getScoreColor(7.5)).toBe("text-emerald-500");
    expect(getScoreColor(5)).toBe("text-amber-500");
    expect(getScoreColor(4.5)).toBe("text-brand-red-text");

    expect(getScoreBorderColor(9)).toContain("emerald");
    expect(getProgressColor(9)).toBe("[&>div]:bg-emerald-500");
    expect(getTierBadgeClasses(3)).toContain("rose");
  });
});

describe("submission status badge tokens", () => {
  it("maps every submission status to a defined tone class", () => {
    for (const [status, tone] of Object.entries(SUBMISSION_STATUS_TONE)) {
      expect(getStatusBadgeClasses(status)).toBe(STATUS_TONE_CLASSES[tone]);
    }
  });

  it("returns an empty string for unknown statuses", () => {
    expect(getStatusBadgeClasses("not-a-status")).toBe("");
  });
});
