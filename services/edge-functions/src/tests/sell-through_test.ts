// US-623: sell-through forecast heuristic (pure).
import { assert, assertEquals } from "@std/assert";
import { forecastSellThrough } from "../lib/sell-through.ts";
import type { ValueRange } from "../lib/condition-value.ts";

const value = (sufficient = true): ValueRange => ({
  lowCents: 4000,
  medianCents: 5000,
  highCents: 6500,
  sampleSize: 14,
  confidence: 0.8,
  sufficient,
  currency: "USD",
});

Deno.test("insufficient comps → unknown", () => {
  const f = forecastSellThrough(value(false), 5000);
  assertEquals(f.label, "unknown");
  assertEquals(f.sellThroughPct, 0);
});

Deno.test("priced at/below the low end → fast, high sell-through", () => {
  const f = forecastSellThrough(value(), 3500);
  assertEquals(f.label, "fast");
  assert(f.sellThroughPct >= 0.7);
});

Deno.test("priced above the high end → slow, low sell-through", () => {
  const f = forecastSellThrough(value(), 9000);
  assertEquals(f.label, "slow");
  assert(f.sellThroughPct < 0.45);
});

Deno.test("higher price → lower sell-through + longer days (monotonic)", () => {
  const cheap = forecastSellThrough(value(), 4000);
  const dear = forecastSellThrough(value(), 6000);
  assert(cheap.sellThroughPct >= dear.sellThroughPct);
  assert(cheap.daysHigh <= dear.daysHigh);
});

Deno.test("days band is sane", () => {
  const f = forecastSellThrough(value(), 5000);
  assert(f.daysLow >= 0 && f.daysLow <= f.daysHigh);
});
