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


describe("normalizeAspectValue on eBay's OPEN lists (US-3016)", () => {
  const open = (name: string, allowedValues: string[]) => ({
    name,
    mode: "FREE_TEXT",
    allowedValues,
  });
  const PROD_COLOR = [
    "Beige", "Black", "Blue", "Brown", "Clear", "Gold", "Gray", "Green",
    "Ivory", "Multicolor", "Orange", "Pink", "Purple", "Red", "Silver", "Tan",
    "White", "Yellow",
  ];
  const PROD_RISE = [
    "Ultra Low (Less than 8 in)",
    "Low (8-10 in)",
    "Mid (10-12 in)",
    "High (Greater than 12 in)",
  ];

  it("narrows a FREE_TEXT Color, which is 107 of prod's 121 cached categories", () => {
    expect(normalizeAspectValue("Taupe", open("Color", PROD_COLOR))).toBe("Beige");
    expect(normalizeAspectValue("Sage Green", open("Color", PROD_COLOR))).toBe("Green");
    expect(normalizeAspectValue("Charcoal", open("Color", PROD_COLOR))).toBe("Gray");
  });

  it("reaches the label half of a measured range", () => {
    expect(normalizeAspectValue("High Rise", open("Rise", PROD_RISE))).toBe(
      "High (Greater than 12 in)",
    );
    expect(normalizeAspectValue("Low", open("Rise", PROD_RISE))).toBe("Low (8-10 in)");
  });

  it("keeps the seller's own words when nothing on the list fits", () => {
    expect(normalizeAspectValue("Iridescent Oil-Slick", open("Color", PROD_COLOR))).toBe(
      "Iridescent Oil-Slick",
    );
  });
});

describe("normalizeAspectValue family narrowing (US-3016)", () => {
  const COLOR = [
    "Beige",
    "Black",
    "Blue",
    "Brown",
    "Gold",
    "Gray",
    "Green",
    "Ivory",
    "Multicolor",
    "Orange",
    "Pink",
    "Purple",
    "Red",
    "Silver",
    "White",
    "Yellow",
  ];
  const DRESS_LENGTH = ["Short", "Knee Length", "Midi", "Long", "Hi-Low", "Asymmetric"];

  it("narrows a descriptive color onto eBay's coarse bucket", () => {
    expect(normalizeAspectValue("Taupe", sel("Color", COLOR))).toBe("Beige");
    expect(normalizeAspectValue("Sage Green", sel("Color", COLOR))).toBe("Green");
    expect(normalizeAspectValue("Burgundy", sel("Color", COLOR))).toBe("Red");
    expect(normalizeAspectValue("Heather Charcoal", sel("Color", COLOR))).toBe("Gray");
  });

  it("maps a hem length onto whichever vocabulary the category uses", () => {
    expect(normalizeAspectValue("Mini", sel("Dress Length", DRESS_LENGTH))).toBe("Short");
    expect(normalizeAspectValue("Mini", sel("Skirt Length", ["Mini", "Midi", "Maxi"]))).toBe(
      "Mini",
    );
    expect(normalizeAspectValue("Tea Length", sel("Dress Length", DRESS_LENGTH))).toBe("Midi");
  });

  it("runs last, so an exactly-offered value is never coarsened", () => {
    expect(normalizeAspectValue("Olive", sel("Color", ["Olive", "Green"]))).toBe("Olive");
    expect(normalizeAspectValue("Navy Blue", sel("Color", ["Navy", "Blue"]))).toBe("Navy");
  });

  it("refuses when no bucket in the value's family is allowed", () => {
    expect(normalizeAspectValue("Taupe", sel("Color", ["Red", "Blue"]))).toBeNull();
    expect(normalizeAspectValue("Taupe", sel("Brand", ["Nike", "Adidas"]))).toBeNull();
  });
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
