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
    // vault/20-domain/brand-design-system.md §3B defines FOUR bands: Emerald
    // >= 9.5, Steel Navy 7.0-9.0, Amber 5.0-6.5, Crimson < 5. The web has
    // three and no Steel Navy at all, so every grade from 7.0 to 9.4 is GREEN
    // here and NAVY on iOS and Android - and GradeColor.kt calls that "the
    // ordinary band, most resale garments land there". Same garment, different
    // colour per device.
    //
    // It was never decided: US-605 CONSOLIDATED this ladder from code
    // "copy-pasted in 6+ files" onto "the media-kit emerald/amber/brand-red
    // palette" - three colours, no navy - so the shape came in from the copies.
    // Nothing in vault/ mentions getScoreColor.
    //
    // The assertion below is the trap. `getScoreColor(7.5) === emerald` is
    // squarely inside §3B's Steel Navy band, so anyone correcting the ladder
    // hits a red test that reads like they broke something. Left GREEN on
    // purpose rather than changed: which side is authoritative - the web gains
    // a navy band, or §3B becomes three - is a brand decision and US-3010
    // carries it. This comment exists so the next reader knows the test is
    // pinning a known divergence rather than a settled rule.
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
