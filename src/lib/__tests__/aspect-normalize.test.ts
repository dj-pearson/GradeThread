// US-823: web mirror of the edge aspect-value normalization tests, so a
// divergence in the vendored logic is caught here too. Also exercises the
// rewrite-reporting that drives the composer's "sent as" hint.
import { describe, it, expect } from "vitest";
import { normalizeAspectValue } from "@/lib/aspect-normalize";
import {
  deriveAspectsFromItem,
  type AspectRewrite,
  type ItemAspectSource,
} from "@/lib/ebay-prefill";
import type { EbayAspect } from "@/hooks/use-ebay";

const sel = (name: string, allowedValues: string[]) => ({
  name,
  mode: "SELECTION_ONLY",
  allowedValues,
});

describe("normalizeAspectValue (US-823)", () => {
  it("passes FREE_TEXT values through untouched", () => {
    expect(
      normalizeAspectValue("M", { name: "Size", mode: "FREE_TEXT", allowedValues: [] }),
    ).toBe("M");
  });

  it("rewrites size, material and department synonyms", () => {
    expect(normalizeAspectValue("M", sel("Size", ["Small", "Medium", "Large"]))).toBe(
      "Medium",
    );
    expect(
      normalizeAspectValue("Poly", sel("Material", ["Cotton", "Polyester"])),
    ).toBe("Polyester");
    expect(
      normalizeAspectValue("Men's", sel("Department", ["Men", "Women"])),
    ).toBe("Men");
  });

  it("handles eBay's 'Label (ABBR)' values both ways", () => {
    const paren = sel("Size", ["S (Small)", "M (Medium)", "L (Large)"]);
    expect(normalizeAspectValue("M", paren)).toBe("M (Medium)");
    expect(normalizeAspectValue("Medium", paren)).toBe("M (Medium)");
  });

  it("refuses ambiguous matches and unknown values (null)", () => {
    expect(
      normalizeAspectValue("Cotton", sel("Material", ["100% Cotton", "Cotton Blend"])),
    ).toBeNull();
    expect(normalizeAspectValue("Chartreuse", sel("Color", ["Red", "Blue"]))).toBeNull();
  });
});

// ── End-to-end rewrite reporting through the prefill ────────────────────────

const base: ItemAspectSource = {
  title: null,
  brand: null,
  size: null,
  color: null,
  material: null,
  style: null,
  description: null,
  condition_notes: null,
  item_category: "clothing",
  attributes: null,
};

const selAspect = (name: string, allowed: string[]): EbayAspect => ({
  localizedAspectName: name,
  aspectConstraint: {
    aspectMode: "SELECTION_ONLY",
    itemToAspectCardinality: "SINGLE",
  },
  aspectValues: allowed.map((localizedValue) => ({ localizedValue })),
});

describe("deriveAspectsFromItem rewrite reporting", () => {
  it("normalizes a stored size and reports the rewrite for the hint", () => {
    const item: ItemAspectSource = { ...base, size: "M" };
    const rewrites: Record<string, AspectRewrite> = {};
    const out = deriveAspectsFromItem(
      item,
      [selAspect("Size", ["Small", "Medium", "Large"])],
      {},
      rewrites,
    );
    expect(out).toEqual({ Size: ["Medium"] });
    expect(rewrites).toEqual({ Size: { from: "M", to: "Medium" } });
  });

  it("does not report a rewrite when the value matched exactly (casing only)", () => {
    const item: ItemAspectSource = { ...base, color: "blue" };
    const rewrites: Record<string, AspectRewrite> = {};
    deriveAspectsFromItem(item, [selAspect("Color", ["Blue", "Red"])], {}, rewrites);
    expect(rewrites).toEqual({});
  });

  it("leaves an aspect empty (and unreported) when no confident match exists", () => {
    const item: ItemAspectSource = { ...base, color: "Chartreuse" };
    const rewrites: Record<string, AspectRewrite> = {};
    const out = deriveAspectsFromItem(
      item,
      [selAspect("Color", ["Red", "Blue"])],
      {},
      rewrites,
    );
    expect(out).toEqual({});
    expect(rewrites).toEqual({});
  });
});
