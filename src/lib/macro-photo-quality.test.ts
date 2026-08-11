// US-2136: the web macro-quality gate.
//
// The gate's whole value is that it fires on a bad photo and stays silent on a
// good one. Both halves are load-bearing: a gate that never fires is dead code
// that reads as coverage, and one that fires on acceptable photos trains
// sellers to ignore it — which is worse, because the nudge is advisory and the
// only thing making it work is that sellers believe it.
//
// Split deliberately: assessMacroPhoto and the Laplacian math are pure and
// tested here; measureMacroPhoto's canvas plumbing is the thin untested layer.

import { describe, it, expect } from "vitest";
import {
  assessMacroPhoto,
  DEFAULT_MIN_SHARPNESS,
  isMacroPhotoType,
  laplacianVariance,
  MACRO_MIN_LONG_EDGE_PX,
  MACRO_MIN_SHARPNESS,
  macroQualityMessage,
  minLongEdgeFor,
  minSharpnessFor,
  normalizeSharpness,
  DEFAULT_UPLOAD_MAX_WIDTH_PX,
  MACRO_UPLOAD_MAX_WIDTH_PX,
  uploadMaxWidthFor,
  SHARPNESS_VARIANCE_SCALE,
} from "./macro-photo-quality";

// Comfortably sharp — above every floor in the table.
const SHARP = 0.9;

describe("which slots the gate applies to (US-2136 AC2)", () => {
  it("covers the tag slots under BOTH spellings", () => {
    // FlipDesk calls it `tag`; the web submission flow calls the same slot
    // `label`. Covering only one leaves half the product ungated, which is the
    // exact shape of the bug this story exists to close.
    for (const t of ["tag", "tag_2", "label", "label_2"]) {
      expect(isMacroPhotoType(t)).toBe(true);
    }
  });

  it("covers the authenticity evidence slots", () => {
    for (const t of ["serial", "marking", "surface", "corner", "sole"]) {
      expect(isMacroPhotoType(t)).toBe(true);
    }
  });

  it("leaves the full-garment slots alone", () => {
    // These are governed by photo-standards.ts and the marketplace's 500px
    // floor. Two gates, two questions: "will eBay accept it" vs "can the model
    // read it". Applying a macro floor to a flatlay would nag on a good photo.
    for (const t of ["front", "back", "flatlay", "on_model", "measurement"]) {
      expect(isMacroPhotoType(t)).toBe(false);
      expect(minLongEdgeFor(t)).toBeNull();
      expect(minSharpnessFor(t)).toBeNull();
    }
  });

  it("treats a null/unknown slot as not-macro", () => {
    expect(isMacroPhotoType(null)).toBe(false);
    expect(isMacroPhotoType(undefined)).toBe(false);
    expect(isMacroPhotoType("something_new")).toBe(false);
  });

  it("keeps the iOS 700px baseline for the tag", () => {
    // TagPhotoQuality.swift minLongEdgePixels = 700. Drifting from it means
    // the two platforms accept different photos for the same slot.
    expect(MACRO_MIN_LONG_EDGE_PX.tag).toBe(700);
    expect(MACRO_MIN_LONG_EDGE_PX.label).toBe(700);
  });

  it("demands MORE of the authenticity slots than of a tag", () => {
    // Serials and date codes are struck at a smaller physical scale than tag
    // print, so the same pixel count resolves less of them.
    expect(MACRO_MIN_LONG_EDGE_PX.serial).toBeGreaterThan(
      MACRO_MIN_LONG_EDGE_PX.tag as number,
    );
    expect(MACRO_MIN_SHARPNESS.serial).toBeGreaterThan(DEFAULT_MIN_SHARPNESS);
  });

  it("gives every macro slot a sharpness floor, via the default", () => {
    for (const t of Object.keys(MACRO_MIN_LONG_EDGE_PX)) {
      expect(minSharpnessFor(t)).toBeGreaterThan(0);
    }
  });
});

describe("the gate fires on a bad photo", () => {
  it("flags a tag below the resolution floor", () => {
    const a = assessMacroPhoto({ photoType: "tag", longEdge: 699, sharpness: SHARP });
    expect(a.ok).toBe(false);
    expect(a.reason).toBe("low_resolution");
    expect(a.message).toContain("Move closer");
  });

  it("flags a blurry tag that is big enough", () => {
    const a = assessMacroPhoto({ photoType: "tag", longEdge: 2000, sharpness: 0.05 });
    expect(a.ok).toBe(false);
    expect(a.reason).toBe("unsharp");
    expect(a.message).toContain("blurry");
  });

  it("reports resolution FIRST when a photo fails both", () => {
    // A too-small photo is usually also soft, and "move closer" is the single
    // action that fixes both. Reporting "blurry" would send the seller to
    // steady their hands on a shot that needed a different distance.
    const a = assessMacroPhoto({ photoType: "tag", longEdge: 200, sharpness: 0.01 });
    expect(a.reason).toBe("low_resolution");
  });

  it("applies the stricter serial floor a tag would have passed", () => {
    // 800px passes `tag` (700) and fails `serial` (900) — the case that proves
    // per-slot thresholds are real and not one number wearing several names.
    expect(assessMacroPhoto({ photoType: "tag", longEdge: 800, sharpness: SHARP }).ok)
      .toBe(true);
    expect(assessMacroPhoto({ photoType: "serial", longEdge: 800, sharpness: SHARP }).ok)
      .toBe(false);
  });
});

describe("the gate stays silent when it should", () => {
  it("passes a good macro photo", () => {
    const a = assessMacroPhoto({ photoType: "tag", longEdge: 1600, sharpness: SHARP });
    expect(a).toEqual({ ok: true, reason: null, message: null, score: SHARP });
  });

  it("passes exactly AT the floor, not just above it", () => {
    // An off-by-one here nags on a photo that meets the documented standard.
    expect(assessMacroPhoto({ photoType: "tag", longEdge: 700, sharpness: SHARP }).ok)
      .toBe(true);
    expect(
      assessMacroPhoto({
        photoType: "tag",
        longEdge: 1600,
        sharpness: DEFAULT_MIN_SHARPNESS,
      }).ok,
    ).toBe(true);
  });

  it("never fires on a non-macro slot however bad the numbers", () => {
    const a = assessMacroPhoto({ photoType: "front", longEdge: 10, sharpness: 0 });
    expect(a.ok).toBe(true);
    expect(a.message).toBeNull();
  });
});

describe("it fails OPEN on anything it could not measure", () => {
  // Same posture as the iOS `guard let image = UIImage(...) else { return .ok }`.
  // A gate that blocks on its own inability to measure blames the seller for
  // our decode failure — and this one runs on every capture, so it would.
  it("passes when the long edge is unknown", () => {
    expect(assessMacroPhoto({ photoType: "tag", longEdge: null, sharpness: SHARP }).ok)
      .toBe(true);
  });

  it("passes when sharpness is unknown", () => {
    expect(assessMacroPhoto({ photoType: "tag", longEdge: 1600, sharpness: null }).ok)
      .toBe(true);
  });

  it("passes on non-finite measurements rather than treating them as zero", () => {
    // NaN < 700 is false, so this survives by accident unless asserted — and a
    // future refactor to `!(x >= floor)` would silently start nagging on every
    // photo whose dimensions failed to read.
    expect(
      assessMacroPhoto({ photoType: "tag", longEdge: Number.NaN, sharpness: SHARP }).ok,
    ).toBe(true);
    expect(
      assessMacroPhoto({ photoType: "tag", longEdge: 1600, sharpness: Number.NaN }).ok,
    ).toBe(true);
  });
});

describe("the measured score survives the verdict (US-2136 AC4 groundwork)", () => {
  it("carries sharpness through on a pass", () => {
    // AC4 wants authenticity confidence to read a MEASURE, not a pass/fail bit.
    // An accepted-but-marginal macro must be distinguishable from a crisp one.
    expect(assessMacroPhoto({ photoType: "serial", longEdge: 1600, sharpness: 0.4 }).score)
      .toBe(0.4);
  });

  it("carries it through on a failure too", () => {
    expect(assessMacroPhoto({ photoType: "serial", longEdge: 100, sharpness: 0.4 }).score)
      .toBe(0.4);
  });
});

describe("guidance says what to DO", () => {
  it("names the action, not the defect", () => {
    expect(macroQualityMessage("low_resolution", "tag")).toContain("Move closer");
    expect(macroQualityMessage("unsharp", "tag")).toContain("Hold steady");
  });

  it("names the slot in the seller's words", () => {
    expect(macroQualityMessage("low_resolution", "serial")).toContain("serial or date code");
    expect(macroQualityMessage("low_resolution", "label_2")).toContain("tag");
    expect(macroQualityMessage("low_resolution", "detail_3")).toContain("close-up");
    // No raw snake_case ever reaches a seller.
    expect(macroQualityMessage("unsharp", "detail_3")).not.toContain("_");
  });

  it("names the ROLE when the slot has one (US-2471)", () => {
    // "fill the frame with the close-up" was always a slightly absurd sentence.
    // The role is what lets it name the thing the camera is pointed at.
    expect(macroQualityMessage("low_resolution", "detail", "fabric"))
      .toContain("fabric close-up");
    expect(macroQualityMessage("low_resolution", "tag", "care"))
      .toContain("care & fabric");
    expect(macroQualityMessage("unsharp", "detail", "hardware"))
      .toContain("hardware");
    // An unknown role falls back to the type's noun rather than leaking a key.
    expect(macroQualityMessage("unsharp", "detail", "not_a_role"))
      .toContain("close-up");
    expect(macroQualityMessage("unsharp", "detail", "not_a_role"))
      .not.toContain("not_a_role");
  });
});

describe("floors follow the role, not the slot number (US-2471)", () => {
  it("gives a role-qualified slot the same floor its numbered slot had", () => {
    // The point is that the numbers did NOT move. A `detail:hem` shot is new
    // vocabulary and gets `detail`'s floor; a `detail_3` from an older cached
    // bundle collapses onto the same one.
    for (const role of ["fabric", "hem", "hardware", "pocket", "print", "collar"]) {
      expect(minLongEdgeFor("detail", role)).toBe(minLongEdgeFor("detail"));
      expect(minSharpnessFor("detail", role)).toBe(minSharpnessFor("detail"));
    }
    for (const role of ["brand", "size", "care", "made_in"]) {
      expect(minLongEdgeFor("tag", role)).toBe(700);
      expect(minLongEdgeFor("label", role)).toBe(700);
    }
    expect(minLongEdgeFor("detail_3")).toBe(minLongEdgeFor("detail"));
    expect(minLongEdgeFor("tag_2")).toBe(minLongEdgeFor("tag"));
    expect(minLongEdgeFor("label_2")).toBe(minLongEdgeFor("label"));
  });

  it("a role never turns a non-macro slot into a macro one", () => {
    // Measurement roles are real vocabulary, and a tape-measure frame is a
    // whole-garment shot governed by photo-standards.ts — handing this gate a
    // role must not drag it in.
    for (const role of ["chest", "waist", "inseam"]) {
      expect(isMacroPhotoType("measurement", role)).toBe(false);
      expect(minLongEdgeFor("measurement", role)).toBeNull();
      expect(minSharpnessFor("measurement", role)).toBeNull();
    }
    expect(isMacroPhotoType("front", "fabric")).toBe(false);
  });

  it("the upload width cap follows the base type, role or not", () => {
    expect(uploadMaxWidthFor("detail", "fabric")).toBe(uploadMaxWidthFor("detail"));
    expect(uploadMaxWidthFor("detail_3")).toBe(uploadMaxWidthFor("detail"));
    expect(uploadMaxWidthFor("tag_2")).toBe(uploadMaxWidthFor("tag"));
    expect(uploadMaxWidthFor("label_2")).toBe(uploadMaxWidthFor("label"));
  });

  it("assessMacroPhoto reads the role through", () => {
    const a = assessMacroPhoto({
      photoType: "detail",
      photoRole: "fabric",
      longEdge: 699,
      sharpness: SHARP,
    });
    expect(a.ok).toBe(false);
    expect(a.message).toContain("fabric close-up");
  });
});

describe("the sharpness metric", () => {
  /** w*h grayscale buffer, every pixel the same — zero second derivative. */
  function flat(w: number, h: number, value = 128): Float32Array {
    return new Float32Array(w * h).fill(value);
  }

  /** Alternating black/white columns — maximal local intensity change. */
  function stripes(w: number, h: number): Float32Array {
    const g = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) g[y * w + x] = x % 2 === 0 ? 0 : 255;
    }
    return g;
  }

  it("is zero for a flat image", () => {
    expect(laplacianVariance(flat(32, 32), 32, 32)).toBe(0);
  });

  it("is large for a hard-edged one", () => {
    expect(laplacianVariance(stripes(32, 32), 32, 32)).toBeGreaterThan(
      SHARPNESS_VARIANCE_SCALE,
    );
  });

  it("ranks a blurred image below its sharp original", () => {
    // The property that actually matters — not the absolute number, which is a
    // scale choice, but that blur moves it DOWN.
    const sharp = stripes(32, 32);
    const blurred = new Float32Array(sharp.length);
    for (let i = 0; i < sharp.length; i++) {
      const a = sharp[i - 1] ?? sharp[i] ?? 0;
      const b = sharp[i] ?? 0;
      const c = sharp[i + 1] ?? sharp[i] ?? 0;
      blurred[i] = ((a as number) + (b as number) + (c as number)) / 3;
    }
    expect(laplacianVariance(blurred, 32, 32)).toBeLessThan(
      laplacianVariance(sharp, 32, 32),
    );
  });

  it("returns 0 rather than dividing by zero on a buffer too small to convolve", () => {
    expect(laplacianVariance(flat(2, 2), 2, 2)).toBe(0);
    expect(laplacianVariance(flat(1, 9), 1, 9)).toBe(0);
  });

  it("normalizes onto 0..1 and clamps the tail", () => {
    expect(normalizeSharpness(0)).toBe(0);
    expect(normalizeSharpness(-5)).toBe(0);
    expect(normalizeSharpness(Number.NaN)).toBe(0);
    expect(normalizeSharpness(SHARPNESS_VARIANCE_SCALE / 2)).toBeCloseTo(0.5, 6);
    expect(normalizeSharpness(SHARPNESS_VARIANCE_SCALE * 100)).toBe(1);
  });

  it("puts a hard-edged image above every slot floor", () => {
    // Guards the scale choice: if SHARPNESS_VARIANCE_SCALE were raised far
    // enough, even a crisp photo would fall under the floors and the gate would
    // nag on everything.
    const s = normalizeSharpness(laplacianVariance(stripes(64, 64), 64, 64));
    for (const t of Object.keys(MACRO_MIN_LONG_EDGE_PX)) {
      expect(s).toBeGreaterThanOrEqual(minSharpnessFor(t) as number);
    }
  });
});

describe("scoped upload resolution (US-2135 AC1/AC5)", () => {
  it("leaves every non-macro slot at the global default", () => {
    // AC5 is explicit: do NOT raise this globally. The iOS cap was LOWERED for
    // upload speed on purpose, and a front/back shot gains nothing from pixels
    // a buyer will never zoom into.
    for (const t of ["front", "back", "flatlay", "on_model", "measurement"]) {
      expect(uploadMaxWidthFor(t)).toBe(DEFAULT_UPLOAD_MAX_WIDTH_PX);
    }
    expect(uploadMaxWidthFor(null)).toBe(DEFAULT_UPLOAD_MAX_WIDTH_PX);
    expect(uploadMaxWidthFor("brand_new_slot")).toBe(DEFAULT_UPLOAD_MAX_WIDTH_PX);
  });

  it("raises every macro slot above the default", () => {
    for (const t of Object.keys(MACRO_UPLOAD_MAX_WIDTH_PX)) {
      expect(uploadMaxWidthFor(t)).toBeGreaterThan(DEFAULT_UPLOAD_MAX_WIDTH_PX);
    }
  });

  it("gives the authenticity slots more than the tag slots", () => {
    // The tell IS the fine detail on a struck serial, whereas a tag carries
    // printed text that survives more compression.
    expect(uploadMaxWidthFor("serial")).toBeGreaterThan(uploadMaxWidthFor("tag"));
    expect(uploadMaxWidthFor("marking")).toBeGreaterThan(uploadMaxWidthFor("detail"));
  });

  it("covers every gated slot, so no macro slot is judged above its own cap", () => {
    // The failure this prevents: a slot with a 900px FLOOR but the 2400 default
    // CAP would be nagged for resolution the pipeline was never asked to keep.
    for (const t of Object.keys(MACRO_MIN_LONG_EDGE_PX)) {
      expect(uploadMaxWidthFor(t)).toBeGreaterThan(DEFAULT_UPLOAD_MAX_WIDTH_PX);
      expect(uploadMaxWidthFor(t)).toBeGreaterThan(
        MACRO_MIN_LONG_EDGE_PX[t] as number,
      );
    }
  });

  it("stays inside the 10MB upload ceiling by a wide margin", () => {
    // Both the client (MAX_FILE_SIZE) and the edge (DEFAULT_MAX_BYTES) cap at
    // 10MB. A cap high enough to breach it turns a quality improvement into a
    // rejected upload — the failure would land on the seller, at capture time.
    // 4:3 at q0.85 WebP runs well under 1 byte/px in practice; 2 is generous.
    for (const w of Object.values(MACRO_UPLOAD_MAX_WIDTH_PX)) {
      const worstCaseBytes = w * (w * 0.75) * 0.5;
      expect(worstCaseBytes).toBeLessThan(10 * 1024 * 1024);
    }
  });
});
