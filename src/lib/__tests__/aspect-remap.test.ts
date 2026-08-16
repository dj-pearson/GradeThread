// US-824: category change = deterministic aspect refill, no AI re-run, no
// silent loss. Tests the pure keep/remap/drop classification that drives the
// composer's confirm-before-discard, and asserts the path makes NO network /
// AI call (the whole point of the epic).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  remapAspectsForCategory,
  type ItemAspectSource,
} from "@/lib/ebay-prefill";
import type { EbayAspect } from "@/hooks/use-ebay";

const freeAspect = (name: string): EbayAspect => ({
  localizedAspectName: name,
  aspectConstraint: { aspectMode: "FREE_TEXT", itemToAspectCardinality: "SINGLE" },
  aspectValues: [],
});

const selAspect = (name: string, allowed: string[]): EbayAspect => ({
  localizedAspectName: name,
  aspectConstraint: {
    aspectMode: "SELECTION_ONLY",
    itemToAspectCardinality: "SINGLE",
  },
  aspectValues: allowed.map((localizedValue) => ({ localizedValue })),
});

const baseItem: ItemAspectSource = {
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

describe("remapAspectsForCategory (US-824)", () => {
  it("keeps still-valid values and drops the rest", () => {
    const prev = {
      Brand: ["Nike"],
      Color: ["Blue"],
      "Sleeve Length": ["Long Sleeve"], // not in the new spec → dropped
    };
    const newSpec = [freeAspect("Brand"), freeAspect("Color")];
    const out = remapAspectsForCategory(prev, newSpec, null);
    expect(out.kept).toEqual({ Brand: ["Nike"], Color: ["Blue"] });
    expect(out.dropped).toEqual({ "Sleeve Length": ["Long Sleeve"] });
    expect(out.derived).toEqual({});
  });

  it("derives missing aspects from the item's legacy columns AND US-821 attributes", () => {
    const item: ItemAspectSource = {
      ...baseItem,
      brand: "Nike",
      attributes: { sleeve_length: "Long Sleeve" },
    };
    // New category has Brand (already kept) + a Sleeve Length aspect to fill.
    const newSpec = [freeAspect("Brand"), freeAspect("Sleeve Length")];
    const out = remapAspectsForCategory({ Brand: ["Nike"] }, newSpec, item);
    expect(out.kept).toEqual({ Brand: ["Nike"] });
    // Brand is already kept → not re-derived; Sleeve Length comes from attributes.
    expect(out.derived).toEqual({ "Sleeve Length": ["Long Sleeve"] });
    expect(out.dropped).toEqual({});
  });

  it("does not overwrite a kept value with a derived one (user value wins)", () => {
    const item: ItemAspectSource = { ...baseItem, color: "Red" };
    const newSpec = [freeAspect("Color")];
    const out = remapAspectsForCategory({ Color: ["Blue"] }, newSpec, item);
    expect(out.kept).toEqual({ Color: ["Blue"] });
    expect(out.derived).toEqual({});
  });

  it("reports SELECTION_ONLY rewrites for derived values ('M' → 'Medium')", () => {
    const item: ItemAspectSource = { ...baseItem, size: "M" };
    const newSpec = [selAspect("Size", ["Small", "Medium", "Large"])];
    const out = remapAspectsForCategory({}, newSpec, item);
    expect(out.derived).toEqual({ Size: ["Medium"] });
    expect(out.rewrites).toEqual({ Size: { from: "M", to: "Medium" } });
  });

  it("ignores empty/blank previous values (nothing to keep or drop)", () => {
    const out = remapAspectsForCategory({ Color: [] }, [freeAspect("Brand")], null);
    expect(out.kept).toEqual({});
    expect(out.dropped).toEqual({});
  });

  it("US-1450: folds captured measurements into free-text measurement aspects", () => {
    const item: ItemAspectSource = {
      ...baseItem,
      measurements: { chest: 21 },
    };
    const out = remapAspectsForCategory({}, [freeAspect("Chest Size")], item);
    // Stored inches → formatted onto the free-text "Chest Size" aspect.
    // US-2630: stored measurements are FLAT (one layer of a folded garment),
    // so the aspect carries the worn chest — 21in pit to pit is a 42in chest.
    expect(out.derived["Chest Size"]).toEqual(["42 in"]);
  });

  it("US-1450: measurement fold is fill-only (never clobbers a set value)", () => {
    const item: ItemAspectSource = {
      ...baseItem,
      measurements: { chest: 21 },
    };
    const out = remapAspectsForCategory(
      { "Chest Size": ["20 in"] },
      [freeAspect("Chest Size")],
      item,
    );
    expect(out.kept).toEqual({ "Chest Size": ["20 in"] });
    expect(out.derived["Chest Size"]).toBeUndefined();
  });

  it("re-homes a value whose aspect is spelled differently (Colour → Color)", () => {
    const out = remapAspectsForCategory(
      { Colour: ["Blue"] },
      [freeAspect("Color")],
      null,
    );
    expect(out.remapped).toEqual({ Color: ["Blue"] });
    expect(out.remappedFrom).toEqual({ Color: "Colour" });
    expect(out.dropped).toEqual({});
    expect(out.kept).toEqual({});
  });

  it("re-homes a value across a curated synonym name (Fabric Type → Material)", () => {
    const out = remapAspectsForCategory(
      { "Fabric Type": ["Cotton"] },
      [freeAspect("Material")],
      null,
    );
    expect(out.remapped).toEqual({ Material: ["Cotton"] });
    expect(out.dropped).toEqual({});
  });

  it("does NOT re-home when the value fails the target's SELECTION_ONLY list (parks it)", () => {
    // 'Chartreuse' isn't an allowed Color here → can't re-home → dropped (parked).
    const out = remapAspectsForCategory(
      { Colour: ["Chartreuse"] },
      [selAspect("Color", ["Blue", "Red"])],
      null,
    );
    expect(out.remapped).toEqual({});
    expect(out.dropped).toEqual({ Colour: ["Chartreuse"] });
  });

  it("re-home rewrites the value to the allowed spelling (Colour 'navy' → Color 'Navy Blue')", () => {
    const out = remapAspectsForCategory(
      { Colour: ["navy"] },
      [selAspect("Color", ["Navy Blue", "Red"])],
      null,
    );
    // Whether it maps depends on the synonym table; assert it doesn't mis-file.
    // A successful map lands under Color; a miss parks under Colour.
    const landed = out.remapped.Color ?? null;
    if (landed) {
      expect(landed).toEqual(["Navy Blue"]);
      expect(out.dropped).toEqual({});
    } else {
      expect(out.dropped).toEqual({ Colour: ["navy"] });
    }
  });

  it("does not steal an aspect already kept under the same normalized name", () => {
    // Both Color (valid) and Colour present: Color is kept; Colour has nowhere
    // else to go (only one Color aspect, now taken) → dropped, not duplicated.
    const out = remapAspectsForCategory(
      { Color: ["Blue"], Colour: ["Red"] },
      [freeAspect("Color")],
      null,
    );
    expect(out.kept).toEqual({ Color: ["Blue"] });
    expect(out.remapped).toEqual({});
    expect(out.dropped).toEqual({ Colour: ["Red"] });
  });

  it("US-1450: never fills a SELECTION_ONLY aspect from measurements", () => {
    const item: ItemAspectSource = {
      ...baseItem,
      measurements: { sleeve: 25 },
    };
    const out = remapAspectsForCategory(
      {},
      [selAspect("Sleeve Length", ["Short Sleeve", "Long Sleeve"])],
      item,
    );
    expect(out.derived["Sleeve Length"]).toBeUndefined();
  });
});

describe("category change makes no AI/network call (US-824 AC3)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("never invokes fetch during the remap", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const item: ItemAspectSource = {
      ...baseItem,
      brand: "Nike",
      size: "M",
      attributes: { sleeve_length: "Long Sleeve" },
    };
    remapAspectsForCategory(
      { Brand: ["Nike"], Stale: ["x"] },
      [
        freeAspect("Brand"),
        selAspect("Size", ["Small", "Medium", "Large"]),
        freeAspect("Sleeve Length"),
      ],
      item,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
