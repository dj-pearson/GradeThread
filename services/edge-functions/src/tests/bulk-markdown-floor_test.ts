// US-3195 AC3: the bulk markdown answers to the SHARED floor rule.
//
// Before this, /bulk-price carried its own `current * (1 - pct/100)` and its
// own `next < floor` compare, while the repricing engine used
// computeMarkdownCents + effectiveFloorCents. Two definitions of a floor in one
// codebase means the seller has one floor that three callers honour, which is
// not a floor at all.
//
// The route still REFUSES rather than clamping, which is the one place it
// diverges from the automation on purpose — see planPercentageMarkdown.

import { assertEquals } from "@std/assert";
import { planPercentageMarkdown } from "../routes/flipdesk-listings.ts";
import { computeMarkdownCents } from "../lib/repricing-rules.ts";

Deno.test("a drop clear of the floor goes through at the asked-for price", () => {
  // $48.00 less 10% = $43.20, floor $30.
  assertEquals(planPercentageMarkdown(48, 10, 30), { ok: true, price: 43.2 });
});

Deno.test("no floor set is the ABSENCE of a floor, not a floor of zero", () => {
  // $4.79 and not $4.80: the shared rule floors cents, and 4800 * 0.9 lands at
  // 479.999... in binary float. That is the downward direction, which is the
  // safe one for a markdown, and it is the same cent the automated repricing
  // engine has always produced for this input.
  assertEquals(planPercentageMarkdown(48, 90, null), { ok: true, price: 4.79 });
});

Deno.test("a drop through the floor is refused and NAMES the floor", () => {
  // $48.00 less 50% = $24.00, under a $30 floor.
  assertEquals(planPercentageMarkdown(48, 50, 30), {
    ok: false,
    reason: "floor",
    floor: 30,
  });
});

Deno.test("landing exactly ON the floor is allowed", () => {
  // The floor is the lowest acceptable price, not a price to stay above.
  assertEquals(planPercentageMarkdown(40, 25, 30), { ok: true, price: 30 });
});

Deno.test("a negative or nonsense floor is ignored rather than honoured", () => {
  assertEquals(planPercentageMarkdown(48, 50, -10), { ok: true, price: 24 });
  assertEquals(planPercentageMarkdown(48, 50, Number.NaN), { ok: true, price: 24 });
});

Deno.test("a drop that would reach zero is refused as zero, not as a floor", () => {
  // Distinct reasons: the seller can act on a floor and cannot act on this.
  const plan = planPercentageMarkdown(0.01, 99, null);
  assertEquals(plan, { ok: false, reason: "zero" });
});

Deno.test("the price it produces IS computeMarkdownCents, not a parallel sum", () => {
  // The whole point of the change: if the shared rule's arithmetic moves, this
  // route moves with it. Checked across prices that do not divide evenly.
  for (const price of [33.33, 19.99, 7.05, 120.01]) {
    for (const pct of [5, 10, 15, 20, 25, 33]) {
      const plan = planPercentageMarkdown(price, pct, null);
      const expected = computeMarkdownCents(Math.round(price * 100), pct, null, null) / 100;
      assertEquals(
        plan.ok ? plan.price : -1,
        expected,
        `${price} less ${pct}%`,
      );
    }
  }
});

Deno.test("the floor composes through effectiveFloorCents, cents not dollars", () => {
  // A floor of $29.995 cannot exist in the column, but a floor one cent above
  // the dropped price must still bind — this is the case a dollars-only
  // compare with toFixed rounding got wrong.
  // $33.33 less 10% = 2999 cents ($29.99). A $30.00 floor binds.
  assertEquals(planPercentageMarkdown(33.33, 10, 30), {
    ok: false,
    reason: "floor",
    floor: 30,
  });
  // A $29.99 floor does not.
  assertEquals(planPercentageMarkdown(33.33, 10, 29.99), { ok: true, price: 29.99 });
});
