import { describe, it, expect } from "vitest";
import { orderIdsByScore, pageSlice, reorderByIds } from "./list-sort";

// US-1651: the global grade-sort for the submissions list orders ACROSS all rows
// (not just the page), keeps ungraded rows visible (nulls last, both directions),
// and stays deterministic so pagination doesn't shuffle between fetches.
describe("orderIdsByScore", () => {
  const scores = { a: 8.5, b: 6.0, c: 9.2, d: null, e: undefined } as const;

  it("sorts by score descending with nulls last", () => {
    expect(orderIdsByScore(["a", "b", "c", "d", "e"], scores, "desc")).toEqual([
      "c",
      "a",
      "b",
      "d",
      "e", // d,e ungraded → last, tie-broken by id (d < e)
    ]);
  });

  it("sorts ascending but STILL keeps nulls last", () => {
    expect(orderIdsByScore(["a", "b", "c", "d", "e"], scores, "asc")).toEqual([
      "b",
      "a",
      "c",
      "d",
      "e",
    ]);
  });

  it("breaks score ties by id for stable pagination", () => {
    const tied = { x2: 7, x1: 7, x3: 7 };
    expect(orderIdsByScore(["x3", "x1", "x2"], tied, "desc")).toEqual(["x1", "x2", "x3"]);
    // Same order regardless of input order → deterministic across page fetches.
    expect(orderIdsByScore(["x2", "x3", "x1"], tied, "asc")).toEqual(["x1", "x2", "x3"]);
  });

  it("does not mutate the input array", () => {
    const ids = ["a", "b", "c"];
    orderIdsByScore(ids, scores, "desc");
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("treats a missing key as ungraded (null)", () => {
    expect(orderIdsByScore(["a", "missing"], { a: 5 }, "desc")).toEqual(["a", "missing"]);
  });
});

describe("pageSlice", () => {
  const ordered = ["a", "b", "c", "d", "e"];
  it("slices the page window", () => {
    expect(pageSlice(ordered, 0, 2)).toEqual(["a", "b"]);
    expect(pageSlice(ordered, 1, 2)).toEqual(["c", "d"]);
    expect(pageSlice(ordered, 2, 2)).toEqual(["e"]); // partial last page
    expect(pageSlice(ordered, 3, 2)).toEqual([]); // past the end
  });
  it("clamps a negative page to 0", () => {
    expect(pageSlice(ordered, -1, 2)).toEqual(["a", "b"]);
  });
});

describe("reorderByIds", () => {
  it("restores the target order from an unordered .in() fetch", () => {
    const byId = new Map([
      ["b", { id: "b" }],
      ["a", { id: "a" }],
      ["c", { id: "c" }],
    ]);
    expect(reorderByIds(["a", "b", "c"], byId)).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
  });
  it("skips ids missing from the fetch (defensive)", () => {
    const byId = new Map([["a", { id: "a" }]]);
    expect(reorderByIds(["a", "gone"], byId)).toEqual([{ id: "a" }]);
  });
});
