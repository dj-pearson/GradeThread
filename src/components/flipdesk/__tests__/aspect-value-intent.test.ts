// The control's INTENT decides how an aspect's value array changes — not the
// aspect's cardinality. Conflating them made every MULTI free-text specific
// (Material, Occasion, Accents, Theme, Features, Character, MPN on Women's
// Tops) append on each keystroke instead of replacing, so the field snapped
// back to its old value and looked un-editable.
import { describe, it, expect } from "vitest";
import { nextAspectValues } from "@/components/flipdesk/ebay-category-picker";

describe("nextAspectValues", () => {
  describe("a text box on a MULTI aspect replaces, never appends", () => {
    it("clears to empty instead of appending a blank", () => {
      expect(
        nextAspectValues(["Jersey"], "", { intent: "set", multi: true }),
      ).toEqual([]);
    });

    it("replaces the old value while typing a new one", () => {
      const typed = ["S", "Si", "Sil", "Silk"];
      let values = ["Jersey"];
      for (const keystroke of typed) {
        values = nextAspectValues(values, keystroke, {
          intent: "set",
          multi: true,
        });
      }
      expect(values).toEqual(["Silk"]);
    });

    it("splits eBay's comma convention into separate values", () => {
      expect(
        nextAspectValues([], "Cocktail, Evening ,Party", {
          intent: "set",
          multi: true,
        }),
      ).toEqual(["Cocktail", "Evening", "Party"]);
    });
  });

  it("a text box on a SINGLE aspect replaces and clears", () => {
    expect(nextAspectValues(["Jersey"], "Silk", { intent: "set", multi: false }))
      .toEqual(["Silk"]);
    expect(nextAspectValues(["Jersey"], "", { intent: "set", multi: false }))
      .toEqual([]);
  });

  it("the chip row still toggles", () => {
    expect(
      nextAspectValues(["Evening"], "Party", { intent: "toggle", multi: true }),
    ).toEqual(["Evening", "Party"]);
    expect(
      nextAspectValues(["Evening", "Party"], "Party", {
        intent: "toggle",
        multi: true,
      }),
    ).toEqual(["Evening"]);
  });
});
