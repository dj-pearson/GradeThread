import { describe, it, expect } from "vitest";
import {
  FRESHNESS_REGISTRY,
  FRESHNESS_GROUPS,
  verifiedLabel,
  dueMonthIndex,
  isOverdue,
  overdueGroups,
} from "../freshness";
import { PLATFORM_STANDARDS_VERIFIED } from "../platform-standards";
import { COMPARISON_VERIFIED } from "../comparison-guides";
import { CROSSLIST_APPS_VERIFIED } from "../crosslisting-apps";
import { WHERE_TO_SELL_VERIFIED } from "../where-to-sell";

// US-1694: verify the freshness registry, the derived stamps, and the overdue
// automation.

describe("freshness registry (US-1694)", () => {
  it("every entry is well-formed", () => {
    for (const g of FRESHNESS_GROUPS) {
      const e = FRESHNESS_REGISTRY[g];
      expect(e.lastVerified, `${g} lastVerified`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect([3, 12], `${g} cadence`).toContain(e.cadenceMonths);
      expect(e.covers.length, `${g} covers`).toBeGreaterThan(0);
    }
  });

  it("verifiedLabel renders a real 'Month Year' from lastVerified", () => {
    // All groups were verified 2026-07-06 → "July 2026".
    for (const g of FRESHNESS_GROUPS) {
      expect(verifiedLabel(g)).toBe("July 2026");
    }
  });

  it("stamps rendered on protected pages are derived, not hand-typed (drift guard)", () => {
    // If someone hard-codes a stamp again, this fails — the point of US-1694.
    expect(PLATFORM_STANDARDS_VERIFIED).toBe(verifiedLabel("platform-standards"));
    expect(COMPARISON_VERIFIED).toBe(verifiedLabel("comparisons"));
    expect(CROSSLIST_APPS_VERIFIED).toBe(verifiedLabel("crosslisting-apps"));
    expect(WHERE_TO_SELL_VERIFIED).toBe(verifiedLabel("where-to-sell"));
  });

  it("computes due dates and overdue status from cadence", () => {
    // platform-standards: verified 2026-07, quarterly → due 2026-10.
    expect(isOverdue("platform-standards", "2026-08-01")).toBe(false);
    expect(isOverdue("platform-standards", "2026-10-01")).toBe(true);
    // where-to-sell: verified 2026-07, annual → due 2027-07.
    expect(isOverdue("where-to-sell", "2027-01-01")).toBe(false);
    expect(isOverdue("where-to-sell", "2027-07-01")).toBe(true);
    // dueMonthIndex: 2026-07 quarterly = 2026*12 + 6 + 3 = 2026-10.
    expect(dueMonthIndex("platform-standards")).toBe(2026 * 12 + 6 + 3);
  });

  it("overdueGroups returns exactly the groups past cadence as of a date", () => {
    expect(overdueGroups("2026-08-01")).toEqual([]);
    // competitor-alternatives is quarterly and was verified 2026-07-20, so it
    // shares the 2026-10 due month with the other quarterly groups (dueMonth is
    // month-granular — the day of the month does not participate).
    expect(overdueGroups("2026-10-01").sort()).toEqual(
      [
        "comparisons",
        "competitor-alternatives",
        "crosslisting-apps",
        "platform-standards",
      ].sort(),
    );
    // A year out, the annual group is due too.
    expect(overdueGroups("2027-08-01").sort()).toEqual([...FRESHNESS_GROUPS].sort());
  });

  // The TRACKED AUTOMATION: this fails in CI once a protected group passes its
  // re-verify cadence, prompting a re-check + a lastVerified bump.
  it("no protected page group is overdue for re-verification today", () => {
    const todayISO = new Date().toISOString().slice(0, 10);
    const overdue = overdueGroups(todayISO);
    expect(
      overdue,
      `Overdue for re-verification (re-check against live platform ` +
        `fees/policies, then bump lastVerified in freshness.ts): ${overdue
          .map((g) => `${g} — ${FRESHNESS_REGISTRY[g].covers}`)
          .join("; ")}`,
    ).toEqual([]);
  });
});
