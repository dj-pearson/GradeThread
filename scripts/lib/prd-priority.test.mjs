// US-2371: the backlog's sort direction, pinned. Before this file the direction
// existed only as a subtraction inside run-sdk.mjs, and the backlog's own
// numbers had been authored against the opposite one.
import { describe, expect, it } from "vitest";
import { comparePriority, idNumber, isValidPriority, priorityRank, UNRANKED } from "./prd-priority.mjs";

const s = (id, priority) => (priority === undefined ? { id } : { id, priority });

describe("isValidPriority", () => {
  it("allows absent — that is 'unranked', not an error", () => {
    expect(isValidPriority(undefined)).toBe(true);
  });
  it("allows any finite number, including negatives and zero", () => {
    expect(isValidPriority(0)).toBe(true);
    expect(isValidPriority(-98701)).toBe(true);
    expect(isValidPriority(2544)).toBe(true);
  });
  it("rejects the values that poison the comparator", () => {
    for (const bad of ["58", null, Number.NaN, Number.POSITIVE_INFINITY, {}, []]) {
      expect(isValidPriority(bad)).toBe(false);
    }
  });
});

describe("priorityRank", () => {
  it("sends a missing priority to the back, not to zero", () => {
    expect(priorityRank(s("US-1"))).toBe(UNRANKED);
    expect(priorityRank(s("US-1", 0))).toBe(0);
  });
});

describe("comparePriority", () => {
  it("sorts ascending: the lowest number is the highest priority", () => {
    const order = [s("US-3", 58), s("US-1", -98701), s("US-2", 2544)]
      .sort(comparePriority)
      .map((x) => x.id);
    expect(order).toEqual(["US-1", "US-3", "US-2"]);
  });

  it("keeps unranked stories at the very end", () => {
    const order = [s("US-3"), s("US-1", 2544), s("US-2", -1)]
      .sort(comparePriority)
      .map((x) => x.id);
    expect(order).toEqual(["US-2", "US-1", "US-3"]);
  });

  it("orders unranked stories among themselves by id instead of arbitrarily", () => {
    const order = [s("US-9"), s("US-4"), s("US-7")].sort(comparePriority).map((x) => x.id);
    expect(order).toEqual(["US-4", "US-7", "US-9"]);
  });

  it("is a total order — sorting twice gives the same answer", () => {
    const input = [s("US-9", 5), s("US-4", 5), s("US-7"), s("US-2", -3), s("US-8")];
    const once = [...input].sort(comparePriority).map((x) => x.id);
    const twice = [...input].reverse().sort(comparePriority).map((x) => x.id);
    expect(once).toEqual(twice);
  });
});

describe("idNumber", () => {
  it("reads the number out of a US- id", () => {
    expect(idNumber({ id: "US-2371" })).toBe(2371);
  });
  it("sorts an unparseable id last within its tie group", () => {
    expect(idNumber({ id: "junk" })).toBe(Number.MAX_SAFE_INTEGER);
  });
});
