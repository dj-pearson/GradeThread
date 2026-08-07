// US-1851 AC3: the buyer confirmation streak, with grace and per-quarter freezes.
//
// This is the ONLY streak GradeThread shows a human, so its two protections have
// to behave exactly as the copy promises: the week you are IN never breaks the
// chain (free), and a week that genuinely passed empty is covered by a freeze
// (spent, capped per quarter). Everything here is local-time by design — a buyer
// experiences "this week" in their own zone — so the fixtures are built from
// local Y/M/D rather than fixed UTC instants.

import { describe, expect, it } from "vitest";

import {
  computeConfirmationStreak,
  STREAK_FREEZES_PER_QUARTER,
} from "@/lib/buyer-streak";

/** A confirmation at local noon on the given calendar day. */
const on = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).toISOString();

/** "Now" at local noon on the given calendar day. */
const now = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();

// 2026-08-07 is a Friday, so that week's Monday is 2026-08-03. Every Monday used
// below is derived from that anchor.

describe("grace — the current week never breaks a chain", () => {
  it("keeps the streak while this week is still empty", () => {
    const s = computeConfirmationStreak(
      [on(2026, 7, 28), on(2026, 7, 21)], // weeks of Jul 27 and Jul 20
      now(2026, 8, 7), // week of Aug 3, nothing in it yet
    );
    expect(s.current).toBe(2);
    expect(s.freezesUsed).toBe(0);
    expect(s.atRisk).toBe(false); // grace alone is never "at risk"
  });

  it("counts this week once a confirmation lands in it", () => {
    const s = computeConfirmationStreak(
      [on(2026, 8, 4), on(2026, 7, 28), on(2026, 7, 21)],
      now(2026, 8, 7),
    );
    expect(s.current).toBe(3);
  });

  it("does not double-count two confirmations in the same week", () => {
    const s = computeConfirmationStreak(
      [on(2026, 8, 4), on(2026, 8, 6), on(2026, 7, 28)],
      now(2026, 8, 7),
    );
    expect(s.current).toBe(2);
  });
});

describe("freezes — a week that really passed empty", () => {
  it("spends one freeze to bridge a gap the chain continues past", () => {
    const s = computeConfirmationStreak(
      [on(2026, 8, 4), on(2026, 7, 21), on(2026, 7, 14)], // week of Jul 27 missing
      now(2026, 8, 7),
    );
    expect(s.current).toBe(3);
    expect(s.freezesUsed).toBe(1);
    expect(s.freezesRemaining).toBe(STREAK_FREEZES_PER_QUARTER - 1);
  });

  it("does not spend a freeze on a trailing gap with nothing behind it", () => {
    // Padding an empty tail with freezes would inflate the number with weeks
    // the buyer was never active in.
    const s = computeConfirmationStreak([on(2026, 7, 28)], now(2026, 8, 7));
    expect(s.current).toBe(1);
    expect(s.freezesUsed).toBe(0);
    expect(s.freezesRemaining).toBe(STREAK_FREEZES_PER_QUARTER);
  });

  it("stops at the third gap once the quarter's allowance is spent", () => {
    // Q3 weeks only. Gaps at Sep 14, Aug 31, Aug 17.
    const s = computeConfirmationStreak(
      [on(2026, 9, 22), on(2026, 9, 8), on(2026, 8, 25), on(2026, 8, 11)],
      now(2026, 9, 25), // week of Sep 21, active
    );
    expect(s.current).toBe(3); // Sep 21, Sep 7, Aug 24 — the Aug 17 gap is not covered
    expect(s.freezesUsed).toBe(2);
    expect(s.freezesRemaining).toBe(0);
  });

  it("budgets freezes per quarter of the missed week, not of today", () => {
    // Gap at Jun 29 falls in Q2, so it draws on Q2's allowance even though two
    // Q3 freezes are already spent.
    const s = computeConfirmationStreak(
      [on(2026, 8, 4), on(2026, 7, 21), on(2026, 7, 7), on(2026, 6, 23)],
      now(2026, 8, 7),
    );
    expect(s.current).toBe(4);
    expect(s.freezesUsed).toBe(3);
    expect(s.freezesRemaining).toBe(0); // this quarter's two are gone
  });

  it("still ends the streak after a long absence", () => {
    const s = computeConfirmationStreak(
      [on(2026, 8, 4), on(2026, 5, 5)], // a whole quarter apart
      now(2026, 8, 7),
    );
    expect(s.current).toBe(1);
  });
});

describe("atRisk — the warning that means something", () => {
  it("fires only when this week is empty and no freeze is left", () => {
    const s = computeConfirmationStreak(
      [on(2026, 9, 22), on(2026, 9, 8), on(2026, 8, 25), on(2026, 8, 11)],
      now(2026, 10, 1), // week of Sep 28, empty; Q3 freezes already spent
    );
    expect(s.current).toBe(3);
    expect(s.freezesRemaining).toBe(0);
    expect(s.atRisk).toBe(true);
  });

  it("stays quiet while a freeze could still cover the week", () => {
    const s = computeConfirmationStreak([on(2026, 7, 28)], now(2026, 8, 7));
    expect(s.atRisk).toBe(false);
  });

  it("stays quiet when there is no streak to lose", () => {
    expect(computeConfirmationStreak([], now(2026, 8, 7)).atRisk).toBe(false);
  });
});

describe("longest", () => {
  it("remembers a best run the buyer is no longer on", () => {
    const s = computeConfirmationStreak(
      [on(2026, 1, 6), on(2026, 1, 13), on(2026, 1, 20), on(2026, 1, 27)],
      now(2026, 8, 7),
    );
    expect(s.current).toBe(0);
    expect(s.longest).toBe(4);
  });

  it("is never below the current run", () => {
    const s = computeConfirmationStreak(
      [on(2026, 8, 4), on(2026, 7, 28), on(2026, 7, 21)],
      now(2026, 8, 7),
    );
    expect(s.longest).toBeGreaterThanOrEqual(s.current);
  });
});

describe("junk input", () => {
  it("returns a zeroed state for no confirmations", () => {
    const s = computeConfirmationStreak([], now(2026, 8, 7));
    expect(s).toMatchObject({ current: 0, longest: 0, freezesUsed: 0, atRisk: false });
    expect(s.freezesRemaining).toBe(STREAK_FREEZES_PER_QUARTER);
  });

  it("ignores unparseable timestamps", () => {
    const s = computeConfirmationStreak(
      ["not-a-date", "", on(2026, 7, 28)],
      now(2026, 8, 7),
    );
    expect(s.current).toBe(1);
  });
});
