// US-2339 AC4 — the arithmetic the drift audit's only CERTAIN finding rests on.
//
// The audit's claim is that a recurring child sitting on a day the generator
// would not produce is provably not a generated date. That claim is only as good
// as this function agreeing with monthlyDueDates() in the edge service, so both
// the agreement and the one case a naive version gets wrong are pinned here.
//
// No database. The reachable-database half of the script is exercised by running
// it; this is the part that has to be right before the output means anything.
import { describe, expect, it } from "vitest";
import { driftedChildren, generatedDay } from "./audit-expense-date-drift.mjs";

describe("generatedDay", () => {
  it("uses the anchor day when the month is long enough", () => {
    expect(generatedDay(15, 2026, 2)).toBe(15);
    expect(generatedDay(1, 2026, 12)).toBe(1);
    expect(generatedDay(28, 2026, 2)).toBe(28);
  });

  // THE CASE A NAIVE CHECK REPORTS WRONGLY, and the reason this is tested at all.
  // A template on the 31st produces a 28th in February and a 30th in April. Both
  // are generated dates. Flagging them would put every end-of-month recurring
  // expense on an operator's remediation list.
  it("clamps to the end of a short month, which is generated and not drift", () => {
    expect(generatedDay(31, 2026, 2)).toBe(28);
    expect(generatedDay(31, 2026, 4)).toBe(30);
    expect(generatedDay(30, 2026, 2)).toBe(28);
    expect(generatedDay(31, 2026, 1)).toBe(31);
  });

  it("knows February in a leap year", () => {
    // 2024 is a leap year, 2026 is not. Getting this wrong reports every
    // leap-February end-of-month child as drifted, once every four years.
    expect(generatedDay(31, 2024, 2)).toBe(29);
    expect(generatedDay(29, 2024, 2)).toBe(29);
    expect(generatedDay(29, 2026, 2)).toBe(28);
  });
});

describe("driftedChildren", () => {
  const row = (id, childDate, anchorDate, edited) => [
    id,
    "user-1",
    childDate,
    anchorDate,
    edited ? "2026-08-10T00:00:00Z" : "2026-08-01T00:00:00Z",
    "2026-08-01T00:00:00Z",
  ];

  it("passes a child on its generated day", () => {
    expect(driftedChildren([row("a", "2026-02-15", "2026-01-15", true)])).toEqual([]);
  });

  it("passes an end-of-month clamp", () => {
    expect(driftedChildren([row("a", "2026-02-28", "2026-01-31", true)])).toEqual([]);
  });

  it("reports a child that drifted backwards, with the delta", () => {
    const [found] = driftedChildren([row("a", "2026-03-12", "2026-01-15", true)]);
    expect(found.expectedDay).toBe(15);
    expect(found.actualDay).toBe(12);
    expect(found.deltaDays).toBe(-3);
    expect(found.edited).toBe(true);
  });

  it("reports an off-day child that was NEVER re-saved, but marks it", () => {
    // This bug fires on re-save. An off-day row that has only been saved once is
    // a hand edit or a bad import, and reporting it as drift would send an
    // operator after the wrong thing. Reported, flagged, not conflated.
    const [found] = driftedChildren([row("a", "2026-04-09", "2026-01-15", false)]);
    expect(found.edited).toBe(false);
    expect(found.deltaDays).toBe(-6);
  });

  it("distinguishes a LATER date, which is not this bug's direction", () => {
    // The drift is directional: west of Greenwich, always backwards. A child on a
    // later day is something else, and the sign is what says so.
    const [found] = driftedChildren([row("a", "2026-02-20", "2026-01-15", true)]);
    expect(found.deltaDays).toBe(5);
  });
});
