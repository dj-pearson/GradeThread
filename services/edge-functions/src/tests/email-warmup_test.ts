// US-915: the SES warmup ramp math is pure (no DB/env), so this runs standalone.

import { assert, assertEquals } from "@std/assert";
import {
  DEFAULT_WARMUP_SCHEDULE,
  effectiveBatchLimit,
  parseWarmupSchedule,
  remainingWarmupBudget,
  warmupDailyCap,
  warmupDayIndex,
} from "../lib/email-warmup.ts";

const DAY = 86_400_000;
const start = "2026-06-01"; // a fixed UTC date
const startMs = Date.parse("2026-06-01T00:00:00Z");

Deno.test("warmupDayIndex counts whole UTC days since the start date", () => {
  assertEquals(warmupDayIndex(start, startMs), 0);
  assertEquals(warmupDayIndex(start, startMs + DAY), 1);
  assertEquals(warmupDayIndex(start, startMs + 5 * DAY + 3_600_000), 5);
  // Before the start, or no/invalid start → -1.
  assertEquals(warmupDayIndex(start, startMs - DAY), -1);
  assertEquals(warmupDayIndex("", startMs), -1);
  assertEquals(warmupDayIndex("not-a-date", startMs), -1);
});

Deno.test("parseWarmupSchedule keeps positive ints; falls back on garbage", () => {
  assertEquals(parseWarmupSchedule([10, 20, 30]), [10, 20, 30]);
  assertEquals(parseWarmupSchedule([10, -5, "x", 0, 7]), [10, 7]);
  assertEquals(parseWarmupSchedule("nope"), [...DEFAULT_WARMUP_SCHEDULE]);
  assertEquals(parseWarmupSchedule([]), [...DEFAULT_WARMUP_SCHEDULE]);
});

Deno.test("warmupDailyCap returns the day's ceiling, null when off/started/warmed", () => {
  const schedule = [50, 100, 500];
  assertEquals(warmupDailyCap({ enabled: true, schedule, dayIndex: 0 }), 50);
  assertEquals(warmupDailyCap({ enabled: true, schedule, dayIndex: 2 }), 500);
  // Past the ramp → warmed, no cap.
  assertEquals(warmupDailyCap({ enabled: true, schedule, dayIndex: 3 }), null);
  // Disabled → no cap.
  assertEquals(warmupDailyCap({ enabled: false, schedule, dayIndex: 0 }), null);
  // Not started (dayIndex -1) → no cap.
  assertEquals(warmupDailyCap({ enabled: true, schedule, dayIndex: -1 }), null);
});

Deno.test("warmupDailyCap is bounded by the max send rate", () => {
  // rate 1/sec → 86400/day caps a larger schedule entry.
  assertEquals(
    warmupDailyCap({ enabled: true, schedule: [1_000_000], dayIndex: 0, maxRatePerSec: 1 }),
    86_400,
  );
});

Deno.test("remainingWarmupBudget subtracts sends; null cap = unlimited", () => {
  assertEquals(remainingWarmupBudget(100, 30), 70);
  assertEquals(remainingWarmupBudget(100, 150), 0); // never negative
  assertEquals(remainingWarmupBudget(null, 999), null);
});

Deno.test("effectiveBatchLimit folds the daily budget into the per-tick limit", () => {
  assertEquals(effectiveBatchLimit(1000, null), 1000); // no ramp → unchanged
  assertEquals(effectiveBatchLimit(1000, 250), 250); // daily budget is tighter
  assertEquals(effectiveBatchLimit(100, 5000), 100); // per-tick is tighter
  assertEquals(effectiveBatchLimit(1000, 0), 0); // exhausted today
});

Deno.test("a fresh identity paces up across days, not in a burst", () => {
  const schedule = [50, 100, 500];
  // Day 0 with nothing sent yet: budget is the day-0 cap.
  const day0 = effectiveBatchLimit(
    1000,
    remainingWarmupBudget(warmupDailyCap({ enabled: true, schedule, dayIndex: 0 }), 0),
  );
  assertEquals(day0, 50);
  // Day 1 after 40 already sent: 100 - 40 = 60 remaining.
  const day1 = effectiveBatchLimit(
    1000,
    remainingWarmupBudget(warmupDailyCap({ enabled: true, schedule, dayIndex: 1 }), 40),
  );
  assertEquals(day1, 60);
  assert(day0 < 1000 && day1 < 1000); // both well under the per-tick limit
});
