import { describe, it, expect } from "vitest";
import {
  chainStrength,
  confidenceInfo,
  confidenceLevelOf,
  CONFIDENCE_TAXONOMY,
} from "@/lib/passport-confidence";

describe("passport confidence taxonomy (US-1102)", () => {
  it("coerces any value to one of exactly three levels", () => {
    expect(confidenceLevelOf("deterministic")).toBe("deterministic");
    expect(confidenceLevelOf("probable")).toBe("probable");
    expect(confidenceLevelOf("unknown")).toBe("unknown");
    expect(confidenceLevelOf("garbage")).toBe("unknown");
    expect(confidenceLevelOf(null)).toBe("unknown");
    expect(confidenceLevelOf(undefined)).toBe("unknown");
  });

  it("every level has a label + a measured tooltip", () => {
    for (const level of ["deterministic", "probable", "unknown"] as const) {
      const e = CONFIDENCE_TAXONOMY[level];
      expect(e.label.length).toBeGreaterThan(0);
      expect(e.tooltip.length).toBeGreaterThan(10);
    }
    expect(confidenceInfo("probable").label).toBe("Probable");
  });

  it("never over-claims on probable/unknown (legal safety)", () => {
    // The strong words ("confirmed", "guaranteed", "certain", "proven") must
    // not appear in the inferred/unverified tooltips.
    const banned = /\b(confirmed|guaranteed|certain|proven)\b/i;
    expect(banned.test(CONFIDENCE_TAXONOMY.probable.tooltip)).toBe(false);
    expect(banned.test(CONFIDENCE_TAXONOMY.unknown.tooltip)).toBe(false);
  });
});

describe("chainStrength (US-1102 aggregate indicator)", () => {
  it("empty chain → None / zero", () => {
    const s = chainStrength([]);
    expect(s.total).toBe(0);
    expect(s.label).toBe("None");
    expect(s.score).toBe(0);
  });

  it("counts each level and scores by deterministic share", () => {
    const s = chainStrength(["deterministic", "deterministic", "probable", "unknown"]);
    expect(s.total).toBe(4);
    expect(s.deterministic).toBe(2);
    expect(s.probable).toBe(1);
    expect(s.unknown).toBe(1);
    expect(s.score).toBeCloseTo(0.5);
    expect(s.label).toBe("Moderate");
  });

  it("all deterministic → Strong", () => {
    expect(chainStrength(["deterministic", "deterministic"]).label).toBe("Strong");
  });

  it("mostly inferred → Emerging", () => {
    expect(chainStrength(["unknown", "probable", "probable"]).label).toBe("Emerging");
  });

  it("summary singular/plural is correct", () => {
    expect(chainStrength(["deterministic"]).summary).toContain("1 of 1 link is");
    expect(chainStrength(["deterministic", "unknown"]).summary).toContain("1 of 2 links are");
  });
});
