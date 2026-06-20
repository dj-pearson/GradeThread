import { assert, assertEquals } from "@std/assert";
import {
  bestOpenHour,
  clampScheduleConfig,
  DEFAULT_SCHEDULE_CONFIG,
  isIssueDue,
  isQuietPeriod,
  nextSendWindow,
  planRecipientSend,
  type ScheduleConfig,
  stoSpanEndMs,
  withinCadence,
} from "../lib/newsletter-schedule.ts";

// US-926: the scheduler math is pure — no supabase/env — so it tests directly
// (mirrors newsletter-tuning_test.ts).

function cfg(over: Partial<ScheduleConfig> = {}): ScheduleConfig {
  return clampScheduleConfig({ ...DEFAULT_SCHEDULE_CONFIG, ...over });
}

const DAY = 86_400_000;
const HOUR = 3_600_000;

Deno.test("clampScheduleConfig normalizes out-of-range + invalid inputs", () => {
  const c = clampScheduleConfig({
    weekday: 9, // → 9 % 7 = 2
    hour: 30, // → 23
    timezone: "Not/AZone",
    cadencePeriodDays: -3,
    stoWindowHours: 999,
    quietPeriodUntil: "   ",
  });
  assertEquals(c.weekday, 2);
  assertEquals(c.hour, 23);
  assertEquals(c.timezone, "UTC"); // invalid zone → UTC
  assertEquals(c.cadencePeriodDays, 0);
  assertEquals(c.stoWindowHours, 48); // capped
  assertEquals(c.quietPeriodUntil, null);
});

Deno.test("clampScheduleConfig handles negative weekday", () => {
  assertEquals(clampScheduleConfig({ weekday: -1 }).weekday, 6);
});

Deno.test("nextSendWindow returns the next future weekday+hour in UTC", () => {
  // 2026-06-15 is a Monday. Ask for Tuesday(2) @ 14:00 UTC.
  const now = Date.parse("2026-06-15T09:00:00Z");
  const next = nextSendWindow(cfg({ weekday: 2, hour: 14, timezone: "UTC" }), now);
  assertEquals(next, "2026-06-16T14:00:00.000Z"); // Tuesday
  const d = new Date(next);
  assertEquals(d.getUTCDay(), 2);
  assertEquals(d.getUTCHours(), 14);
  assert(Date.parse(next) > now);
});

Deno.test("nextSendWindow rolls to next week when today's window already passed", () => {
  // 2026-06-16 is a Tuesday; it's already 15:00, past the 14:00 window.
  const now = Date.parse("2026-06-16T15:00:00Z");
  const next = nextSendWindow(cfg({ weekday: 2, hour: 14, timezone: "UTC" }), now);
  assertEquals(next, "2026-06-23T14:00:00.000Z"); // next Tuesday
});

Deno.test("nextSendWindow is timezone-aware (DST offset baked in)", () => {
  // America/New_York in June is EDT (UTC-4). Tuesday 09:00 local → 13:00 UTC.
  const now = Date.parse("2026-06-15T00:00:00Z"); // Monday
  const next = nextSendWindow(cfg({ weekday: 2, hour: 9, timezone: "America/New_York" }), now);
  assertEquals(next, "2026-06-16T13:00:00.000Z");
});

Deno.test("isIssueDue compares the schedule against now", () => {
  const now = Date.parse("2026-06-16T14:00:00Z");
  assert(isIssueDue("2026-06-16T13:00:00Z", now));
  assert(isIssueDue("2026-06-16T14:00:00Z", now)); // exactly due
  assert(!isIssueDue("2026-06-16T15:00:00Z", now));
  assert(!isIssueDue(null, now));
  assert(!isIssueDue("not-a-date", now));
});

Deno.test("isQuietPeriod suppresses dispatch until the date, then releases", () => {
  const until = "2026-12-26T00:00:00Z";
  assert(isQuietPeriod(until, Date.parse("2026-12-24T00:00:00Z")));
  assert(!isQuietPeriod(until, Date.parse("2026-12-26T00:00:00Z")));
  assert(!isQuietPeriod(until, Date.parse("2026-12-27T00:00:00Z")));
  assert(!isQuietPeriod(null, Date.now()));
  assert(!isQuietPeriod("", Date.now()));
});

Deno.test("withinCadence guards a recipient inside the period", () => {
  const now = Date.parse("2026-06-16T14:00:00Z");
  // Sent 3 days ago, period 7 → still within → blocked.
  assert(withinCadence(now - 3 * DAY, 7, now));
  // Sent 8 days ago, period 7 → outside → eligible.
  assert(!withinCadence(now - 8 * DAY, 7, now));
  // Never sent → eligible.
  assert(!withinCadence(null, 7, now));
  // Period 0 → never blocks.
  assert(!withinCadence(now - HOUR, 0, now));
});

Deno.test("planRecipientSend: STO off sends at the window", () => {
  const base = Date.parse("2026-06-16T14:00:00Z");
  const plan = planRecipientSend(
    { stoEnabled: false, bestHour: 9, windowStartMs: base, stoWindowHours: 12 },
    base,
  );
  assertEquals(plan.targetMs, base);
  assert(plan.due);
});

Deno.test("planRecipientSend: no history → safe default at the window", () => {
  const base = Date.parse("2026-06-16T14:00:00Z");
  const plan = planRecipientSend(
    { stoEnabled: true, bestHour: null, windowStartMs: base, stoWindowHours: 12 },
    base,
  );
  assertEquals(plan.targetMs, base);
  assert(plan.due);
});

Deno.test("planRecipientSend: best hour after window staggers forward, defers until due", () => {
  const base = Date.parse("2026-06-16T14:00:00Z"); // window opens 14:00 UTC
  // Best hour 18 → target 18:00 same day.
  const plan = planRecipientSend(
    { stoEnabled: true, bestHour: 18, windowStartMs: base, stoWindowHours: 12 },
    base, // at window open, 18:00 not yet reached
  );
  assertEquals(new Date(plan.targetMs).getUTCHours(), 18);
  assert(!plan.due); // deferred to a later tick
  // Once 18:00 arrives it's due.
  const later = planRecipientSend(
    { stoEnabled: true, bestHour: 18, windowStartMs: base, stoWindowHours: 12 },
    base + 4 * HOUR,
  );
  assert(later.due);
});

Deno.test("planRecipientSend: best hour before window clamps to window open", () => {
  const base = Date.parse("2026-06-16T14:00:00Z");
  // Best hour 6 is before the 14:00 window → clamp to window open.
  const plan = planRecipientSend(
    { stoEnabled: true, bestHour: 6, windowStartMs: base, stoWindowHours: 12 },
    base,
  );
  assertEquals(plan.targetMs, base);
  assert(plan.due);
});

Deno.test("planRecipientSend: best hour beyond STO span clamps to span end", () => {
  const base = Date.parse("2026-06-16T14:00:00Z");
  // Best hour 23 but the STO window is only 4h → clamp to 18:00.
  const plan = planRecipientSend(
    { stoEnabled: true, bestHour: 23, windowStartMs: base, stoWindowHours: 4 },
    base,
  );
  assertEquals(plan.targetMs, stoSpanEndMs(base, 4));
  assertEquals(new Date(plan.targetMs).getUTCHours(), 18);
});

Deno.test("bestOpenHour returns the modal hour, lower hour on ties", () => {
  assertEquals(bestOpenHour([9, 9, 14, 14, 14, 20]), 14);
  assertEquals(bestOpenHour([8, 8, 17, 17]), 8); // tie → lower
  assertEquals(bestOpenHour([]), null);
  assertEquals(bestOpenHour([25, -1, 99]), null); // all out of range
  assertEquals(bestOpenHour([10]), 10);
});

Deno.test("stoSpanEndMs is the window plus the STO hours", () => {
  const base = Date.parse("2026-06-16T14:00:00Z");
  assertEquals(stoSpanEndMs(base, 12), base + 12 * HOUR);
  assertEquals(stoSpanEndMs(base, 0), base);
});
