// Pricing plan P15: the ladder the rule dialog draws is the planner's own
// arithmetic, step for step, including where a floor binds.
import { describe, expect, it } from "vitest";
import { planAction } from "../../../services/edge-functions/src/lib/automation-rules.ts";
import { describeLadder, priceLadder, type LadderInput } from "../price-ladder";

/** Run the server planner the way the hourly cron would, one step per cooldown. */
function serverLadder(i: LadderInput): number[] {
  const out = [i.startCents];
  let current = i.startCents;
  for (let n = 0; n < (i.maxSteps ?? 12); n++) {
    const planned = planAction(
      { type: "price_drop_pct", pct: i.dropPct, margin_floor_pct: i.marginFloorPct },
      {
        currentCents: current,
        costBasisDollars: i.costCents == null ? null : i.costCents / 100,
        itemFloorCents: i.itemFloorCents ?? null,
        currentPromoRatePct: null,
      },
    );
    if (!planned || planned.kind !== "price_drop") break;
    current = planned.newCents;
    out.push(current);
  }
  return out;
}

const FIXTURES: Array<[string, LadderInput]> = [
  ["no cost on record, runs until the step bound", {
    startCents: 6000, dropPct: 10, marginFloorPct: 10, costCents: null,
    firstDay: 30, cooldownDays: 7, maxSteps: 6,
  }],
  ["the cost floor binds", {
    startCents: 6000, dropPct: 10, marginFloorPct: 10, costCents: 2800,
    firstDay: 30, cooldownDays: 7,
  }],
  ["the item floor binds above the cost floor", {
    startCents: 9999, dropPct: 15, marginFloorPct: 10, costCents: 2000, itemFloorCents: 6500,
    firstDay: 45, cooldownDays: 14,
  }],
];

describe("priceLadder matches planAction", () => {
  for (const [name, input] of FIXTURES) {
    it(name, () => {
      const ladder = priceLadder(input);
      expect(ladder.steps.map((s) => s.cents)).toEqual(serverLadder(input));
      expect(ladder.steps.map((s) => s.day)).toEqual(
        ladder.steps.map((_, n) => input.firstDay + n * input.cooldownDays),
      );
    });
  }

  it("names the floor it stops at", () => {
    const l = priceLadder(FIXTURES[1]![1]);
    expect(l.endsAtFloor).toBe(true);
    expect(l.floorCents).toBe(3080);
    expect(describeLadder(l, 10)).toBe(
      "Day 30 $60.00, day 37 $54.00, day 44 $48.60, day 51 $43.74, stops at $30.80 (cost +10%)",
    );
    const item = priceLadder(FIXTURES[2]![1]);
    expect(item.floorKind).toBe("item");
    expect(describeLadder(item, 10)).toMatch(/stops at \$65\.00 \(your floor on the item\)$/);
  });

  it("says a ladder with no floor is still dropping", () => {
    expect(describeLadder(priceLadder(FIXTURES[0]![1]), 10)).toMatch(/still dropping$/);
  });
});
