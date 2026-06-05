// US-610: condition-adjusted value range math. condition-value.ts -> ebay-client
// -> supabase (throws at init w/o env), so dummy-env then dynamic-import.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { valueRangeFromStats, MIN_VALUE_COMPS } = await import("../lib/condition-value.ts");

// dollars
const STATS = { count: 12, min: 20, p25: 30, median: 40, p75: 55, max: 90 };

Deno.test("sufficient comps → low ≤ median ≤ high, sufficient true", () => {
  const r = valueRangeFromStats(STATS, 7.0);
  assertEquals(r.sufficient, true);
  assertEquals(r.sampleSize, 12);
  assert(r.lowCents! <= r.medianCents!);
  assert(r.medianCents! <= r.highCents!);
  // Range stays within the observed [min,max] band (in cents).
  assert(r.lowCents! >= 20 * 100);
  assert(r.highCents! <= 90 * 100);
});

Deno.test("too few comps → insufficient, null range", () => {
  const r = valueRangeFromStats({ count: 2, min: 20, p25: 20, median: 25, p75: 30, max: 30 }, 7.0);
  assertEquals(r.sufficient, false);
  assertEquals(r.lowCents, null);
  assertEquals(r.medianCents, null);
  assertEquals(r.highCents, null);
  assert(r.confidence <= 0.2);
});

Deno.test("a higher grade prices at/above a lower grade (within the used band)", () => {
  const hi = valueRangeFromStats(STATS, 8.5);
  const lo = valueRangeFromStats(STATS, 5.0);
  assert(hi.medianCents! >= lo.medianCents!);
});

Deno.test("a very low grade sits at the bottom of the band", () => {
  const r = valueRangeFromStats(STATS, 3.5);
  assertEquals(r.sufficient, true);
  // Below p25 (30) — a beat-up item is priced near the floor.
  assert(r.medianCents! <= 30 * 100);
  assert(r.lowCents! <= r.medianCents!);
});

Deno.test("confidence grows with sample size", () => {
  const few = valueRangeFromStats({ ...STATS, count: 4 }, 7.0);
  const many = valueRangeFromStats({ ...STATS, count: 30 }, 7.0);
  assert(many.confidence > few.confidence);
});

Deno.test("MIN_VALUE_COMPS boundary is respected", () => {
  const atMin = valueRangeFromStats({ count: MIN_VALUE_COMPS, min: 10, p25: 10, median: 12, p75: 14, max: 16 }, 6);
  assertEquals(atMin.sufficient, true);
  const below = valueRangeFromStats({ count: MIN_VALUE_COMPS - 1, min: 10, p25: 10, median: 12, p75: 14, max: 16 }, 6);
  assertEquals(below.sufficient, false);
});
