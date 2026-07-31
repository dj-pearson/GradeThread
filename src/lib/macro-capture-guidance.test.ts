// US-2137: per-slot macro capture guidance.
//
// The pairing that matters is with the US-2136 quality gate: if we are willing
// to tell a seller their macro shot is unusable, we must first have told them
// how to take a usable one. A gate without guidance is just blame, so the
// coverage assertion below is the point of this file, not a formality.

import { describe, it, expect } from "vitest";
import {
  captureGuidanceFor,
  MACRO_CAPTURE_GUIDANCE,
  overlayFillFraction,
} from "./macro-capture-guidance";
import {
  MACRO_MIN_LONG_EDGE_PX,
  uploadMaxWidthFor,
} from "./macro-photo-quality";

describe("every gated slot has guidance (US-2137 AC1)", () => {
  it("covers each slot the quality gate can reject", () => {
    // THE ASSERTION THIS FILE EXISTS FOR. A slot that can be flagged
    // "move closer" but was never told how close is a gate that blames the
    // seller for a standard we never published.
    for (const slot of Object.keys(MACRO_MIN_LONG_EDGE_PX)) {
      expect(captureGuidanceFor(slot), `no guidance for ${slot}`).not.toBeNull();
    }
  });

  it("says something about distance AND lighting for each", () => {
    for (const [slot, g] of Object.entries(MACRO_CAPTURE_GUIDANCE)) {
      expect(g.distance.length, `${slot} distance`).toBeGreaterThan(20);
      expect(g.lighting.length, `${slot} lighting`).toBeGreaterThan(20);
    }
  });

  it("returns null for slots that need no macro framing", () => {
    for (const slot of ["front", "back", "flatlay", "on_model", "measurement"]) {
      expect(captureGuidanceFor(slot)).toBeNull();
    }
    expect(captureGuidanceFor(null)).toBeNull();
    expect(captureGuidanceFor(undefined)).toBeNull();
    expect(captureGuidanceFor("unknown_slot")).toBeNull();
  });
});

describe("the lighting advice is slot-specific, not boilerplate", () => {
  it("tells struck-detail slots to use one-sided low-angle light", () => {
    // A stamped serial is only visible by its shadow — the single most
    // load-bearing instruction here, and the one generic "use good light"
    // advice gets exactly backwards.
    expect(MACRO_CAPTURE_GUIDANCE.serial?.lighting.toLowerCase()).toContain("one");
    expect(MACRO_CAPTURE_GUIDANCE.marking?.lighting.toLowerCase()).toContain(
      "flat lighting erases",
    );
  });

  it("tells printed-text slots to avoid glare instead", () => {
    // The opposite failure: raking light across a glossy care label blows the
    // print out. Same instruction on both would help neither.
    expect(MACRO_CAPTURE_GUIDANCE.tag?.lighting.toLowerCase()).toContain("even");
    expect(MACRO_CAPTURE_GUIDANCE.serial?.lighting).not.toBe(
      MACRO_CAPTURE_GUIDANCE.tag?.lighting,
    );
  });

  it("does not give the same lighting line to every slot", () => {
    // Cheap boilerplate check: guidance that is identical everywhere carries no
    // information and would pass every other test in this file.
    const lines = new Set(
      Object.values(MACRO_CAPTURE_GUIDANCE).map((g) => g.lighting),
    );
    expect(lines.size).toBeGreaterThan(4);
  });
});

describe("the framing overlay is satisfiable (US-2137 AC1)", () => {
  it("keeps the guide box inside the frame", () => {
    for (const framing of ["tight", "standard"] as const) {
      const f = overlayFillFraction(framing);
      expect(f).toBeGreaterThan(0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });

  it("makes tight framing actually tighter", () => {
    expect(overlayFillFraction("tight")).toBeLessThan(
      overlayFillFraction("standard"),
    );
  });

  it("a subject that fills the box clears its own quality floor", () => {
    // The property that makes the overlay honest rather than decorative: a
    // seller who does exactly what the box asks must not then be told to move
    // closer. Checked against the real caps and floors, so raising a floor
    // without revisiting the overlay fails here.
    for (const [slot, g] of Object.entries(MACRO_CAPTURE_GUIDANCE)) {
      const floor = MACRO_MIN_LONG_EDGE_PX[slot];
      if (floor == null) continue;
      const deliveredPx = uploadMaxWidthFor(slot) * overlayFillFraction(g.framing);
      expect(deliveredPx, `${slot} overlay delivers too few pixels`).toBeGreaterThan(
        floor,
      );
    }
  });
});
