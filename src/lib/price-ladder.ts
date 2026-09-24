// Where a recurring price drop ends up, worked out before the rule is saved.
//
// Reproduces the Automations planner's price_drop_pct arithmetic
// (planAction in services/edge-functions/src/lib/automation-rules.ts): each step
// is floor(current * (1 - pct/100)), held at the floor, and the ladder stops the
// first time a step would not lower the price. The floor is the higher of cost
// plus the margin and the seller's floor on the item, and a missing cost is no
// floor at all, exactly as on the server. src/lib/__tests__/price-ladder.test.ts
// runs both on the same fixtures so the two cannot drift.

export interface LadderInput {
  startCents: number;
  dropPct: number;
  marginFloorPct: number;
  /** Purchase price in cents, or null when none is on record. */
  costCents: number | null;
  /** The seller's floor on the item, in cents, or null. */
  itemFloorCents?: number | null;
  /** Days listed when the rule first fires. */
  firstDay: number;
  /** Days between drops. */
  cooldownDays: number;
  /** Safety bound on the number of steps drawn. */
  maxSteps?: number;
}

export interface LadderStep {
  day: number;
  cents: number;
}

export interface Ladder {
  steps: LadderStep[];
  /** The binding floor, in cents, or null when nothing bounds the drops. */
  floorCents: number | null;
  /** Which floor binds: cost plus margin, or the seller's floor on the item. */
  floorKind: "cost" | "item" | null;
  /** True when the ladder ends on the floor rather than running out of steps. */
  endsAtFloor: boolean;
}

/** Cost plus margin, in cents, rounded up like the server. */
export function marginFloorCents(costCents: number | null, marginFloorPct: number): number | null {
  if (costCents == null || !Number.isFinite(costCents) || costCents <= 0) return null;
  return Math.ceil((Math.round(costCents) * (100 + marginFloorPct)) / 100);
}

export function priceLadder(i: LadderInput): Ladder {
  const cost = marginFloorCents(i.costCents, i.marginFloorPct);
  const item = i.itemFloorCents != null && Number.isFinite(i.itemFloorCents) && i.itemFloorCents >= 0
    ? i.itemFloorCents
    : null;
  const floorCents = cost == null ? item : item == null ? cost : Math.max(cost, item);
  const floorKind: Ladder["floorKind"] = floorCents == null
    ? null
    : item != null && floorCents === item && (cost == null || item >= cost)
    ? "item"
    : "cost";

  const steps: LadderStep[] = [{ day: i.firstDay, cents: i.startCents }];
  const maxSteps = i.maxSteps ?? 12;
  let current = i.startCents;
  let day = i.firstDay;
  let endsAtFloor = false;
  if (!(i.dropPct > 0) || current <= 0) return { steps, floorCents, floorKind, endsAtFloor };
  for (let n = 0; n < maxSteps; n++) {
    const dropped = Math.floor(current * (1 - i.dropPct / 100));
    const next = Math.max(dropped, floorCents ?? 0);
    if (next >= current) {
      endsAtFloor = floorCents != null;
      break;
    }
    day += i.cooldownDays;
    current = next;
    steps.push({ day, cents: current });
    if (floorCents != null && current <= floorCents) {
      endsAtFloor = true;
      break;
    }
  }
  return { steps, floorCents, floorKind, endsAtFloor };
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * "Day 30 $60.00, day 37 $54.00, day 44 $48.60, stops at $31.00 (cost +10%)".
 * Shows at most `shown` steps, then where it ends.
 */
export function describeLadder(l: Ladder, marginFloorPct: number, shown = 4): string {
  const head = l.steps.slice(0, shown).map((s, n) =>
    `${n === 0 ? "Day" : "day"} ${s.day} ${money(s.cents)}`
  );
  const last = l.steps[l.steps.length - 1]!;
  let tail = "";
  if (l.endsAtFloor && l.floorCents != null) {
    const why = l.floorKind === "item" ? "your floor on the item" : `cost +${marginFloorPct}%`;
    tail = `, stops at ${money(l.floorCents)} (${why})`;
  } else if (l.steps.length > shown) {
    tail = `, ${money(last.cents)} by day ${last.day} and still dropping`;
  }
  return head.join(", ") + tail;
}
