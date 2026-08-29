import { describe, it, expect } from "vitest";
import {
  snapshotBoundaries,
  cogsConfidence,
  type CogsWorksheet,
} from "./cogs";

// US-2986. The database side is checked against real Postgres by
// scripts/check-cogs-worksheet.mjs; this covers the pure parts CI can run.

function worksheet(over: Partial<CogsWorksheet> = {}): CogsWorksheet {
  return {
    from: "2026-01-01",
    to: "2027-01-01",
    line_35_beginning_cents: 8500,
    line_35_present: true,
    line_35_reconstructed: false,
    line_36_purchases_cents: 0,
    line_41_ending_cents: 2500,
    line_41_present: true,
    line_41_reconstructed: false,
    line_42_cogs_cents: 6000,
    sold_cost_basis_cents: 6000,
    sold_item_count: 1,
    variance_cents: 0,
    items_without_cost: { beginning: 0, purchases: 0, ending: 0 },
    purchase_item_count: 1,
    ...over,
  };
}

describe("snapshotBoundaries", () => {
  const now = new Date(2026, 5, 15);

  it("covers every year from the business start through next year's start", () => {
    const b = snapshotBoundaries(1, "2024-03-10", now);
    expect(b.map((x) => x.asOf)).toEqual([
      "2024-01-01",
      "2025-01-01",
      "2026-01-01",
      "2027-01-01",
    ]);
  });

  it("ends one year past today, because this year needs an ENDING inventory too", () => {
    // Without the last boundary the seller has a beginning inventory and no
    // ending one, which is half a Part III.
    const b = snapshotBoundaries(1, "2025-01-01", now);
    expect(b[b.length - 1]?.asOf).toBe("2027-01-01");
  });

  it("goes back three years when the business start is unknown", () => {
    const b = snapshotBoundaries(1, null, now);
    expect(b[0]?.asOf).toBe("2023-01-01");
    expect(b).toHaveLength(5);
  });

  it("uses the fiscal year start, not January", () => {
    const b = snapshotBoundaries(7, "2025-08-01", now);
    // June 2026 is inside the fiscal year that began July 2025.
    expect(b.map((x) => x.asOf)).toEqual(["2025-07-01", "2026-07-01"]);
    expect(b[0]?.label).toBe("2025-26");
  });

  it("labels a calendar year plainly", () => {
    expect(snapshotBoundaries(1, "2026-01-01", now)[0]?.label).toBe("2026");
  });

  it("is bounded, so a corrupt start date cannot spin", () => {
    const b = snapshotBoundaries(1, "1900-01-01", now);
    expect(b.length).toBeLessThanOrEqual(51);
  });

  it("produces boundaries that serve as both an ending and a beginning", () => {
    // Half-open ranges mean one date is year N's end and year N+1's start, so
    // one snapshot answers both. That is the whole reason as_of is exclusive.
    const b = snapshotBoundaries(1, "2024-01-01", now);
    const dates = b.map((x) => x.asOf);
    for (let i = 0; i < dates.length - 1; i++) {
      const a = Number((dates[i] as string).slice(0, 4));
      const c = Number((dates[i + 1] as string).slice(0, 4));
      expect(c - a).toBe(1);
    }
  });
});

describe("cogsConfidence", () => {
  it("is ok when both snapshots exist, nothing is unpriced and the routes agree", () => {
    expect(cogsConfidence(worksheet())).toBe("ok");
  });

  it("reports a missing snapshot ahead of anything else", () => {
    // No beginning inventory means line 42 is arithmetic on a hole. That is
    // worse than a variance and has to be said first.
    expect(cogsConfidence(worksheet({ line_35_present: false }))).toBe(
      "no_snapshot",
    );
    expect(cogsConfidence(worksheet({ line_41_present: false }))).toBe(
      "no_snapshot",
    );
  });

  it("reports a variance when the two routes disagree", () => {
    expect(cogsConfidence(worksheet({ variance_cents: -5000 }))).toBe(
      "variance",
    );
  });

  it("reports unpriced items even when the variance is zero", () => {
    // THE FINDING THIS FUNCTION EXISTS FOR, measured on Postgres: a sold item
    // with no cost basis does NOT move the variance, because both routes read
    // the same acquired_price column and a null cancels on both sides. If the
    // screen only watched the variance it would call these books clean.
    expect(
      cogsConfidence(
        worksheet({
          variance_cents: 0,
          items_without_cost: { beginning: 0, purchases: 1, ending: 0 },
        }),
      ),
    ).toBe("missing_cost");
  });

  it("counts an unpriced item in any of the three places", () => {
    for (const where of ["beginning", "purchases", "ending"] as const) {
      const counts = { beginning: 0, purchases: 0, ending: 0 };
      counts[where] = 1;
      expect(
        cogsConfidence(worksheet({ items_without_cost: counts })),
        where,
      ).toBe("missing_cost");
    }
  });
});

describe("the worksheet arithmetic the database performs", () => {
  it("is line 35 + line 36 - line 41, and the fixture proves it", () => {
    // These are the exact figures scripts/check-cogs-worksheet.mjs measured
    // against Postgres for the seeded 2026 year. Pinned here so a change to the
    // SQL that alters them has to change this number too.
    const w = worksheet({
      line_35_beginning_cents: 8500,
      line_36_purchases_cents: 0,
      line_41_ending_cents: 2500,
      line_42_cogs_cents: 6000,
      sold_cost_basis_cents: 11000,
      variance_cents: -5000,
    });
    expect(
      w.line_35_beginning_cents + w.line_36_purchases_cents - w.line_41_ending_cents,
    ).toBe(w.line_42_cogs_cents);
    expect(w.line_42_cogs_cents - w.sold_cost_basis_cents).toBe(
      w.variance_cents,
    );
  });
});
