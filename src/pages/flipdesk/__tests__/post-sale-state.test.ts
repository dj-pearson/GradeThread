// US-2227 AC3: the open/closed split for post-sale cases.
//
// The rule is a substring match with OPEN as the default, because eBay's state
// vocabulary is not enumerable from this repo and a guessed enum fails silently
// on the first unanticipated value. These cases pin the asymmetry that makes
// that safe, and the one word that must never be matched loosely.
import { describe, it, expect } from "vitest";
import {
  byDeadline,
  canMarkReceived,
  deadlineBucket,
  deadlineLabel,
  daysUntil,
  isClosedCase,
  isNotAsDescribed,
  isOverdue,
  splitByOpenState,
} from "@/pages/flipdesk/post-sale-state";
import fixture from "../../../test/fixtures/post-sale-state-cases.json";

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

// US-2409: the same rule now runs on Android, in Kotlin. A source diff cannot
// guard a port across languages, so both suites read one fixture — this one.
describe("shared fixture (web ↔ Android)", () => {
  it("classifies every recorded state the same way", () => {
    for (const c of fixture.isClosed) {
      expect(
        isClosedCase({ state: c.state, status: c.status }),
        `${c.state ?? "null"}/${c.status ?? "null"}: ${c.why}`,
      ).toBe(c.closed);
    }
  });

  it("counts the days to a deadline the same way", () => {
    for (const c of fixture.daysUntil) {
      const now = new Date(c.nowIso).getTime();
      expect(daysUntil(c.atIso, now), `${c.atIso} from ${c.nowIso}`).toBe(
        c.days,
      );
    }
  });

  it("calls a passed deadline overdue, and an unreadable one not", () => {
    const now = new Date("2026-08-11T00:00:00Z").getTime();
    for (const c of fixture.daysUntil) {
      expect(isOverdue(c.atIso, new Date(c.nowIso).getTime())).toBe(
        c.days != null && c.days < 0,
      );
    }
    expect(isOverdue("next tuesday", now)).toBe(false);
  });
});


describe("canMarkReceived (US-2930)", () => {
  it("says no while the return is still waiting on the buyer", () => {
    // The case the rule exists for. Offering the action here invites the seller
    // to tell eBay a parcel arrived that was never posted.
    expect(canMarkReceived("RETURN_REQUESTED")).toBe(false);
    expect(canMarkReceived("RETURN_APPROVED")).toBe(false);
    expect(canMarkReceived("AWAITING_SHIPMENT")).toBe(false);
  });

  it("says yes once the item is moving", () => {
    expect(canMarkReceived("ITEM_SHIPPED")).toBe(true);
    expect(canMarkReceived("IN_TRANSIT")).toBe(true);
    expect(canMarkReceived("ITEM_DELIVERED")).toBe(true);
  });

  it("says yes on tracking alone, because eBay's state lags the carrier scan", () => {
    expect(canMarkReceived("RETURN_APPROVED", true)).toBe(true);
  });

  it("says no once it is already received or the case is closed", () => {
    expect(canMarkReceived("ITEM_RECEIVED")).toBe(false);
    expect(canMarkReceived("ITEM_RECEIVED", true)).toBe(false);
    expect(canMarkReceived("RETURN_CLOSED")).toBe(false);
    expect(canMarkReceived("REFUNDED", true)).toBe(false);
  });

  it("defaults to NO on an unknown state — the opposite of isClosedCase", () => {
    expect(canMarkReceived(null)).toBe(false);
    expect(canMarkReceived("")).toBe(false);
    expect(canMarkReceived("SOMETHING_EBAY_ADDED_TOMORROW")).toBe(false);
  });
});


describe("deadlineBucket / deadlineLabel (US-2933)", () => {
  const NOW = Date.parse("2026-08-27T12:00:00.000Z");
  const inDays = (d: number) => new Date(NOW + d * 86_400_000).toISOString();

  it("buckets by days left", () => {
    expect(deadlineBucket(inDays(-1), NOW)).toBe("overdue");
    // Under a day, not "days === 0": daysUntil ceilings, so a zero-day case is
    // only ever the exact instant the clock runs out.
    expect(deadlineBucket(inDays(0.2), NOW)).toBe("imminent");
    expect(deadlineBucket(inDays(0.9), NOW)).toBe("imminent");
    expect(deadlineBucket(inDays(1.5), NOW)).toBe("soon");
    expect(deadlineBucket(inDays(9), NOW)).toBe("later");
  });

  it("returns null for a date it cannot read — never 'overdue'", () => {
    // The one that matters. A parse failure rendering as Overdue looks exactly
    // like a case the seller has already lost, and they go hunting for work
    // that is not there.
    expect(deadlineBucket(null, NOW)).toBeNull();
    expect(deadlineBucket(undefined, NOW)).toBeNull();
    expect(deadlineBucket("not a date", NOW)).toBeNull();
    expect(deadlineLabel(null, NOW)).toBeNull();
  });

  it("labels the bucket as words, so colour is never the only signal", () => {
    expect(deadlineLabel(inDays(-1), NOW)).toBe("Overdue");
    expect(deadlineLabel(inDays(0.2), NOW)).toBe("Under a day left");
    expect(deadlineLabel(inDays(1.5), NOW)).toBe("2d left");
  });
});

describe("byDeadline (US-2933)", () => {
  const rows = [
    { id: "none", respondBy: null },
    { id: "late", respondBy: "2026-09-10T00:00:00.000Z" },
    { id: "soon", respondBy: "2026-08-28T00:00:00.000Z" },
    { id: "unreadable", respondBy: "whenever" },
  ];

  it("sorts soonest first and puts undated cases LAST", () => {
    // Undated last, not first: a case eBay is running no clock on is genuinely
    // less urgent than any case that has one.
    expect(byDeadline(rows, (r) => r.respondBy).map((r) => r.id)).toEqual([
      "soon",
      "late",
      "none",
      "unreadable",
    ]);
  });

  it("does not mutate its input", () => {
    const before = rows.map((r) => r.id);
    byDeadline(rows, (r) => r.respondBy);
    expect(rows.map((r) => r.id)).toEqual(before);
  });
});


describe("isNotAsDescribed (US-2935)", () => {
  it("recognises the condition complaints a grade report can argue about", () => {
    expect(isNotAsDescribed("NOT_AS_DESCRIBED")).toBe(true);
    expect(isNotAsDescribed("DEFECTIVE_ITEM")).toBe(true);
    expect(isNotAsDescribed("ARRIVED_DAMAGED")).toBe(true);
    expect(isNotAsDescribed("WRONG_ITEM")).toBe(true);
    expect(isNotAsDescribed("COUNTERFEIT")).toBe(true);
  });

  it("says no to complaints that are not about condition", () => {
    // An INR case is about the post and a changed-mind return is about the
    // buyer. Pre-loading a condition argument on either puts noise in front of
    // a seller trying to act quickly.
    expect(isNotAsDescribed("ITEM_NOT_RECEIVED")).toBe(false);
    expect(isNotAsDescribed("BUYER_CHANGED_MIND")).toBe(false);
    expect(isNotAsDescribed("ORDERED_WRONG_SIZE")).toBe(false);
  });

  it("defaults to NO on an unknown or missing reason", () => {
    // The opposite asymmetry to isClosedCase, and deliberately: a missed SNAD
    // costs one extra click on a button still sitting right there.
    expect(isNotAsDescribed(null)).toBe(false);
    expect(isNotAsDescribed(undefined)).toBe(false);
    expect(isNotAsDescribed("")).toBe(false);
    expect(isNotAsDescribed("SOMETHING_EBAY_ADDED_TOMORROW")).toBe(false);
  });
});
