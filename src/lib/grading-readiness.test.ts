import { describe, expect, it } from "vitest";
import { previewGradingReadiness } from "./grading-readiness";

// A fully-ready clothing item: garment set, title set, front+back+detail photos.
const READY = {
  garment_type: "t-shirt",
  garment_category: "tops",
  title: "Nike Dri-FIT Tee",
  photoTypes: ["front", "back", "detail"],
} as const;

describe("previewGradingReadiness", () => {
  it("is ready when garment, title, front/back and a fabric close-up are present", () => {
    const r = previewGradingReadiness(READY);
    expect(r.ready).toBe(true);
    expect(r.blockers).toEqual([]);
  });

  it("accepts any detail_* variant as the fabric close-up", () => {
    for (const t of ["detail", "detail_2", "detail_3", "detail_4"]) {
      const r = previewGradingReadiness({ ...READY, photoTypes: ["front", "back", t] });
      expect(r.ready, `detail variant ${t}`).toBe(true);
    }
  });

  it("blocks missing garment fields with the exact server strings", () => {
    const r = previewGradingReadiness({ ...READY, garment_type: null, garment_category: "" });
    expect(r.blockers).toContain("Missing garment_type");
    expect(r.blockers).toContain("Missing garment_category");
    expect(r.ready).toBe(false);
  });

  it("blocks a blank/whitespace title", () => {
    expect(previewGradingReadiness({ ...READY, title: "" }).blockers).toContain(
      "Missing title",
    );
    expect(previewGradingReadiness({ ...READY, title: "   " }).blockers).toContain(
      "Missing title",
    );
  });

  it("lists missing required photos front, back in order", () => {
    const r = previewGradingReadiness({ ...READY, photoTypes: ["detail"] });
    expect(r.blockers).toContain("Missing required photos: front, back");
  });

  it("WARNS, and does not block, when no fabric close-up is present", () => {
    // US-2397: front+back and nothing tagged Detail is a gradeable item. The
    // seller is told the grade gets a human check rather than being turned away.
    const r = previewGradingReadiness({ ...READY, photoTypes: ["front", "back"] });
    expect(r.ready).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("a person will check this grade");
  });

  it("does not count a defect shot as the fabric close-up", () => {
    // A defect shot frames the flaw, not the weave — so it still earns the
    // warning. It just no longer costs the seller the submission.
    const r = previewGradingReadiness({
      ...READY,
      photoTypes: ["front", "back", "defect"],
    });
    expect(r.ready).toBe(true);
    expect(r.warnings).toHaveLength(1);
  });

  it("a real close-up leaves nothing to warn about", () => {
    expect(previewGradingReadiness(READY).warnings).toEqual([]);
  });

  it("accepts a Set for photoTypes", () => {
    const r = previewGradingReadiness({
      ...READY,
      photoTypes: new Set(["front", "back", "detail"]),
    });
    expect(r.ready).toBe(true);
  });
});
