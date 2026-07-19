// US-2019 — WEB half of the shared grading-readiness guard.
//
// previewGradingReadiness is a deliberate mirror of the edge's
// gradingReadinessBlockers: the "Submit for grading" card needs to reflect
// readiness LIVE off the edit form, instead of only after a save + a /validate
// round-trip. The mirror is legitimate; holding it together with a comment
// ("the blocker STRINGS below are verbatim copies of the server's") was not.
//
// Divergence is silent in BOTH directions and both hurt:
//   • client says READY, server disagrees  → seller hits a rejection at submit
//   • client says NOT READY, server would accept → seller can't pay us
//
// The edge asserts this same fixture in
// services/edge-functions/src/tests/grading-readiness-parity_test.ts.
import { describe, expect, it } from "vitest";
import { previewGradingReadiness } from "@/lib/grading-readiness";
import fixture from "../../test/fixtures/grading-readiness-cases.json";

describe("grading readiness (shared fixture)", () => {
  it("matches every case in the cross-project fixture", () => {
    expect(fixture.cases.length).toBeGreaterThan(10);
    for (const c of fixture.cases) {
      const got = previewGradingReadiness({
        garment_type: c.input.garment_type,
        garment_category: c.input.garment_category,
        title: c.input.title,
        photoTypes: c.input.photoTypes,
      });
      expect(got.blockers, `case: ${c.name}`).toEqual(c.expected.blockers);
      expect(got.ready, `case: ${c.name}`).toBe(c.expected.blockers.length === 0);
    }
  });

  it("a defect photo does NOT satisfy the fabric close-up requirement", () => {
    // The distinction the copy exists to make — a defect shot is not a weave
    // shot, and the pipeline ABSTAINS without a real close-up. Getting this
    // wrong means a "ready" item comes back ungraded after the seller paid.
    const got = previewGradingReadiness({
      garment_type: "jeans",
      garment_category: "denim",
      title: "X",
      photoTypes: ["front", "back", "defect"],
    });
    expect(got.ready).toBe(false);
    expect(got.blockers.join(" ")).toContain("fabric close-up");
  });

  it("treats a whitespace-only title as missing", () => {
    const got = previewGradingReadiness({
      garment_type: "jeans",
      garment_category: "denim",
      title: "   ",
      photoTypes: ["front", "back", "detail"],
    });
    expect(got.blockers).toContain("Missing title");
  });
});
