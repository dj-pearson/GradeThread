import { describe, it, expect } from "vitest";
import {
  isPlaceholderBrand,
  splitPlaceholderBrandRows,
} from "@/lib/placeholder-brand";

describe("isPlaceholderBrand", () => {
  it("treats blank and missing as a placeholder", () => {
    expect(isPlaceholderBrand(null)).toBe(true);
    expect(isPlaceholderBrand(undefined)).toBe(true);
    expect(isPlaceholderBrand("")).toBe(true);
    expect(isPlaceholderBrand("   ")).toBe(true);
  });

  it("treats the coalesced report label as a placeholder", () => {
    // The sell-through RPC and capitalVelocity() both COALESCE an empty brand
    // to this label before the row ever reaches the client.
    expect(isPlaceholderBrand("No brand")).toBe(true);
  });

  it("treats the sheet placeholder words as placeholders, any case", () => {
    for (const s of [
      "Unknown",
      "unknown",
      "UNKNOWN",
      " Unknown Brand ",
      "n/a",
      "N/A",
      "na",
      "none",
      "None",
      "tbd",
      "TBD",
      "unspecified",
      "not specified",
      "placeholder",
      "-",
      "--",
      "?",
      "???",
      ".",
    ]) {
      expect(isPlaceholderBrand(s), s).toBe(true);
    }
  });

  it("leaves real brands alone, including the ones that read like nothing", () => {
    for (const s of [
      "Nike",
      // eBay's own aspect value for a genuinely brandless garment. A seller
      // who typed this MEANT it, so it is data, not a gap.
      "Unbranded",
      "No Fear",
      "None of the Above",
      "NA-KD",
      "Vintage",
      "Handmade",
    ]) {
      expect(isPlaceholderBrand(s), s).toBe(false);
    }
  });
});

describe("splitPlaceholderBrandRows", () => {
  const rows = [
    { group: "Nike", sold: 4 },
    { group: "No brand", sold: 3 },
    { group: "Unknown", sold: 2 },
    { group: "Unbranded", sold: 1 },
  ];

  it("keeps real brands and pulls the placeholders aside", () => {
    const split = splitPlaceholderBrandRows(rows, (r) => r.group);
    expect(split.real.map((r) => r.group)).toEqual(["Nike", "Unbranded"]);
    expect(split.placeholder.map((r) => r.group)).toEqual([
      "No brand",
      "Unknown",
    ]);
  });

  it("preserves the incoming order inside each side", () => {
    const split = splitPlaceholderBrandRows(
      [
        { group: "Unknown", sold: 9 },
        { group: "Levi's", sold: 8 },
        { group: "n/a", sold: 7 },
        { group: "Carhartt", sold: 6 },
      ],
      (r) => r.group,
    );
    expect(split.real.map((r) => r.group)).toEqual(["Levi's", "Carhartt"]);
    expect(split.placeholder.map((r) => r.group)).toEqual(["Unknown", "n/a"]);
  });

  it("returns empty sides for an empty input", () => {
    const split = splitPlaceholderBrandRows([], (r: { group: string }) => r.group);
    expect(split.real).toEqual([]);
    expect(split.placeholder).toEqual([]);
  });
});
