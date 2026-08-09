// US-2225 AC4: the two measurement-template copies must not drift.
//
// src/lib/measurement-templates.ts and
// services/edge-functions/src/lib/measurement-templates.ts are byte-identical
// today and NOTHING pinned them — the third instance of that shape this repo
// has found, after the rubric definitions (US-1997) and title-sync (US-1995).
// Both of those got a shared behavioural fixture only after a divergence became
// possible; this one is pinned before.
//
// A divergence here is quiet and expensive in a specific way: measurements are
// stored on inventory_items.measurements keyed by the field `key`, so if one
// side renames a key the web form writes `strap_drop` and the edge extractor
// reads `strapDrop`, and the measurement simply does not exist as far as the
// listing description, the size estimate and the MeasureCard accuracy gate are
// concerned. Nothing errors; a number the seller typed just stops arriving.
//
// A SOURCE COMPARISON is the right guard here, unlike title-sync where the two
// implementations legitimately differ. These two files are meant to be the same
// file, so byte equality is the actual contract — and it fails with a diff a
// human can read rather than a behavioural mismatch they have to localise.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  MEASUREMENT_TEMPLATES,
  measurementGroupFor,
} from "../lib/measurement-templates";

const WEB = "src/lib/measurement-templates.ts";
const EDGE = "services/edge-functions/src/lib/measurement-templates.ts";

/** Line endings differ by checkout; content must not. */
function normalized(path: string): string {
  return readFileSync(path, "utf8").split("\r\n").join("\n");
}

describe("US-2225: the measurement templates are one definition in two files", () => {
  it("the web and edge copies are identical", () => {
    expect(normalized(EDGE)).toBe(normalized(WEB));
  });
});

describe("US-2225 AC4: bags can actually be measured", () => {
  it("offers width, height and depth, all required", () => {
    // Depth is the one that matters: a 30cm tote and a 30cm clutch are
    // different objects, and before this the bag fell through to `generic`,
    // which offers length and width and neither of them required.
    const fields = MEASUREMENT_TEMPLATES.bag;
    const required = fields.filter((f) => f.required).map((f) => f.key);
    expect(required).toEqual(["width", "height", "depth"]);
  });

  it("offers BOTH strap drop and handle drop, both optional", () => {
    // A top-handle bag has no strap and a crossbody has no handles. One shared
    // field would sit blank on half of all bags, and a blank measurement reads
    // as "the seller did not measure it" rather than "this bag has no strap".
    const keys = MEASUREMENT_TEMPLATES.bag.map((f) => f.key);
    expect(keys).toContain("strap_drop");
    expect(keys).toContain("handle_drop");
    for (const k of ["strap_drop", "handle_drop"]) {
      expect(MEASUREMENT_TEMPLATES.bag.find((f) => f.key === k)?.required).toBe(false);
    }
  });

  it("every bag dimension uses the in/cm length unit", () => {
    // `shoe` and `mm` exist for the two categories that need them; a bag
    // measured in millimetres would render as "300 mm depth".
    for (const f of MEASUREMENT_TEMPLATES.bag) {
      expect(f.unit, f.key).toBe("length");
    }
  });
});

describe("US-2223 AC2: hats can be measured", () => {
  it("requires the circumference and nothing else", () => {
    const required = MEASUREMENT_TEMPLATES.headwear
      .filter((f) => f.required)
      .map((f) => f.key);
    expect(required).toEqual(["circumference"]);
  });

  it("treats circumference as a LENGTH, not a size label", () => {
    // "7 3/8" is a size label nobody put a tape to, and it belongs in the
    // item's size field. Half of resale headwear is snapback or strapback with
    // no numeric size at all, so a size-only template leaves those
    // unmeasurable — which is why this is a length in inches or centimetres.
    for (const f of MEASUREMENT_TEMPLATES.headwear) {
      expect(f.unit, f.key).toBe("length");
    }
    expect(MEASUREMENT_TEMPLATES.headwear.map((f) => f.key))
      .toEqual(["circumference", "crown_height", "brim_length"]);
  });

  it("routes the words sellers actually type, including visors", () => {
    for (
      const c of [
        "hat", "cap", "beanie", "snapback", "trucker hat",
        "bucket hat", "fedora", "beret", "visor",
      ]
    ) {
      expect(measurementGroupFor(c), c).toBe("headwear");
    }
  });

  it("still loses to bags, which own the noun", () => {
    expect(measurementGroupFor("hat bag")).toBe("bag");
  });
});

describe("US-2224 AC4: ties, belts, scarves and gloves can be measured", () => {
  it("requires the two numbers all four are sold on", () => {
    const required = MEASUREMENT_TEMPLATES.accessory
      .filter((f) => f.required)
      .map((f) => f.key);
    expect(required).toEqual(["length", "width"]);
  });

  it("offers a belt's wearable range as a SPAN, not a hole count", () => {
    // A hole count tells a buyer nothing without the spacing. First-to-last
    // hole is the number that answers "will this fit me".
    const span = MEASUREMENT_TEMPLATES.accessory.find((f) => f.key === "hole_span");
    expect(span).toBeDefined();
    expect(span!.required).toBe(false);
    expect(span!.label.toLowerCase()).toContain("hole");
  });

  it("routes the four categories, and the words sellers actually type", () => {
    for (
      const c of [
        "tie", "necktie", "bow tie", "belt", "scarf", "scarves",
        "gloves", "mittens", "shawl", "pocket square", "suspenders",
      ]
    ) {
      expect(measurementGroupFor(c), c).toBe("accessory");
    }
  });

  it("does not claim socks", () => {
    // Deliberately absent: socks sell by size, not by measurement, and asking
    // a seller to measure one would ask for a number nobody publishes.
    expect(measurementGroupFor("socks")).toBe("generic");
  });

  it("loses to bags, which is the right precedence", () => {
    // A "tie bag" is a bag. Bags are tested first for exactly this reason.
    expect(measurementGroupFor("tie bag")).toBe("bag");
  });
});

describe("US-2225: routing a bag to the bag template", () => {
  it("recognises the words sellers actually use", () => {
    for (
      const c of [
        "bags", "handbag", "Purse", "tote bag", "clutch", "satchel",
        "crossbody", "backpack", "duffel", "wallet", "briefcase",
      ]
    ) {
      expect(measurementGroupFor(c), c).toBe("bag");
    }
  });

  it("wins over a keyword an earlier branch would have claimed", () => {
    // The noun that matters is the LAST one. Tested before shoes precisely
    // because these three exist and every one of them is a bag — routing them
    // to the shoe template would ask the seller for an insole length.
    expect(measurementGroupFor("boot bag")).toBe("bag");
    expect(measurementGroupFor("shoe bag")).toBe("bag");
    expect(measurementGroupFor("cargo bag")).toBe("bag");
  });

  it("does not steal categories that are not bags", () => {
    expect(measurementGroupFor("t-shirt")).toBe("top");
    expect(measurementGroupFor("jeans")).toBe("bottom");
    expect(measurementGroupFor("boots")).toBe("shoes");
    expect(measurementGroupFor("watch")).toBe("watch");
    expect(measurementGroupFor("")).toBe("generic");
    expect(measurementGroupFor(null)).toBe("generic");
  });
});
