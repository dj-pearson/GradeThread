import { describe, expect, it } from "vitest";
import { chunk } from "./chunk";

describe("chunk", () => {
  it("splits into slices of at most `size`, preserving order", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns a single chunk when the list fits", () => {
    expect(chunk([1, 2, 3], 100)).toEqual([[1, 2, 3]]);
  });

  it("returns exactly-full chunks with no trailing empty chunk", () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });

  it("returns [] for an empty list", () => {
    expect(chunk([], 100)).toEqual([]);
  });

  it("never loses or duplicates elements (300 items @ 100)", () => {
    const items = Array.from({ length: 300 }, (_, i) => i);
    const chunks = chunk(items, 100);
    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.flat()).toEqual(items);
  });

  it("puts the remainder in a final short chunk (301 items @ 100)", () => {
    const items = Array.from({ length: 301 }, (_, i) => i);
    const chunks = chunk(items, 100);
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 100, 1]);
  });

  it("throws on a non-positive or non-integer size", () => {
    expect(() => chunk([1], 0)).toThrow();
    expect(() => chunk([1], -1)).toThrow();
    expect(() => chunk([1], 1.5)).toThrow();
  });
});
