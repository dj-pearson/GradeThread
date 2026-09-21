// US-3183: the scorecard, and the four numbers it refuses to print.
//
// Most of this file is about what is NOT reported: an hourly rate with no
// tracked hours, a zero standing in for stock that has not sold, a refund
// still sitting in the win column, and a cause for a difference between two
// months.

import { describe, it, expect } from "vitest";
import {
  THIN_SAMPLE_BELOW,
  buildScorecard,
  compareRanges,
  isThinSample,
} from "@/lib/work-scorecard";
import type { Outcome, PlannedTask } from "@/lib/work-outcomes";

const MARCH = "2026-03-10T12:00:00.000Z";
const FEB = "2026-02-10T12:00:00.000Z";

function outcome(over: Partial<Outcome> = {}): Outcome {
  return {
    inventoryItemId: "item-1",
    state: "sold",
    estimatedNetCents: 3000,
    estimateSource: "sold_comp",
    estimatedAt: MARCH,
    confirmedMinutes: 30,
    sessionCount: 1,
    recordedNetCents: 4000,
    incompleteReason: null,
    saleId: "sale-1",
    marketplace: "ebay",
    soldAt: MARCH,
    ageDays: 3,
    ...over,
  };
}

function task(over: Partial<PlannedTask> = {}): PlannedTask {
  return {
    taskId: "t1",
    sessionId: "s1",
    inventoryItemId: "item-1",
    itemTitleSnapshot: null,
    actionKey: "photograph",
    taskState: "done",
    sessionState: "completed",
    estimateValueCents: 3000,
    estimateSource: "sold_comp",
    estimateTakenAt: MARCH,
    confirmedMinutes: 30,
    correctionMinutes: null,
    ...over,
  };
}

describe("the three numbers stay three numbers (AC2)", () => {
  it("reports projection, realized money and the rate separately", () => {
    const s = buildScorecard({ outcomes: [outcome()], tasks: [task()] });
    expect(s.projectedNetCents).toBe(3000);
    expect(s.realized).toEqual({ available: true, cents: 4000 });
    // $40.00 in 30 minutes is $80.00 an hour.
    expect(s.profitPerTrackedHour).toEqual({ available: true, cents: 8000 });
  });

  it("never adds a projection into a realized figure", () => {
    // A pending garment the planner valued at $90 must not move the money.
    const s = buildScorecard({
      outcomes: [
        outcome(),
        outcome({
          inventoryItemId: "item-2",
          state: "pending",
          estimatedNetCents: 9000,
          recordedNetCents: null,
          saleId: null,
          confirmedMinutes: 20,
        }),
      ],
      tasks: [task()],
    });
    expect(s.projectedNetCents).toBe(12000);
    expect(s.realized).toEqual({ available: true, cents: 4000 });
    expect(s.profitPerTrackedHour).toEqual({ available: true, cents: 8000 });
  });

  it("counts ONE item once however many sessions planned it", () => {
    // The outcome model already sums minutes across sessions; what is asserted
    // here is that the scorecard does not then multiply by sessionCount.
    const s = buildScorecard({
      outcomes: [outcome({ sessionCount: 3, confirmedMinutes: 120 })],
      tasks: [task()],
    });
    expect(s.counts.sold).toBe(1);
    // $40.00 over two hours.
    expect(s.profitPerTrackedHour).toEqual({ available: true, cents: 2000 });
  });

  it("a cross-listed garment is one sale, because upstream picked one", () => {
    const s = buildScorecard({ outcomes: [outcome({ marketplace: "poshmark" })], tasks: [task()] });
    expect(s.counts.sold).toBe(1);
    expect(s.realized).toEqual({ available: true, cents: 4000 });
  });
});

describe("unavailable is an answer (AC3)", () => {
  it("zero tracked minutes is NOT an infinite rate", () => {
    // THE ONE THAT MATTERS MOST. realizedTotal / 0 is Infinity, and Infinity
    // renders as a number a seller would believe.
    const s = buildScorecard({
      outcomes: [outcome({ confirmedMinutes: 0 })],
      tasks: [task({ confirmedMinutes: null })],
    });
    expect(s.realized).toEqual({ available: true, cents: 4000 });
    expect(s.profitPerTrackedHour).toEqual({
      available: false,
      reason: "no_tracked_time",
    });
    expect(JSON.stringify(s)).not.toContain("Infinity");
    expect(JSON.stringify(s)).not.toContain("null,\"cents\"");
  });

  it("nothing sold is NOT a zero rate", () => {
    const s = buildScorecard({
      outcomes: [outcome({ state: "pending", recordedNetCents: null, saleId: null })],
      tasks: [task({ taskState: "pending" })],
    });
    expect(s.realized).toEqual({ available: false, reason: "no_completed_sales" });
    expect(s.profitPerTrackedHour).toEqual({
      available: false,
      reason: "no_completed_sales",
    });
  });

  it("a sale with no recorded costs says so, and is not a free garment", () => {
    const s = buildScorecard({
      outcomes: [outcome({ state: "incomplete_costs", recordedNetCents: null })],
      tasks: [task()],
    });
    expect(s.excludedForIncompleteCosts).toBe(1);
    expect(s.realized).toEqual({ available: false, reason: "costs_not_recorded" });
  });

  it("an empty range says so rather than reporting zeroes as facts", () => {
    const s = buildScorecard({ outcomes: [], tasks: [] });
    expect(s.realized).toEqual({ available: false, reason: "nothing_in_range" });
    expect(s.profitPerTrackedHour).toEqual({
      available: false,
      reason: "nothing_in_range",
    });
  });

  it("one incomplete sale does not hide a good one, and is still counted", () => {
    const s = buildScorecard({
      outcomes: [
        outcome(),
        outcome({ inventoryItemId: "item-2", state: "incomplete_costs", recordedNetCents: null }),
      ],
      tasks: [task()],
    });
    expect(s.realized).toEqual({ available: true, cents: 4000 });
    expect(s.excludedForIncompleteCosts).toBe(1);
  });
});

describe("unsold stock sits beside the wins (AC3)", () => {
  it("reports the count AND the hours it already cost", () => {
    // Without this the scorecard is survivorship bias with a chart on it.
    const s = buildScorecard({
      outcomes: [
        outcome(),
        outcome({ inventoryItemId: "i2", state: "pending", recordedNetCents: null, confirmedMinutes: 45 }),
        outcome({ inventoryItemId: "i3", state: "not_sold_within_horizon", recordedNetCents: null, confirmedMinutes: 15 }),
      ],
      tasks: [task()],
    });
    expect(s.pending).toEqual({ items: 2, trackedMinutes: 60 });
  });

  it("pending hours are NOT in the rate's denominator", () => {
    // They are work that has not produced money yet, not work that produced
    // none. Putting them in the denominator would report a rate that falls
    // every time the seller starts something new.
    const s = buildScorecard({
      outcomes: [
        outcome(),
        outcome({ inventoryItemId: "i2", state: "pending", recordedNetCents: null, confirmedMinutes: 600 }),
      ],
      tasks: [task()],
    });
    expect(s.profitPerTrackedHour).toEqual({ available: true, cents: 8000 });
  });
});

describe("a refund restates rather than staying a win (AC3)", () => {
  it("a negative net pulls the realized figure down", () => {
    const s = buildScorecard({
      outcomes: [outcome({ state: "refunded", recordedNetCents: -1200 })],
      tasks: [task()],
    });
    expect(s.counts.refunded).toBe(1);
    expect(s.realized).toEqual({ available: true, cents: -1200 });
    // And the hours are still the seller's: they really did the work.
    expect(s.profitPerTrackedHour).toEqual({ available: true, cents: -2400 });
  });

  it("a cancelled sale is neither a win nor a loss", () => {
    const s = buildScorecard({
      outcomes: [outcome({ state: "cancelled", recordedNetCents: null })],
      tasks: [task()],
    });
    expect(s.counts.cancelled).toBe(1);
    expect(s.realized).toEqual({ available: false, reason: "no_completed_sales" });
  });
});

describe("forecast versus actual, with its sample size (AC4)", () => {
  it("reports a range of differences rather than one average", () => {
    const s = buildScorecard({
      outcomes: [
        outcome({ estimatedNetCents: 3000, recordedNetCents: 4000 }),
        outcome({ inventoryItemId: "i2", estimatedNetCents: 5000, recordedNetCents: 2000 }),
        outcome({ inventoryItemId: "i3", estimatedNetCents: 1000, recordedNetCents: 1500 }),
      ],
      tasks: [task()],
    });
    expect(s.forecast.sampleSize).toBe(3);
    expect(s.forecast.lowestDifferenceCents).toBe(-3000);
    expect(s.forecast.highestDifferenceCents).toBe(1000);
    expect(s.forecast.medianDifferenceCents).toBe(500);
  });

  it("names the price evidence each estimate came from", () => {
    const s = buildScorecard({
      outcomes: [
        outcome({ estimateSource: "sold_comp" }),
        outcome({ inventoryItemId: "i2", estimateSource: "active_asking" }),
      ],
      tasks: [task()],
    });
    expect(s.forecast.bySource.sold_comp).toBe(1);
    expect(s.forecast.bySource.active_asking).toBe(1);
  });

  it("carries the 30-day horizon the estimate was made for", () => {
    expect(buildScorecard({ outcomes: [], tasks: [] }).forecast.horizonDays).toBe(30);
  });

  it("an item with no estimate is not in the comparison", () => {
    const s = buildScorecard({
      outcomes: [outcome({ estimatedNetCents: null })],
      tasks: [task()],
    });
    expect(s.forecast.sampleSize).toBe(0);
    expect(s.forecast.medianDifferenceCents).toBeNull();
    // But it IS still a sale.
    expect(s.realized).toEqual({ available: true, cents: 4000 });
  });

  it("a thin sample is named as thin", () => {
    expect(THIN_SAMPLE_BELOW).toBe(10);
    expect(isThinSample(9)).toBe(true);
    expect(isThinSample(10)).toBe(false);
  });
});

describe("the date range (AC1)", () => {
  it("keeps only what was planned inside it", () => {
    const s = buildScorecard({
      outcomes: [outcome({ estimatedAt: MARCH }), outcome({ inventoryItemId: "i2", estimatedAt: FEB })],
      tasks: [task({ estimateTakenAt: MARCH }), task({ taskId: "t2", estimateTakenAt: FEB })],
      range: { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T23:59:59.999Z" },
    });
    expect(s.counts.sold).toBe(1);
    expect(s.work.completedTasks).toBe(1);
  });

  it("an undated row is in NO range, so two periods cannot sum past the whole", () => {
    const s = buildScorecard({
      outcomes: [outcome({ estimatedAt: null })],
      tasks: [task({ estimateTakenAt: null })],
      range: { from: "2026-03-01T00:00:00.000Z", to: null },
    });
    expect(s.counts.sold).toBe(0);
  });

  it("an open range keeps everything", () => {
    const s = buildScorecard({
      outcomes: [outcome({ estimatedAt: MARCH }), outcome({ inventoryItemId: "i2", estimatedAt: FEB })],
      tasks: [task()],
    });
    expect(s.counts.sold).toBe(2);
  });
});

describe("the work itself (AC1)", () => {
  it("counts finished jobs, confirmed minutes, sessions and what was carried", () => {
    const s = buildScorecard({
      outcomes: [outcome()],
      tasks: [
        task({ taskId: "a", taskState: "done", confirmedMinutes: 12 }),
        task({ taskId: "b", sessionId: "s2", taskState: "done", confirmedMinutes: 8 }),
        task({ taskId: "c", taskState: "pending", inventoryItemId: "i9", confirmedMinutes: null }),
      ],
    });
    expect(s.work.completedTasks).toBe(2);
    expect(s.work.confirmedMinutes).toBe(20);
    expect(s.work.sessions).toBe(2);
    expect(s.work.carriedForwardItems).toBe(1);
  });

  it("a later correction wins over the first answer", () => {
    const s = buildScorecard({
      outcomes: [],
      tasks: [task({ confirmedMinutes: 30, correctionMinutes: 9 })],
    });
    expect(s.work.confirmedMinutes).toBe(9);
  });

  it("a job finished without an answer contributes no minutes", () => {
    // Which is why this can read lower than the wall clock, and should.
    const s = buildScorecard({
      outcomes: [],
      tasks: [task({ confirmedMinutes: null, correctionMinutes: null })],
    });
    expect(s.work.confirmedMinutes).toBe(0);
    expect(s.work.completedTasks).toBe(1);
  });

  it("a skipped job is carried, an invalidated one is not", () => {
    // Skipped is work the seller passed over and still has to do, the same
    // way sessionProgress counts it. Invalidated means the garment sold or
    // moved, so there is nothing left to carry.
    const s = buildScorecard({
      outcomes: [],
      tasks: [
        task({ taskId: "a", taskState: "skipped", inventoryItemId: "i1" }),
        task({ taskId: "b", taskState: "invalidated", inventoryItemId: "i2" }),
      ],
    });
    expect(s.work.carriedForwardItems).toBe(1);
  });

  it("counts the state the table actually stores, not only the action name", () => {
    // 00818's CHECK allows `completed`; the route's action is called "done".
    const s = buildScorecard({
      outcomes: [],
      tasks: [
        task({ taskId: "a", taskState: "completed" }),
        task({ taskId: "b", taskState: "done" }),
      ],
    });
    expect(s.work.completedTasks).toBe(2);
  });

  it("the same garment carried twice is one carried item", () => {
    const s = buildScorecard({
      outcomes: [],
      tasks: [
        task({ taskId: "a", taskState: "pending", inventoryItemId: "i1" }),
        task({ taskId: "b", taskState: "active", inventoryItemId: "i1" }),
      ],
    });
    expect(s.work.carriedForwardItems).toBe(1);
  });
});

describe("two periods, described and not explained (AC4)", () => {
  it("returns differences and the smaller sample, and claims nothing", () => {
    const earlier = buildScorecard({
      outcomes: [outcome({ estimatedAt: FEB, recordedNetCents: 1000 })],
      tasks: [task({ estimateTakenAt: FEB, confirmedMinutes: 60 })],
    });
    const later = buildScorecard({
      outcomes: [outcome({ recordedNetCents: 4000 })],
      tasks: [task({ confirmedMinutes: 30 })],
    });
    const c = compareRanges(earlier, later);
    expect(c.differences.realizedNetCents).toBe(3000);
    expect(c.differences.confirmedMinutes).toBe(-30);
    expect(c.smallestSampleSize).toBe(1);
    // No field anywhere says why.
    const keys = JSON.stringify(Object.keys(c.differences));
    for (const banned of ["because", "caused", "improvement", "gain", "saved"]) {
      expect(keys.toLowerCase()).not.toContain(banned);
    }
  });

  it("a difference is null when either side could not state a figure", () => {
    const empty = buildScorecard({ outcomes: [], tasks: [] });
    const full = buildScorecard({ outcomes: [outcome()], tasks: [task()] });
    expect(compareRanges(empty, full).differences.realizedNetCents).toBeNull();
    expect(compareRanges(full, empty).differences.profitPerTrackedHourCents).toBeNull();
  });
});

describe("confirmed minutes, never the hypothetical meter (AC5)", () => {
  it("does not import the time-saved baseline", () => {
    // time-saved.ts holds ASSUMED minutes per automated task -- 8 for comps,
    // 6 for a description. They are a marketing baseline rather than a
    // measurement of this seller, and a rate computed from them would be
    // money divided by a number nobody observed.
    const src = codeOf("src/lib/work-scorecard.ts");
    for (const banned of ["time-saved", "TIME_SAVED", "timeSaved"]) {
      expect(src, `work-scorecard.ts references "${banned}"`).not.toContain(banned);
    }
  });

  it("names no buyer, no item title and no raw sale price", () => {
    const src = codeOf("src/lib/work-scorecard.ts");
    for (const banned of ["buyer", "itemTitle", "item_title", "sale_price", "salePrice"]) {
      expect(src, `work-scorecard.ts references "${banned}"`).not.toContain(banned);
    }
  });

  it("reads a clock nowhere, so the same rows score the same twice", () => {
    const src = codeOf("src/lib/work-scorecard.ts");
    expect(src).not.toContain("Date.now");
    expect(src).not.toContain("new Date()");
  });
});

function codeOf(rel: string): string {
  // Comments stripped as BLOCKS: the header explains what this file must not
  // do, so a naive scan finds the banned word inside the sentence forbidding
  // it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("node:path") as typeof import("node:path");
  return fs.readFileSync(path.resolve(process.cwd(), rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
}
