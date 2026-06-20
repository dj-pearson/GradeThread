// US-934: the marketing send coordinator's decision is the single source of
// truth for whether a marketing email is sent / deferred / dropped, coordinated
// across all marketing programs. The policy is pure, so this runs with no DB/env.

import { assert, assertEquals } from "@std/assert";
import {
  DEFAULT_QUIET_HOURS,
  evaluateMarketingSend,
  isInQuietHours,
  type MarketingSendInput,
  msUntilLocalHour,
  msUntilLocalMidnight,
  normalizeQuietHours,
} from "../lib/marketing-frequency.ts";

// A clean recipient at 2pm local, not in the drip, no marketing sent yet, with
// quiet hours effectively disabled so only the field under test drives the call.
const CLEAN: MarketingSendInput = {
  source: "weekly_newsletter",
  optedOut: false,
  suppressed: false,
  sentInWindow: 0,
  capPerDay: 1,
  enrolledInDrip: false,
  localHour: 14,
  quietHours: { enabled: false, startHour: 21, endHour: 8, timezone: "UTC" },
  msUntilWindowReset: 10 * 60 * 60 * 1000,
  msUntilQuietEnd: 0,
};

Deno.test("AC5: two same-day marketing sends collapse to one + a deferral", () => {
  // First send of the day: nothing sent yet, under the cap → sends.
  const first = evaluateMarketingSend({ ...CLEAN, sentInWindow: 0 });
  assertEquals(first.action, "send");

  // Second same-day send: the cap (1/day) is now reached → DEFERRED, not dropped
  // (the content is re-queued, not silently lost).
  const second = evaluateMarketingSend({ ...CLEAN, sentInWindow: 1 });
  assertEquals(second.action, "defer");
  assertEquals(second.reason, "frequency_capped");
  assert((second.deferMs ?? 0) > 0, "a deferral must carry a positive re-queue delay");
});

Deno.test("AC1: a configurable higher cap allows more same-day sends", () => {
  const d = evaluateMarketingSend({ ...CLEAN, capPerDay: 3, sentInWindow: 2 });
  assertEquals(d.action, "send");
  const capped = evaluateMarketingSend({ ...CLEAN, capPerDay: 3, sentInWindow: 3 });
  assertEquals(capped.action, "defer");
});

Deno.test("AC6: opted-out recipient is DROPPED (consent is the chokepoint, US-911)", () => {
  const d = evaluateMarketingSend({ ...CLEAN, optedOut: true, sentInWindow: 0 });
  assertEquals(d.action, "drop");
  assertEquals(d.reason, "opted_out");
});

Deno.test("AC6: suppressed recipient is DROPPED (US-914)", () => {
  const d = evaluateMarketingSend({ ...CLEAN, suppressed: true, sentInWindow: 0 });
  assertEquals(d.action, "drop");
  assertEquals(d.reason, "suppressed");
});

Deno.test("AC2: newsletter is paused (deferred) while enrolled in the trial drip", () => {
  const d = evaluateMarketingSend({ ...CLEAN, source: "weekly_newsletter", enrolledInDrip: true });
  assertEquals(d.action, "defer");
  assertEquals(d.reason, "paused_for_drip");
  assert((d.deferMs ?? 0) > 0);
});

Deno.test("AC2: the drip itself is NOT paused by its own enrollment (drip wins)", () => {
  const drip = evaluateMarketingSend({ ...CLEAN, source: "trial_drip", enrolledInDrip: true });
  assertEquals(drip.action, "send");
  const winback = evaluateMarketingSend({ ...CLEAN, source: "win_back", enrolledInDrip: true });
  assertEquals(winback.action, "send");
});

Deno.test("AC4: a send during quiet hours is deferred until the window ends", () => {
  const q = { enabled: true, startHour: 21, endHour: 8, timezone: "UTC" };
  const d = evaluateMarketingSend({
    ...CLEAN,
    localHour: 23,
    quietHours: q,
    msUntilQuietEnd: 9 * 60 * 60 * 1000,
  });
  assertEquals(d.action, "defer");
  assertEquals(d.reason, "quiet_hours");
  assert((d.deferMs ?? 0) > 0);
});

Deno.test("permanent stops beat transient blocks (opt-out wins over a cap deferral)", () => {
  const d = evaluateMarketingSend({
    ...CLEAN,
    optedOut: true,
    sentInWindow: 5,
    enrolledInDrip: true,
  });
  assertEquals(d.action, "drop");
  assertEquals(d.reason, "opted_out");
});

Deno.test("isInQuietHours handles a midnight-wrapping window", () => {
  const q = { enabled: true, startHour: 21, endHour: 8, timezone: "UTC" };
  assert(isInQuietHours(23, q), "11pm is inside 21→08");
  assert(isInQuietHours(2, q), "2am is inside 21→08");
  assert(!isInQuietHours(12, q), "noon is outside 21→08");
  assert(!isInQuietHours(20, { ...q, enabled: false }), "disabled window is never quiet");
});

Deno.test("isInQuietHours handles a same-day window", () => {
  const q = { enabled: true, startHour: 1, endHour: 6, timezone: "UTC" };
  assert(isInQuietHours(3, q));
  assert(!isInQuietHours(7, q));
  assert(!isInQuietHours(0, q));
});

Deno.test("deferral-timing helpers return positive, sensible delays", () => {
  // 2:30pm → 9.5h to next local midnight.
  assertEquals(msUntilLocalMidnight(14, 30), (9 * 60 + 30) * 60_000);
  // 11pm → 9h to 8am the next day.
  assertEquals(msUntilLocalHour(23, 0, 8), 9 * 60 * 60_000);
  // Always at least a minute (never zero / negative).
  assert(msUntilLocalMidnight(23, 59) >= 60_000);
  assert(msUntilLocalHour(8, 0, 8) >= 60_000);
});

Deno.test("normalizeQuietHours coerces bad blobs to the safe default", () => {
  assertEquals(normalizeQuietHours(null), DEFAULT_QUIET_HOURS);
  assertEquals(normalizeQuietHours("nope"), DEFAULT_QUIET_HOURS);
  const partial = normalizeQuietHours({ enabled: true, startHour: 99, endHour: 6 });
  assertEquals(partial.startHour, DEFAULT_QUIET_HOURS.startHour); // 99 rejected
  assertEquals(partial.endHour, 6); // valid kept
  assertEquals(partial.timezone, DEFAULT_QUIET_HOURS.timezone); // missing → default
});
