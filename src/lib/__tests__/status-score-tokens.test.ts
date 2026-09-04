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
    //
    // ⚠ THESE BOUNDARIES DISAGREE WITH THE DESIGN SYSTEM AND WITH BOTH PHONES,
    // and this test is what makes that hard to notice (US-3010).
    //
    // ⚠ THIS BLOCK USED TO PIN A KNOWN DIVERGENCE. It is now a settled rule,
    // and the previous comment - warning that anyone correcting the ladder
    // would hit a red test reading like they broke something - can go.
    //
    // The owner decided on 2026-09-04 (US-3010 AC6) that 7.0 to 9.4 is GREEN.
    // vault §3B was amended from four bands to three, and iOS and Android both
    // dropped the Steel Navy band to match this file rather than the other way
    // round. Three clients now agree.
    //
    // AND THE 7.0 BOUNDARY MOVED WITH IT. This line used to assert amber,
    // because the ladder tested `> 7`. GRADE_TIER_BANDS calls 7.0 the floor of
    // "Very Good", so that put one tier in two colours and painted a 7.0 the
    // same as a 5.0 "Fair". Emerald at exactly 7.0 is the point of the change,
    // not a side effect of it - leaving `> 7` would have swapped the old
    // cross-client disagreement for a new one at exactly this value.
    expect(getScoreColor(7)).toBe("text-emerald-500");
    expect(getScoreColor(6.9)).toBe("text-amber-500");
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
