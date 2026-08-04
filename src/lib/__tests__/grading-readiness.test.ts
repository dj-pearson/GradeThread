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
      expect(got.warnings, `case: ${c.name}`).toEqual(c.expected.warnings);
      expect(got.ready, `case: ${c.name}`).toBe(c.expected.blockers.length === 0);
    }
  });

  it("a warning never makes an item unready", () => {
    // US-2397: the readiness verdict reads BLOCKERS only. If warnings ever leak
    // into it, this becomes the old hard gate again wearing a softer word.
    const warned = fixture.cases.filter((c) => c.expected.warnings.length > 0);
    expect(warned.length).toBeGreaterThan(0);
    for (const c of warned) {
      const got = previewGradingReadiness({
        garment_type: c.input.garment_type,
        garment_category: c.input.garment_category,
        title: c.input.title,
        photoTypes: c.input.photoTypes,
      });
      expect(got.ready, `case: ${c.name}`).toBe(c.expected.blockers.length === 0);
    }
  });

  it("a defect photo does NOT satisfy the fabric close-up requirement", () => {
    // The distinction the copy exists to make — a defect shot frames the flaw,
    // not the weave. Post-US-2397 it earns the warning and the human check,
    // rather than turning the seller away.
    const got = previewGradingReadiness({
      garment_type: "jeans",
      garment_category: "denim",
      title: "X",
      // US-2304: `tag` joined the required set for GRADING, so it belongs in
      // any case whose point is something else — otherwise this asserts the
      // missing-tag blocker instead of the defect/fabric distinction it names.
      photoTypes: ["front", "back", "tag", "defect"],
    });
    expect(got.ready).toBe(true);
    expect(got.warnings.join(" ")).toContain("fabric close-up");
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
