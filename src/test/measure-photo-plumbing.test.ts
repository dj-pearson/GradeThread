// US-2625/US-2626: the three ways the MeasureCard flow leaked out of its lane.
//
// None of these is a measuring bug. They are plumbing: a tag menu that offered
// the wrong option and hid the right one, a render eBay rejects, and a
// correction that reached the item but never the listing.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  bareFormLabel,
  isSystemGeneratedPhotoType,
  SYSTEM_GENERATED_PHOTO_TYPES,
} from "@/lib/photo-roles";
import { applyMeasurementsBlock } from "@/lib/measurements";
import { COMPOSER_FOCUS_ANCHORS } from "@/lib/publish-blockers";
import {
  DEFAULT_UPLOAD_MAX_WIDTH_PX,
  uploadMaxWidthFor,
} from "@/lib/macro-photo-quality";

const PICKER = "src/components/flipdesk/photo-tag-select.tsx";

describe("US-2625: the tag menu offers the card and hides the render", () => {
  it("treats the generated overlay as system-produced", () => {
    expect(isSystemGeneratedPhotoType("measurement_overlay")).toBe(true);
    // The card frame and the tape shots are the seller's to tag.
    expect(isSystemGeneratedPhotoType("measurement")).toBe(false);
    expect(isSystemGeneratedPhotoType("front")).toBe(false);
    expect([...SYSTEM_GENERATED_PHOTO_TYPES]).toEqual(["measurement_overlay"]);
  });

  it("gives the bare `measurement` type its own label", () => {
    // measurement + role = a tape close-up (lists). measurement + NO role = the
    // MeasureCard calibration frame (never lists, and it is the ONLY photo the
    // measuring pipeline reads). The picker emitted role options only, so the
    // card slot appeared in every photo profile and in no menu.
    expect(bareFormLabel("measurement")).toMatch(/MeasureCard/i);
    expect(bareFormLabel("detail")).toBeNull();
    expect(bareFormLabel("tag")).toBeNull();
  });

  it("the picker actually applies both rules", () => {
    const src = readFileSync(PICKER, "utf8");
    expect(src).toContain("isSystemGeneratedPhotoType(t)");
    expect(src).toContain("bareFormLabel(t)");
  });
});

describe("US-2625: the composer measurement editor is reachable by link", () => {
  it("has a focus anchor, so an AutoLister deep-link can land on it", () => {
    // The drag-adjust editor already existed; it lived in the composer, which
    // is deliberately the one item editor, and a seller working a batch had no
    // route to it. That is why "let me move the anchor points" was asked for a
    // feature that was already built.
    expect(COMPOSER_FOCUS_ANCHORS.measurements).toBe("composer-measurements");
  });
});

describe("US-2626: a corrected measurement reaches the listing", () => {
  it("appends the block when the description has none", () => {
    const out = applyMeasurementsBlock("Great jeans.", { waist: 16, inseam: 30 });
    expect(out).toContain("Great jeans.");
    expect(out).toMatch(/Waist/i);
    expect(out).toMatch(/Inseam/i);
  });

  it("refreshes rather than stacks — the whole point of the markers", () => {
    // Drag, save, drag again, save again. Three corrections must not leave
    // three measurement blocks in the buyer's description.
    let d = applyMeasurementsBlock("Great jeans.", { waist: 16 });
    d = applyMeasurementsBlock(d, { waist: 17 });
    d = applyMeasurementsBlock(d, { waist: 18 });
    expect(d.match(/Measurements \(garment laid flat\)/g)).toHaveLength(1);
    expect(d).toContain("18");
    expect(d).not.toContain("16");
    expect(d).toContain("Great jeans.");
  });

  it("removes the block when every measurement is cleared", () => {
    const withBlock = applyMeasurementsBlock("Great jeans.", { waist: 16 });
    expect(applyMeasurementsBlock(withBlock, {})).toBe("Great jeans.");
  });

  it("the composer routes EVERY measurement edit through it", () => {
    // Dragging an anchor, resizing a line, typing in the form and the automatic
    // pass all land on the same setter. If one of them bypasses it, that edit
    // silently stops reaching the description.
    const src = readFileSync("src/pages/flipdesk/composer.tsx", "utf8");
    expect(src).toContain("applyMeasurementsBlock(prev, next, measurementUnit)");
    expect(src).not.toContain("setMeasurements={setMeasurements}");
    expect(src.match(/setMeasurements=\{applyMeasurements\}/g)).toHaveLength(2);
  });
});

// US-2632: the MeasureCard photo is the one shot whose whole job is metrology,
// and it had the LOWEST pixel cap of any slot.
describe("US-2632: the card frame keeps its pixels", () => {
  it("uploads at the authenticity tier, not the 2400 default", () => {
    // The card's fiducials are 1in squares needing ~40px each. A pair of pants
    // fills ~50in of frame, so at 2400 the squares land ~48px before any
    // server-side downscale — over the edge for anything larger. That is what
    // produced "move the camera closer" on a photo that could not be shot any
    // closer without cropping the garment being measured.
    expect(uploadMaxWidthFor("measurement", null)).toBe(3600);
    expect(uploadMaxWidthFor("measurement", "chest")).toBe(3600);
    // Unrelated slots keep the cap that upload speed on mobile data paid for.
    expect(uploadMaxWidthFor("front", null)).toBe(DEFAULT_UPLOAD_MAX_WIDTH_PX);
    expect(uploadMaxWidthFor("flatlay", null)).toBe(DEFAULT_UPLOAD_MAX_WIDTH_PX);
  });

  it("stops telling sellers to do the one thing they cannot", () => {
    const edge = readFileSync(
      "services/edge-functions/src/lib/measure-detect.ts",
      "utf8",
    );
    // Moving closer crops the garment the card is there to measure.
    expect(edge).not.toContain("Move the camera closer");
    expect(edge).toMatch(/full resolution/i);
  });

  it("reports the measured pixels so the next report is not a guess", () => {
    const edge = readFileSync(
      "services/edge-functions/src/lib/measure-autofill.ts",
      "utf8",
    );
    expect(edge).toContain("minMarkerSidePx");
    expect(edge).toContain("they need 40px");
  });
});
