// US-1891: backwards title sync (frontend mirror) — parity with the edge suite.
import { describe, expect, it } from "vitest";
import {
  applyTitleSubstitution,
  changesFromItemDiff,
  syncTitle,
  titleNeedsSync,
  trimTitleToLimit,
} from "../title-sync";

describe("applyTitleSubstitution", () => {
  it("swaps single- and multi-word brands, case-insensitively", () => {
    expect(applyTitleSubstitution("Nike Air Max L", "Nike", "Adidas")).toBe("Adidas Air Max L");
    expect(applyTitleSubstitution("The North Face Jacket L", "The North Face", "Patagonia"))
      .toBe("Patagonia Jacket L");
    expect(applyTitleSubstitution("NIKE tee", "Nike", "Adidas")).toBe("ADIDAS tee");
  });
  it("swaps size tokens (bare / Size L / Sz L) but not inside XL", () => {
    expect(applyTitleSubstitution("Hoodie L Fleece", "L", "M")).toBe("Hoodie M Fleece");
    expect(applyTitleSubstitution("Dress Size L", "L", "M")).toBe("Dress Size M");
    expect(applyTitleSubstitution("Dress Sz L", "L", "M")).toBe("Dress Sz M");
    expect(applyTitleSubstitution("Hoodie XL", "L", "M")).toBe("Hoodie XL");
  });
  it("is a no-op when the old value is absent or empty/identical", () => {
    expect(applyTitleSubstitution("Adidas Tee", "Nike", "Puma")).toBe("Adidas Tee");
    expect(applyTitleSubstitution("Nike Tee", "Nike", "nike")).toBe("Nike Tee");
    expect(applyTitleSubstitution("Nike Tee", "", "Puma")).toBe("Nike Tee");
  });
  it("does not match inside another word", () => {
    expect(applyTitleSubstitution("Nikeish tee", "Nike", "Adidas")).toBe("Nikeish tee");
  });
});

describe("syncTitle", () => {
  it("applies multiple changes and re-trims to 80", () => {
    expect(syncTitle("Nike Tee Blue M", [
      { from: "Nike", to: "Adidas" },
      { from: "Blue", to: "Red" },
    ])).toBe("Adidas Tee Red M");
    const title = "Nike Mens Running Sneakers Size 11 White Black Leather Athletic Shoes Pair";
    const out = syncTitle(title, [{ from: "Nike", to: "Under Armour" }]);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.startsWith("Under Armour Mens Running")).toBe(true);
  });
});

describe("titleNeedsSync + changesFromItemDiff", () => {
  it("detects real changes only", () => {
    expect(titleNeedsSync("Nike Tee M", [{ from: "Nike", to: "Adidas" }])).toBe(true);
    expect(titleNeedsSync("Nike Tee M", [{ from: "Puma", to: "Adidas" }])).toBe(false);
  });
  it("keeps only changed syncable fields", () => {
    const changes = changesFromItemDiff(
      { brand: "Nike", size: "L", color: "Blue", style: "Retro", department: "Men" },
      { brand: "Adidas", size: "L", color: "Red", style: "Retro", department: "Men" },
    );
    expect(changes.map((c) => c.field).sort()).toEqual(["brand", "color"]);
  });
});

describe("trimTitleToLimit (mirror)", () => {
  it("word-boundary trims and never slices mid-word", () => {
    expect(trimTitleToLimit("a".repeat(40) + " bb", 40)).toBe("a".repeat(40));
    expect(trimTitleToLimit("short title", 80)).toBe("short title");
  });
});
