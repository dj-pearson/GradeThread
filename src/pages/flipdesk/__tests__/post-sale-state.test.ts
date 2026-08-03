// US-2227 AC3: the open/closed split for post-sale cases.
//
// The rule is a substring match with OPEN as the default, because eBay's state
// vocabulary is not enumerable from this repo and a guessed enum fails silently
// on the first unanticipated value. These cases pin the asymmetry that makes
// that safe, and the one word that must never be matched loosely.
import { describe, it, expect } from "vitest";
import { isClosedCase, splitByOpenState } from "@/pages/flipdesk/post-sale-state";

describe("isClosedCase", () => {
  it("treats terminal states as closed", () => {
    for (
      const state of [
        "CLOSED",
        "REFUND_COMPLETED",
        "RETURN_CANCELLED",
        "RETURN_DECLINED",
        "REFUNDED",
        "CASE_RESOLVED",
      ]
    ) {
      expect(isClosedCase({ state }), state).toBe(true);
    }
  });

  it("treats REFUND_OVERDUE as OPEN — it is the most urgent open case there is", () => {
    // The trap this list is shaped around. Matching the bare word REFUND would
    // bury a refund the seller OWES and has not issued, which is the single row
    // most needing action, in a history tab they have no reason to open.
    expect(isClosedCase({ state: "REFUND_OVERDUE" })).toBe(false);
    expect(isClosedCase({ state: "REFUND_INITIATED" })).toBe(false);
    expect(isClosedCase({ state: "REFUND_PENDING" })).toBe(false);
  });

  it("treats in-flight states as open", () => {
    for (const state of ["RETURN_REQUESTED", "ITEM_SHIPPED", "ITEM_DELIVERED"]) {
      expect(isClosedCase({ state }), state).toBe(false);
    }
  });

  it("defaults an unknown or missing state to OPEN", () => {
    // The load-bearing asymmetry. Hiding an open case costs the seller the
    // case; showing a closed one costs them a glance. A state eBay invents
    // tomorrow must fall on the second side.
    expect(isClosedCase({ state: null })).toBe(false);
    expect(isClosedCase({ state: "" })).toBe(false);
    expect(isClosedCase({})).toBe(false);
    expect(isClosedCase({ state: "SOME_STATE_EBAY_ADDS_LATER" })).toBe(false);
  });

  it("reads status as well as state, so one rule covers all three cards", () => {
    // Returns and cancellations carry `state`; payment disputes carry `status`.
    expect(isClosedCase({ status: "CLOSED" })).toBe(true);
    expect(isClosedCase({ status: "ACTION_NEEDED" })).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isClosedCase({ state: "closed" })).toBe(true);
  });
});

describe("splitByOpenState", () => {
  it("partitions without losing or duplicating a case", () => {
    const cases = [
      { id: "a", state: "RETURN_REQUESTED" },
      { id: "b", state: "CLOSED" },
      { id: "c", state: "REFUND_OVERDUE" },
      { id: "d", state: null },
    ];
    const { open, closed } = splitByOpenState(cases);
    expect(open.map((c) => c.id)).toEqual(["a", "c", "d"]);
    expect(closed.map((c) => c.id)).toEqual(["b"]);
    expect(open.length + closed.length).toBe(cases.length);
  });

  it("handles an empty list", () => {
    expect(splitByOpenState([])).toEqual({ open: [], closed: [] });
  });
});
