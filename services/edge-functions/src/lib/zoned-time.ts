// Wall-clock-in-a-timezone math for the edge service.
//
// Extracted (US-1851) from newsletter-schedule.ts, which grew these four
// helpers privately for its weekly send window. Reward SEASONS need exactly the
// same thing — "the first instant of Q3 as observed in America/New_York" is a
// wall-clock date turned into a UTC instant — and a second private copy is how
// two surfaces quietly disagree about when a boundary falls.
//
// Everything here is pure and DST-correct: offsets are read from Intl at the
// instant in question rather than assumed fixed, because a fixed ±hours step
// lands an hour off across a DST change and a season would roll over on the
// wrong day.

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export interface ZonedParts {
  year: number;
  month: number; // 1–12
  day: number;
  hour: number; // 0–23
  minute: number;
  second: number;
  weekday: number; // 0=Sun
}

/** True when `tz` is an IANA zone this runtime understands. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of a UTC instant as observed in `tz`. */
export function partsInTz(utcMs: number, tz: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) map[p.type] = p.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: WEEKDAY_INDEX[map.weekday ?? "Sun"] ?? 0,
  };
}

/** Minutes `tz` is offset from UTC at the given instant (positive east of UTC). */
export function tzOffsetMinutes(utcMs: number, tz: string): number {
  const p = partsInTz(utcMs, tz);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return (asUTC - utcMs) / 60_000;
}

/**
 * The UTC instant of a wall-clock date/hour in `tz`. Two-pass: the first guess
 * uses the offset at the *guessed* instant, which is wrong exactly when the
 * guess and the answer sit on opposite sides of a DST transition, so the offset
 * is re-read at the corrected instant and applied again if it moved.
 */
export function zonedWallToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  tz: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, 0, 0);
  const off1 = tzOffsetMinutes(guess, tz);
  let utc = guess - off1 * 60_000;
  const off2 = tzOffsetMinutes(utc, tz);
  if (off2 !== off1) utc = guess - off2 * 60_000;
  return utc;
}
