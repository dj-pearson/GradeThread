// US-891: revenue dashboard period-resolution unit tests.
//
// Cover the PURE window resolver (named periods → concrete UTC window +
// granularity, and custom-range validation) so the decision logic runs with no
// database — the same in CI as locally. The aggregation itself lives in the
// revenue_dashboard RPC (migration 00215) and is exercised by verify:db.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { resolveRevenueWindow } from "../lib/revenue-window.ts";

// A fixed "now" so the assertions are deterministic: 2026-06-14T10:30:00Z.
const NOW = new Date("2026-06-14T10:30:00.000Z");

Deno.test("MTD: window starts at the first of the current month (UTC)", () => {
  const w = resolveRevenueWindow({ period: "mtd", now: NOW });
  assertEquals(w.period, "mtd");
  assertEquals(w.start, "2026-06-01T00:00:00.000Z");
  assertEquals(w.end, NOW.toISOString());
  assertEquals(w.granularity, "day"); // ~13 days → daily buckets
});

Deno.test("QTD: window starts at the first day of the quarter (Apr 1 for June)", () => {
  const w = resolveRevenueWindow({ period: "qtd", now: NOW });
  assertEquals(w.start, "2026-04-01T00:00:00.000Z");
  // Apr 1 → Jun 14 is ≈ 74 days (≤ 92), so daily buckets are kept.
  assertEquals(w.granularity, "day");
});

Deno.test("YTD: window starts at Jan 1 and uses weekly buckets", () => {
  const w = resolveRevenueWindow({ period: "ytd", now: NOW });
  assertEquals(w.start, "2026-01-01T00:00:00.000Z");
  assertEquals(w.granularity, "week");
});

Deno.test("default period is MTD when none supplied", () => {
  const w = resolveRevenueWindow({ now: NOW });
  assertEquals(w.period, "mtd");
  assertEquals(w.start, "2026-06-01T00:00:00.000Z");
});

Deno.test("custom: honors explicit start/end and auto-picks daily for a short span", () => {
  const w = resolveRevenueWindow({
    period: "custom",
    start: "2026-06-01T00:00:00.000Z",
    end: "2026-06-10T00:00:00.000Z",
    now: NOW,
  });
  assertEquals(w.start, "2026-06-01T00:00:00.000Z");
  assertEquals(w.end, "2026-06-10T00:00:00.000Z");
  assertEquals(w.granularity, "day");
});

Deno.test("granularity override is honored over the auto-pick", () => {
  const w = resolveRevenueWindow({ period: "mtd", granularity: "week", now: NOW });
  assertEquals(w.granularity, "week");
  const w2 = resolveRevenueWindow({ period: "ytd", granularity: "day", now: NOW });
  assertEquals(w2.granularity, "day");
});

Deno.test("invalid granularity override falls back to the auto-pick", () => {
  const w = resolveRevenueWindow({ period: "mtd", granularity: "month", now: NOW });
  assertEquals(w.granularity, "day");
});

Deno.test("custom without both bounds throws", () => {
  assertThrows(
    () => resolveRevenueWindow({ period: "custom", start: "2026-06-01T00:00:00Z", now: NOW }),
    Error,
    "custom period requires both start and end",
  );
});

Deno.test("custom with end <= start throws", () => {
  assertThrows(
    () =>
      resolveRevenueWindow({
        period: "custom",
        start: "2026-06-10T00:00:00.000Z",
        end: "2026-06-01T00:00:00.000Z",
        now: NOW,
      }),
    Error,
    "end must be after start",
  );
});

Deno.test("custom with an invalid date throws", () => {
  assertThrows(
    () =>
      resolveRevenueWindow({
        period: "custom",
        start: "not-a-date",
        end: "2026-06-01T00:00:00.000Z",
        now: NOW,
      }),
    Error,
    "valid dates",
  );
});

Deno.test("custom window larger than the cap throws", () => {
  assertThrows(
    () =>
      resolveRevenueWindow({
        period: "custom",
        start: "2018-01-01T00:00:00.000Z",
        end: "2026-06-01T00:00:00.000Z",
        now: NOW,
      }),
    Error,
    "too large",
  );
});

Deno.test("unknown period throws", () => {
  assertThrows(
    () => resolveRevenueWindow({ period: "lifetime", now: NOW }),
    Error,
    "unknown period",
  );
});

Deno.test("end never precedes start for any named period", () => {
  for (const period of ["mtd", "qtd", "ytd"] as const) {
    const w = resolveRevenueWindow({ period, now: NOW });
    assert(new Date(w.start) < new Date(w.end), `${period}: start < end`);
  }
});
