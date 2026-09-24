import { describe, expect, it } from "vitest";
import {
  confirmCopy,
  planBulk,
  planSummary,
  remainingSelection,
  targetPrice,
  type PricingRow,
} from "../bulk-pricing-plan";

const on99 = { roundTo99: true };

describe("targetPrice rounds the way the mode goes", () => {
  it("$9.60 reduced 1% does not go up", () => {
    const next = targetPrice(9.6, { mode: "reduce", value: 1, ...on99 });
    expect(next === null || next < 9.6).toBe(true);
    expect(targetPrice(9.6, { mode: "reduce", value: 1, roundTo99: false })).toBe(9.5);
  });

  it("$10.30 increased 1% does not go down", () => {
    const next = targetPrice(10.3, { mode: "increase", value: 1, ...on99 });
    expect(next === null || next > 10.3).toBe(true);
    expect(targetPrice(10.3, { mode: "increase", value: 1, roundTo99: false })).toBe(10.41);
  });

  it("$10.99 reduced 2% with .99 rounding is no change", () => {
    expect(targetPrice(10.99, { mode: "reduce", value: 2, ...on99 })).toBeNull();
  });

  it("a real reduce with .99 rounding lands below the current price", () => {
    expect(targetPrice(42, { mode: "reduce", value: 10, ...on99 })).toBe(37.99);
  });

  it("set uses the nearest .99", () => {
    expect(targetPrice(20, { mode: "set", value: 15.2, ...on99 })).toBe(14.99);
    expect(targetPrice(20, { mode: "set", value: 15.2, roundTo99: false })).toBe(15.2);
  });
});

const rows: PricingRow[] = [
  { id: "a", title: "Coat", price: 42, floorPrice: null },
  { id: "b", title: "Shirt", price: 42, floorPrice: 40 },
  { id: "c", title: "Hat", price: 10.99, floorPrice: null },
  { id: "d", title: "Scarf", price: 20, floorPrice: null },
];

describe("planBulk", () => {
  it("counts what will change, what the floor skips, and what does not move", () => {
    const plan = planBulk(
      rows,
      new Set(["a", "b", "c"]),
      new Set(["a", "b"]),
      { mode: "reduce", value: 2, roundTo99: true },
      undefined,
    );
    // a: 42 -> 40.99 changes. b: 40.99 is over its $40 floor, changes. c: no change.
    expect(plan.updates.map((u) => u.listing_id)).toEqual(["a", "b"]);
    expect(plan.updates[0]).toEqual({ listing_id: "a", price: 40.99, expected_price: 42 });
    expect(plan.noChange).toBe(1);
    expect(plan.hidden).toBe(1);
    expect(planSummary(plan)).toBe("2 will change, 1 no change");
  });

  it("skips a row the floor would cut through and sends only the others", () => {
    const plan = planBulk(
      rows,
      new Set(["a", "b"]),
      new Set(["a", "b"]),
      { mode: "reduce", value: 10, roundTo99: false },
      undefined,
    );
    expect(plan.floored.map((r) => r.id)).toEqual(["b"]);
    expect(plan.updates.map((u) => u.listing_id)).toEqual(["a"]);
    expect(planSummary(plan)).toBe("1 will change, 1 skipped (floor)");
  });

  it("flags a drop of more than half", () => {
    const plan = planBulk(
      rows,
      new Set(["a", "d"]),
      new Set(["a", "d"]),
      { mode: "set", value: 15, roundTo99: false },
      undefined,
    );
    expect(plan.bigMoves).toBe(1);
  });
});

describe("remainingSelection", () => {
  it("keeps only the failed ids after a partial failure", () => {
    expect([...remainingSelection([
      { listing_id: "a", ok: true },
      { listing_id: "b", ok: false },
      { listing_id: "c", ok: true },
    ])]).toEqual(["b"]);
  });
});

describe("confirmCopy", () => {
  const base = { updates: [{ listing_id: "a" }], floored: [], noChange: 0, hidden: 0, bigMoves: 0 };

  it("words quantity 0 as out of stock", () => {
    const c = confirmCopy(base, { priceOp: null, roundTo99: false, quantity: 0 });
    expect(c.title).toBe("Mark 1 listing out of stock on eBay?");
    expect(c.confirmLabel).toBe("Mark out of stock");
  });

  it("warns that a quantity above 1 can oversell", () => {
    const c = confirmCopy(base, { priceOp: null, roundTo99: false, quantity: 3 });
    expect(c.lines.join(" ")).toMatch(/sell the same garment 3 times/);
  });

  it("asks for an acknowledgement when a price halves or triples", () => {
    expect(confirmCopy(base, { priceOp: "x", roundTo99: false, quantity: undefined }).ack).toBeNull();
    const big = confirmCopy({ ...base, bigMoves: 2 }, { priceOp: "x", roundTo99: false, quantity: undefined });
    expect(big.ack).toMatch(/2 prices will drop by more than half or rise above 3x/);
  });
});

describe("the summary counts match what is sent", () => {
  it("changed equals the priced updates", () => {
    const plan = planBulk(
      rows,
      new Set(["a", "b", "c", "d"]),
      new Set(["a", "b", "c", "d"]),
      { mode: "reduce", value: 10, roundTo99: false },
      undefined,
    );
    expect(plan.changed).toBe(plan.updates.filter((u) => u.price != null).length);
    expect(plan.changed + plan.floored.length + plan.noChange).toBe(4);
  });
});
