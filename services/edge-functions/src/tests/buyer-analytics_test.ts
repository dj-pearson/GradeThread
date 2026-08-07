// US-1845: the flywheel arithmetic behind the admin buyer-growth surface.
//
// No env dance needed — buyer-analytics.ts imports only posthog.ts, which reads
// Deno.env lazily inside captureServer and never touches lib/supabase.ts.

import { assertEquals } from "@std/assert";
import { pearson, summarizeFlywheel } from "../lib/buyer-analytics.ts";

Deno.test("pearson: perfectly correlated series", () => {
  assertEquals(pearson([1, 2, 3, 4], [2, 4, 6, 8]), 1);
});

Deno.test("pearson: perfectly anti-correlated series", () => {
  assertEquals(pearson([1, 2, 3, 4], [8, 6, 4, 2]), -1);
});

Deno.test("pearson: undefined rather than zero when a series is flat", () => {
  // A flat line correlates with nothing. Returning 0 would read as "measured, no
  // relationship" when the truth is "not measurable".
  assertEquals(pearson([1, 1, 1, 1], [1, 2, 3, 4]), null);
});

Deno.test("pearson: undefined with fewer than two points", () => {
  assertEquals(pearson([1], [1]), null);
  assertEquals(pearson([], []), null);
});

Deno.test("summarizeFlywheel: totals, ratio and rounded correlation", () => {
  const s = summarizeFlywheel([
    { date: "2026-01-01", buyer_demand: 2, seller_grades: 4 },
    { date: "2026-01-02", buyer_demand: 4, seller_grades: 8 },
    { date: "2026-01-03", buyer_demand: 6, seller_grades: 12 },
  ]);
  assertEquals(s.correlation, 1);
  assertEquals(s.days, 3);
  assertEquals(s.buyer_demand_total, 12);
  assertEquals(s.seller_grades_total, 24);
  assertEquals(s.grades_per_demand, 2);
});

Deno.test("summarizeFlywheel: no demand yields a null ratio, never a divide", () => {
  const s = summarizeFlywheel([
    { date: "2026-01-01", buyer_demand: 0, seller_grades: 3 },
    { date: "2026-01-02", buyer_demand: 0, seller_grades: 5 },
  ]);
  assertEquals(s.grades_per_demand, null);
  assertEquals(s.correlation, null);
  assertEquals(s.seller_grades_total, 8);
});

Deno.test("summarizeFlywheel: empty window is reported, not crashed on", () => {
  const s = summarizeFlywheel([]);
  assertEquals(s.days, 0);
  assertEquals(s.correlation, null);
  assertEquals(s.grades_per_demand, null);
});

// The web↔edge feature-key parity check lives on the VITEST side
// (src/lib/__tests__/buyer-analytics.test.ts), mirroring
// buyer-plan-limits-parity.test.ts: the web suite is the one that already
// reaches across the project boundary to read edge source as text.
