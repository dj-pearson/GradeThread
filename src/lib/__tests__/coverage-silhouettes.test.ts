import { describe, expect, it } from "vitest";
import { silhouetteFor } from "@/lib/coverage-silhouettes";

// US-3216. The bug this pins was reported off a real certificate: a pair of
// Quince Ponte Straight Leg Pants whose coverage legend correctly read
// Waistband, Inseam / crotch, Hem and Pockets while every marker sat on a
// drawing of a shirt. The legend was right and the picture argued with it, on
// a document a buyer is asked to trust.

describe("coverage silhouettes (US-3216)", () => {
  it("draws bottoms for bottoms, and not the top shape", () => {
    const top = silhouetteFor("shirt")!;
    for (const category of ["pants", "jeans", "shorts", "skirt"]) {
      const s = silhouetteFor(category);
      expect(s, category).not.toBeNull();
      expect(s!.path, category).not.toBe(top.path);
      expect(s!.shape, category).toBe("a pair of bottoms");
    }
  });

  it("puts a waistband at the top of bottoms and the bottom of a top", () => {
    // The single most visible symptom. On trousers the waistband is the top
    // edge of the garment; on a shirt the same word means the hemline.
    const bottoms = silhouetteFor("pants")!;
    const top = silhouetteFor("shirt")!;
    expect(bottoms.anchors.waistband!.y).toBeLessThan(0.2);
    expect(top.anchors.waistband!.y).toBeGreaterThan(0.8);
  });

  it("puts the inseam where the legs meet, and only on bottoms", () => {
    const bottoms = silhouetteFor("jeans")!;
    expect(bottoms.anchors.inseam_crotch).toBeDefined();
    // Mid-garment, not at the hem: it is the crotch seam, not the leg opening.
    expect(bottoms.anchors.inseam_crotch!.y).toBeGreaterThan(0.25);
    expect(bottoms.anchors.inseam_crotch!.y).toBeLessThan(0.6);
    // A shirt has no inseam. An anchor for one would be an invented location.
    expect(silhouetteFor("shirt")!.anchors.inseam_crotch).toBeUndefined();
  });

  it("has no shape for a garment no outline can place honestly", () => {
    // Footwear, bags, belts, hats and scarves carry zones (sole, insole,
    // strap, hardware) that an apparel outline cannot site. Null means the
    // legend renders alone, which was always the authoritative list. Drawing a
    // shirt behind them is the bug, not a tolerable approximation.
    for (
      const category of [
        "sneakers",
        "boots",
        "sandals",
        "hat",
        "bag",
        "belt",
        "scarf",
        "other",
      ]
    ) {
      expect(silhouetteFor(category), category).toBeNull();
    }
  });

  it("an unknown or empty category draws nothing rather than guessing", () => {
    // The keys are the garment_category enum, so an unmapped value can only
    // ever mean "no drawing" — never "the wrong drawing".
    expect(silhouetteFor("kimono")).toBeNull();
    expect(silhouetteFor("")).toBeNull();
    expect(silhouetteFor(null)).toBeNull();
    expect(silhouetteFor(undefined)).toBeNull();
  });

  it("matches the category however it is cased or padded", () => {
    expect(silhouetteFor(" PANTS ")).toBe(silhouetteFor("pants"));
    expect(silhouetteFor("T-Shirt")).toBe(silhouetteFor("t-shirt"));
  });

  it("every anchor sits inside the drawing", () => {
    // An anchor outside 0..1 renders a marker off the edge of the viewBox,
    // which reads as a missing zone rather than as a mistake.
    for (const category of ["shirt", "pants", "dress"]) {
      const s = silhouetteFor(category)!;
      for (const [zone, a] of Object.entries(s.anchors)) {
        expect(a.x, `${category}.${zone}.x`).toBeGreaterThan(0);
        expect(a.x, `${category}.${zone}.x`).toBeLessThan(1);
        expect(a.y, `${category}.${zone}.y`).toBeGreaterThan(0);
        expect(a.y, `${category}.${zone}.y`).toBeLessThan(1);
      }
    }
  });

  it("every apparel category the grader knows about resolves", () => {
    // The engine's zone map (services/edge-functions/src/lib/coverage.ts) has an
    // entry per category. Every APPAREL one should get a drawing; if a new
    // clothing category is added and forgotten, this fails rather than silently
    // falling back to no map.
    for (
      const category of [
        "t-shirt",
        "shirt",
        "blouse",
        "sweater",
        "hoodie",
        "jacket",
        "coat",
        "jeans",
        "pants",
        "shorts",
        "skirt",
        "dress",
      ]
    ) {
      expect(silhouetteFor(category), category).not.toBeNull();
    }
  });
});
