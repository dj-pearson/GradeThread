import { assertEquals } from "@std/assert";
import {
  hourInZone,
  parseQuietHours,
  quietHoursActive,
  type QuietHours,
} from "../lib/quiet-hours.ts";

const qh = (patch: Partial<QuietHours> = {}): QuietHours => ({
  enabled: true,
  startHour: 22,
  endHour: 7,
  tz: "UTC",
  ...patch,
});

/** A UTC instant at a given whole hour, so the zone arithmetic is the only variable. */
const at = (hour: number) => new Date(Date.UTC(2026, 7, 24, hour, 30, 0));

Deno.test("quiet hours: a window that wraps midnight", () => {
  const window = qh({ startHour: 22, endHour: 7 });
  assertEquals(quietHoursActive(window, at(22)), true, "22:30 is inside");
  assertEquals(quietHoursActive(window, at(3)), true, "03:30 is inside");
  assertEquals(quietHoursActive(window, at(6)), true, "06:30 is inside");
  assertEquals(quietHoursActive(window, at(7)), false, "07:30 is past the end");
  assertEquals(quietHoursActive(window, at(12)), false, "midday is outside");
  assertEquals(quietHoursActive(window, at(21)), false, "21:30 is before the start");
});

Deno.test("quiet hours: a same-day window", () => {
  const window = qh({ startHour: 9, endHour: 17 });
  assertEquals(quietHoursActive(window, at(8)), false);
  assertEquals(quietHoursActive(window, at(9)), true, "the start hour is inside");
  assertEquals(quietHoursActive(window, at(16)), true);
  assertEquals(quietHoursActive(window, at(17)), false, "the end hour is not");
});

Deno.test("quiet hours: off states never mute", () => {
  assertEquals(quietHoursActive(null, at(3)), false, "no window configured");
  assertEquals(
    quietHoursActive(qh({ enabled: false }), at(3)),
    false,
    "configured but switched off",
  );
  assertEquals(
    quietHoursActive(qh({ startHour: 9, endHour: 9 }), at(9)),
    false,
    "start === end is NO window, not a 24-hour mute",
  );
});

Deno.test("quiet hours: the stored zone decides, not the server", () => {
  // 03:30 UTC is 22:30 the previous day in Chicago (CDT, UTC-5) — inside a
  // 22-to-07 window — and 12:30 in Tokyo, which is not.
  const chicago = qh({ tz: "America/Chicago" });
  const tokyo = qh({ tz: "Asia/Tokyo" });
  assertEquals(quietHoursActive(chicago, at(3)), true);
  assertEquals(quietHoursActive(tokyo, at(3)), false);
});

Deno.test("quiet hours: an unknown zone falls back to UTC rather than throwing", () => {
  assertEquals(hourInZone(at(3), "Mars/Olympus_Mons"), 3);
  assertEquals(quietHoursActive(qh({ tz: "Mars/Olympus_Mons" }), at(3)), true);
});

Deno.test("parseQuietHours: reads the stored shape", () => {
  const parsed = parseQuietHours({
    enabled: true,
    start_hour: 22,
    end_hour: 7,
    tz: "America/Chicago",
  });
  assertEquals(parsed, {
    enabled: true,
    startHour: 22,
    endHour: 7,
    tz: "America/Chicago",
  });
});

Deno.test("parseQuietHours: a window with no enabled flag is ON", () => {
  // Written by a client that predates the flag. The window is the thing the
  // user actually expressed; ignoring it would be the surprising read.
  const parsed = parseQuietHours({ start_hour: 1, end_hour: 5 });
  assertEquals(parsed?.enabled, true);
  assertEquals(parsed?.tz, "UTC");
});

Deno.test("parseQuietHours: anything unusable reads as no quiet hours", () => {
  // This sits on a fire-and-forget push path — refusing to send because a
  // preference blob is odd is worse than sending.
  for (
    const bad of [
      null,
      undefined,
      "22-07",
      [],
      {},
      { start_hour: 22 },
      { start_hour: 24, end_hour: 7 },
      { start_hour: -1, end_hour: 7 },
      { start_hour: "late", end_hour: 7 },
    ]
  ) {
    assertEquals(parseQuietHours(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});
