// US-2949: promotion lift.
//
// "This sale made $840" is not a finding — the items would have sold something
// without it. The tests here are almost all about the cases where the module
// must REFUSE to produce a lift number, because a percentage with no
// denominator is the fastest way to make a real finding look like a bug.
import { assert, assertEquals, assertFalse } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { MIN_PROMOTION_DAYS, computeLift, toPromotionRow } = await import(
  "../lib/promotion-store.ts"
);

const DAY = 86_400_000;
const T0 = Date.parse("2026-08-10T00:00:00.000Z");
const at = (offsetDays: number) => new Date(T0 + offsetDays * DAY).toISOString();
const sale = (offsetDays: number, priceCents = 5_000) => ({
  soldAt: at(offsetDays),
  priceCents,
});

// A promotion running days 0-7, compared against days -7 to 0.
const START = at(0);
const END = at(7);
const NOW = T0 + 10 * DAY;

Deno.test("lift compares the promotion window against the EQUAL window before it", () => {
  const out = computeLift(
    START,
    END,
    [
      // Before: 2 sales, $100.
      sale(-6),
      sale(-2),
      // During: 4 sales, $200.
      sale(1),
      sale(3),
      sale(4),
      sale(6),
    ],
    NOW,
  )!;
  assertEquals(out.before.units, 2);
  assertEquals(out.during.units, 4);
  assertEquals(out.unitLift, 1);
  assertEquals(out.revenueLift, 1);
  // Both windows are stated, so a seller sees what was compared.
  assertEquals(out.before.fromIso, at(-7));
  assertEquals(out.during.toIso, at(7));
});

Deno.test("a BEFORE window that sold nothing gives a NULL lift, not infinity", () => {
  // Three units against zero is not "infinite improvement" — it is a comparison
  // with no denominator.
  const out = computeLift(START, END, [sale(1), sale(2), sale(3)], NOW)!;
  assertEquals(out.during.units, 3);
  assertEquals(out.before.units, 0);
  assertEquals(out.unitLift, null);
  assertEquals(out.revenueLift, null);
});

Deno.test("a promotion shorter than the minimum has no comparison at all", () => {
  // A two-hour sale has no comparable 'before', and reporting one produces a
  // figure driven entirely by which afternoon it was.
  assertEquals(computeLift(START, at(MIN_PROMOTION_DAYS - 1), [sale(0)], NOW), null);
  assert(computeLift(START, at(MIN_PROMOTION_DAYS), [sale(0)], NOW) !== null);
});

Deno.test("a RUNNING promotion is compared up to now, not to its future end date", () => {
  // Otherwise the 'during' window includes days that have not happened and the
  // lift reads low for the whole time the sale is live.
  const nowMidway = T0 + 4 * DAY;
  const out = computeLift(START, at(30), [sale(1), sale(2)], nowMidway)!;
  assertEquals(out.during.toIso, new Date(nowMidway).toISOString());
  assertEquals(out.during.units, 2);
});

Deno.test("an unreadable or missing start date yields no lift", () => {
  assertEquals(computeLift(null, END, [sale(1)], NOW), null);
  assertEquals(computeLift("whenever", END, [sale(1)], NOW), null);
});

Deno.test("window edges are half-open, so one sale cannot land in both", () => {
  // A sale at the exact start belongs to DURING. Inclusive on both sides would
  // count it twice and inflate the lift on every promotion.
  const out = computeLift(START, END, [sale(0)], NOW)!;
  assertEquals(out.during.units, 1);
  assertEquals(out.before.units, 0);
});

Deno.test("toPromotionRow omits undefined so a list sync cannot erase a report", () => {
  const row = toPromotionRow("u1", { externalPromotionId: "p1", status: "RUNNING" }, at(0));
  assertEquals(row.status, "RUNNING");
  assertFalse("reported_units" in row);
  assertFalse("reported_revenue_cents" in row);
  // An explicit null IS written — that is eBay saying there is none.
  const cleared = toPromotionRow(
    "u1",
    { externalPromotionId: "p1", reportedUnits: null },
    at(0),
  );
  assert("reported_units" in cleared);
  assertEquals(cleared.reported_units, null);
});
