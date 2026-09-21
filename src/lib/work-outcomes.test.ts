// US-3179: did the estimate match what sold, and when must we refuse to say?
//
// AC6 names eight cases and seven of them are ways to report a number that is
// not true: a repeat session counted twice, a cross-listed sale counted twice,
// a missing fee read as no fee, a return left in the win column, a cancelled
// sale scored as a failure, unsold stock read as a zero, and an average over
// two different kinds of evidence. Each has its own describe block.

import { describe, it, expect } from "vitest";
import {
  OUTCOME_STATES,
  compareOutcomes,
  summarize,
  type PlannedTask,
  type SaleRecord,
} from "@/lib/work-outcomes";
import { saleNetCents } from "@/lib/ledger-math";
import { PLANNING_HORIZON_DAYS } from "@/lib/work-value";

const NOW = "2026-09-21T12:00:00.000Z";
const ITEM = "item-1";

function daysAgo(n: number): string {
  return new Date(Date.parse(NOW) - n * 86_400_000).toISOString();
}

let seq = 0;
function task(over: Partial<PlannedTask> = {}): PlannedTask {
  seq += 1;
  return {
    taskId: `t${seq}`,
    sessionId: "s1",
    inventoryItemId: ITEM,
    itemTitleSnapshot: "Carhartt Detroit jacket",
    actionKey: "photograph",
    taskState: "completed",
    sessionState: "completed",
    estimateValueCents: 3300,
    estimateSource: "sold_comp",
    estimateTakenAt: daysAgo(10),
    confirmedMinutes: 8,
    correctionMinutes: null,
    ...over,
  };
}

/** A complete, ordinary sale: $60 in, $8 fees, $2 processing, $9 label, $22 basis. */
function sale(over: Partial<SaleRecord> = {}): SaleRecord {
  return {
    saleId: "sale-1",
    inventoryItemId: ITEM,
    status: "completed",
    cancelledAt: null,
    soldAt: daysAgo(3),
    money: {
      sale_price: 60,
      shipping_collected: 0,
      platform_fees: 8,
      payment_processing_fees: 2,
      shipping_cost: 9,
      grading_cost: 0,
      other_costs: 0,
      tax: 0,
    },
    acquiredPrice: 22,
    legacyShipTotal: null,
    marketplace: "ebay",
    ...over,
  };
}

function run(tasks: PlannedTask[], sales: SaleRecord[] = [], now = NOW) {
  return compareOutcomes({
    tasks,
    sales,
    items: [{ inventoryItemId: ITEM, createdAt: daysAgo(20) }],
    now,
  });
}

describe("one ledger, not two (AC1)", () => {
  it("the recorded result IS saleNetCents, not a second opinion", () => {
    const s = sale();
    const { outcomes } = run([task()], [s]);
    const expected = saleNetCents(s.money, s.acquiredPrice, s.legacyShipTotal);
    expect(outcomes[0]!.recordedNetCents).toBe(expected);
    // 6000 - 1000 fees - 900 label - 2200 basis
    expect(expected).toBe(1900);
  });

  it("the comparison holds both numbers without collapsing them", () => {
    const { outcomes } = run([task()], [sale()]);
    expect(outcomes[0]!.estimatedNetCents).toBe(3300);
    expect(outcomes[0]!.recordedNetCents).toBe(1900);
    expect(outcomes[0]!.state).toBe("sold");
  });
});

describe("repeat sessions (AC2, AC6)", () => {
  it("one item planned three times is ONE outcome", () => {
    const { outcomes } = run([
      task({ sessionId: "s1", estimateTakenAt: daysAgo(20), estimateValueCents: 3300 }),
      task({ sessionId: "s2", estimateTakenAt: daysAgo(12), estimateValueCents: 2900 }),
      task({ sessionId: "s3", estimateTakenAt: daysAgo(5), estimateValueCents: 2500 }),
    ], [sale()]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.sessionCount).toBe(3);
  });

  it("it keeps the FIRST estimate, which is the one the seller acted on", () => {
    // A later session's number is a different decision, and scoring the model
    // against it would judge it on information it did not have.
    const { outcomes } = run([
      task({ sessionId: "s2", estimateTakenAt: daysAgo(12), estimateValueCents: 2900 }),
      task({ sessionId: "s1", estimateTakenAt: daysAgo(20), estimateValueCents: 3300 }),
    ], [sale()]);
    expect(outcomes[0]!.estimatedNetCents).toBe(3300);
    expect(outcomes[0]!.estimatedAt).toBe(daysAgo(20));
  });

  it("and sums the confirmed minutes across every one of them", () => {
    const { outcomes } = run([
      task({ sessionId: "s1", confirmedMinutes: 8 }),
      task({ sessionId: "s2", confirmedMinutes: 5 }),
      task({ sessionId: "s3", confirmedMinutes: 3, correctionMinutes: 7 }),
    ], [sale()]);
    // The seller really did spend all of them on this garment. The correction
    // wins over the confirmation, as everywhere else.
    expect(outcomes[0]!.confirmedMinutes).toBe(20);
  });

  it("a task with no estimate does not become the first one", () => {
    const { outcomes } = run([
      task({ sessionId: "s0", estimateValueCents: null, estimateTakenAt: null }),
      task({ sessionId: "s1", estimateTakenAt: daysAgo(20), estimateValueCents: 3300 }),
    ], [sale()]);
    expect(outcomes[0]!.estimatedNetCents).toBe(3300);
  });
});

describe("cross-listed single sales (AC2, AC6)", () => {
  it("four marketplaces and one sale is one outcome and one net", () => {
    const { outcomes } = run([task()], [
      sale({ saleId: "ebay-1", marketplace: "ebay", soldAt: daysAgo(3) }),
      sale({ saleId: "posh-1", marketplace: "poshmark", status: "cancelled", cancelledAt: daysAgo(3) }),
      sale({ saleId: "depop-1", marketplace: "depop", status: "cancelled", cancelledAt: daysAgo(3) }),
    ]);
    expect(outcomes).toHaveLength(1);
    // The LIVE row wins over the cancelled cross-posts, which are the other
    // listings being withdrawn rather than three failed sales.
    expect(outcomes[0]!.saleId).toBe("ebay-1");
    expect(outcomes[0]!.marketplace).toBe("ebay");
    expect(outcomes[0]!.state).toBe("sold");
  });

  it("with two live rows the earliest transaction wins", () => {
    const { outcomes } = run([task()], [
      sale({ saleId: "late", soldAt: daysAgo(1) }),
      sale({ saleId: "early", soldAt: daysAgo(6) }),
    ]);
    expect(outcomes[0]!.saleId).toBe("early");
  });

  it("all-cancelled still reports cancelled rather than pending", () => {
    const { outcomes } = run([task()], [
      sale({ saleId: "a", status: "cancelled", cancelledAt: daysAgo(3) }),
      sale({ saleId: "b", status: "cancelled", cancelledAt: daysAgo(2) }),
    ]);
    expect(outcomes[0]!.state).toBe("cancelled");
  });
});

describe("missing fees (AC3, AC6)", () => {
  // ⚠ WHAT THE SCHEMA ACTUALLY ALLOWS, checked rather than assumed. Every
  // money column on `sales` is NOT NULL with DEFAULT 0, so a null fee cannot
  // come out of that table -- the first version of this fixture tried to seed
  // one and the insert was refused. The sale-side case below therefore covers
  // the LIBRARY contract (a hand-built row, an importer that has not filled a
  // column) and NOT a production path; `acquired_price` is the one that can
  // genuinely be absent, and it has its own case.
  it("a missing fee is NOT a zero fee", () => {
    const { outcomes } = run([task()], [
      sale({ money: { ...sale().money, platform_fees: null as unknown as number } }),
    ]);
    expect(outcomes[0]!.state).toBe("incomplete_costs");
    expect(outcomes[0]!.recordedNetCents).toBeNull();
    expect(outcomes[0]!.incompleteReason).toContain("platform_fees");
  });

  it("a RECORDED zero is fine, and that is the distinction a truthy check loses", () => {
    const { outcomes } = run([task()], [
      sale({ money: { ...sale().money, shipping_cost: 0 } }),
    ]);
    expect(outcomes[0]!.state).toBe("sold");
    // 6000 - 1000 - 2200 = 2800
    expect(outcomes[0]!.recordedNetCents).toBe(2800);
  });

  it("a missing acquisition basis is missing too, and THIS one happens", () => {
    // inventory_items.acquired_price is nullable, so a seller who never
    // recorded what they paid reaches here. A net without the basis is a
    // gross receipt wearing the word "profit".
    const { outcomes } = run([task()], [sale({ acquiredPrice: null })]);
    expect(outcomes[0]!.state).toBe("incomplete_costs");
    expect(outcomes[0]!.incompleteReason).toContain("acquired_price");
  });

  it("the row is still counted, and its hours still belong to the seller", () => {
    const { outcomes } = run([task({ confirmedMinutes: 8 })], [
      sale({ acquiredPrice: null }),
    ]);
    expect(outcomes[0]!.confirmedMinutes).toBe(8);
    expect(outcomes[0]!.saleId).toBe("sale-1");
  });
});

describe("returns and refunds (AC3, AC6)", () => {
  it("a refund RESTATES the comparison rather than staying a win", () => {
    const { outcomes } = run([task()], [sale({ status: "refunded" })]);
    expect(outcomes[0]!.state).toBe("refunded");
    // The money is still the books' own figure; what changed is that the row
    // says refunded, so no summary can count it as a plain success.
    expect(outcomes[0]!.recordedNetCents).toBe(1900);
  });

  it("a refunded row is not silently deleted", () => {
    // The work still happened. Dropping it would flatter the model by hiding
    // its failures, which is the same defect as scoring unsold stock as zero.
    const { outcomes } = run([task()], [sale({ status: "refunded" })]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.confirmedMinutes).toBe(8);
  });
});

describe("cancellations (AC3, AC6)", () => {
  it("a cancelled sale is excluded from the comparison", () => {
    const { outcomes } = run([task()], [
      sale({ status: "cancelled", cancelledAt: daysAgo(2) }),
    ]);
    expect(outcomes[0]!.state).toBe("cancelled");
    expect(outcomes[0]!.recordedNetCents).toBeNull();
    // Not a failure of the estimate: nothing transacted.
    expect(outcomes[0]!.incompleteReason).toContain("cancelled");
  });

  it("a cancelled_at stamp counts even where the status says otherwise", () => {
    const { outcomes } = run([task()], [
      sale({ status: "completed", cancelledAt: daysAgo(2) }),
    ]);
    expect(outcomes[0]!.state).toBe("cancelled");
  });
});

describe("unsold aging (AC4, AC6)", () => {
  it("inside the horizon it is pending, not a zero-dollar sale", () => {
    const { outcomes } = run([task({ estimateTakenAt: daysAgo(5) })], []);
    expect(outcomes[0]!.state).toBe("pending");
    expect(outcomes[0]!.recordedNetCents).toBeNull();
  });

  it("past the horizon it says so, rather than hiding forever", () => {
    const { outcomes } = run(
      [task({ estimateTakenAt: daysAgo(PLANNING_HORIZON_DAYS + 1) })],
      [],
    );
    expect(outcomes[0]!.state).toBe("not_sold_within_horizon");
    expect(outcomes[0]!.recordedNetCents).toBeNull();
  });

  it("the boundary belongs to pending, and the horizon is R1's own constant", () => {
    expect(PLANNING_HORIZON_DAYS).toBe(30);
    const { outcomes } = run(
      [task({ estimateTakenAt: daysAgo(PLANNING_HORIZON_DAYS) })],
      [],
    );
    expect(outcomes[0]!.state).toBe("pending");
  });

  it("a sale row still marked pending is treated as unsold", () => {
    const { outcomes } = run([task({ estimateTakenAt: daysAgo(5) })], [
      sale({ status: "pending", soldAt: null }),
    ]);
    expect(outcomes[0]!.state).toBe("pending");
  });
});

describe("evidence-source groups (AC4, AC6)", () => {
  it("counts each source separately rather than averaging across them", () => {
    // An estimate built on an active asking price is a different claim from
    // one built on a sold comp, and an average over the two says nothing
    // about either.
    const { outcomes } = compareOutcomes({
      tasks: [
        task({ inventoryItemId: "a", estimateSource: "sold_comp" }),
        task({ inventoryItemId: "b", estimateSource: "active_asking" }),
        task({ inventoryItemId: "c", estimateSource: "seller_estimate" }),
        task({ inventoryItemId: "d", estimateSource: "something_else" }),
      ],
      sales: [],
      items: [],
      now: NOW,
    });
    const s = summarize(outcomes);
    expect(s.bySource.sold_comp).toBe(1);
    expect(s.bySource.active_asking).toBe(1);
    expect(s.bySource.seller_estimate).toBe(1);
    // An unrecognised source becomes `unknown` rather than being trusted.
    expect(s.bySource.unknown).toBe(1);
  });

  it("every outcome state appears in the counts, including the zeroes", () => {
    const s = summarize([]);
    for (const state of OUTCOME_STATES) {
      expect(s.counts[state], `${state} missing from the counts`).toBe(0);
    }
  });
});

describe("a deleted item cannot be matched by title (AC2)", () => {
  it("a null item id is unmatchable, never re-matched by its snapshot", () => {
    // The same seller can own two "Levi 501 jeans". A title match would
    // attribute one garment's sale to another garment's work.
    const { outcomes } = compareOutcomes({
      tasks: [task({ inventoryItemId: null, itemTitleSnapshot: "Levi 501 jeans" })],
      sales: [sale({ inventoryItemId: "some-other-item" })],
      items: [],
      now: NOW,
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.state).toBe("unmatchable");
    expect(outcomes[0]!.saleId).toBeNull();
    expect(outcomes[0]!.recordedNetCents).toBeNull();
  });

  it("its hours are still counted, because the seller still spent them", () => {
    const { outcomes } = compareOutcomes({
      tasks: [task({ inventoryItemId: null, confirmedMinutes: 11 })],
      sales: [],
      items: [],
      now: NOW,
    });
    expect(outcomes[0]!.confirmedMinutes).toBe(11);
  });
});

describe("the summary invents nothing (AC4, AC5)", () => {
  it("only sold and refunded contribute money", () => {
    const { outcomes } = compareOutcomes({
      tasks: [
        task({ inventoryItemId: "sold-1", estimateValueCents: 3300 }),
        task({ inventoryItemId: "pend-1", estimateValueCents: 9900 }),
        task({ inventoryItemId: "old-1", estimateValueCents: 9900, estimateTakenAt: daysAgo(60) }),
      ],
      sales: [sale({ inventoryItemId: "sold-1" })],
      items: [],
      now: NOW,
    });
    const s = summarize(outcomes);
    expect(s.comparable).toBe(1);
    // The two unsold estimates contribute NOTHING. Counting them as zero
    // would drag the average down with garments still likely to sell.
    expect(s.estimatedTotalCents).toBe(3300);
    expect(s.recordedTotalCents).toBe(1900);
    expect(s.counts.pending).toBe(1);
    expect(s.counts.not_sold_within_horizon).toBe(1);
  });

  it("the STATE decides, not merely the absence of a number", () => {
    // ⚠ WHY THIS CASE IS BUILT BY HAND. Deleting the state check from
    // summarize() left every other test green, because nothing
    // compareOutcomes() produces has a recordedNetCents on a non-settled row
    // -- the null alone was doing the work and the state check looked proven
    // when it was merely unreachable.
    //
    // So this constructs the row that cannot happen today and asserts the
    // guard anyway. It is the second layer: if a future state ever carries a
    // recorded figure (a partial refund, a payout adjustment), it must not
    // walk into the comparison just because it has a number.
    const s = summarize([
      {
        inventoryItemId: "x",
        state: "pending",
        estimatedNetCents: 9900,
        estimateSource: "sold_comp",
        estimatedAt: daysAgo(3),
        confirmedMinutes: 4,
        sessionCount: 1,
        recordedNetCents: 5000,
        incompleteReason: null,
        saleId: null,
        marketplace: null,
        soldAt: null,
        ageDays: 3,
      },
    ]);
    expect(s.comparable).toBe(0);
    expect(s.estimatedTotalCents).toBe(0);
    expect(s.recordedTotalCents).toBe(0);
    // It is still COUNTED, because it exists.
    expect(s.counts.pending).toBe(1);
    expect(s.confirmedMinutes).toBe(4);
  });

  it("an incomplete sale is counted but never totalled", () => {
    const { outcomes } = run([task()], [sale({ acquiredPrice: null })]);
    const s = summarize(outcomes);
    expect(s.counts.incomplete_costs).toBe(1);
    expect(s.comparable).toBe(0);
    expect(s.recordedTotalCents).toBe(0);
  });

  it("every outcome's hours reach the total, whatever its state", () => {
    const { outcomes } = compareOutcomes({
      tasks: [
        task({ inventoryItemId: "a", confirmedMinutes: 4 }),
        task({ inventoryItemId: "b", confirmedMinutes: 6 }),
        task({ inventoryItemId: null, confirmedMinutes: 5 }),
      ],
      sales: [],
      items: [],
      now: NOW,
    });
    expect(summarize(outcomes).confirmedMinutes).toBe(15);
  });
});

describe("it changes nothing (AC5)", () => {
  it("no price, probability or estimate is rewritten", () => {
    const src = codeOf("src/lib/work-outcomes.ts");
    for (const banned of ["update(", "upsert(", "insert(", "supabase", "mutate"]) {
      expect(src, `work-outcomes.ts contains "${banned}"`).not.toContain(banned);
    }
    // Guards the guard: the stripper must not have eaten the file.
    expect(src).toContain("export function compareOutcomes");
  });

  it("is deterministic: now is a parameter, never a clock", () => {
    const src = codeOf("src/lib/work-outcomes.ts");
    expect(src).not.toContain("Date.now()");
    expect(src).not.toContain("new Date()");
    const a = run([task()], [sale()]);
    const b = run([task()], [sale()]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

function codeOf(rel: string): string {
  // Comments stripped as BLOCKS first: the header explains at length what the
  // file must not do, so a naive scan finds the banned word inside the
  // sentence forbidding it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("node:path") as typeof import("node:path");
  return fs.readFileSync(path.resolve(process.cwd(), rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}
