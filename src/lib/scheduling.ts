// US-563: timezone-aware scheduled drops. Resellers want to schedule listings
// to go live at peak buying times (the classic eBay peak is Sunday evening).
// The cron that publishes due drafts (`POST /jobs/publish-due`) runs every 5
// minutes against `listings.scheduled_publish_at` (a `timestamptz`, stored in
// UTC), so all this layer has to do is compute the correct UTC instant for a
// human preset like "next Sunday 7 PM" *in the seller's chosen timezone* — DST
// included — and hand it to the existing plumbing.
//
// We deliberately use the platform `Intl` APIs rather than pulling in
// date-fns-tz: the only operation we need is "wall-clock time in an IANA zone →
// UTC instant", which `Intl.DateTimeFormat` gives us for every zone the runtime
// knows, with no extra dependency.

export interface DropPreset {
  id: string;
  label: string;
  /** 0 = Sunday … 6 = Saturday. null = "next occurrence of this time on any day". */
  weekday: number | null;
  hour: number; // 0–23, local to the chosen timezone
  minute: number;
  hint?: string;
}

// Peak-visibility presets tuned for resale marketplaces. Sunday evening is the
// well-known eBay browsing peak; Thursday evening warms up the weekend shoppers.
export const DROP_PRESETS: DropPreset[] = [
  { id: "sun-7pm", label: "Sunday 7 PM", weekday: 0, hour: 19, minute: 0, hint: "Peak eBay browsing" },
  { id: "sun-8pm", label: "Sunday 8 PM", weekday: 0, hour: 20, minute: 0, hint: "Late-evening scrollers" },
  { id: "thu-8pm", label: "Thursday 8 PM", weekday: 4, hour: 20, minute: 0, hint: "Weekend warm-up" },
  { id: "mon-7pm", label: "Monday 7 PM", weekday: 1, hour: 19, minute: 0, hint: "Start-of-week deal hunters" },
  { id: "sat-10am", label: "Saturday 10 AM", weekday: 6, hour: 10, minute: 0, hint: "Weekend morning" },
  { id: "tonight-7pm", label: "Tonight / next 7 PM", weekday: null, hour: 19, minute: 0, hint: "Soonest evening slot" },
];

/** The viewer's IANA timezone (e.g. "America/Chicago"), with a UTC fallback. */
export function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// A short, curated list so the timezone picker isn't a 400-entry dump. The
// viewer's detected zone is merged in at render time if it's not already here.
export const COMMON_TIMEZONES: { id: string; label: string }[] = [
  { id: "America/New_York", label: "Eastern (New York)" },
  { id: "America/Chicago", label: "Central (Chicago)" },
  { id: "America/Denver", label: "Mountain (Denver)" },
  { id: "America/Phoenix", label: "Mountain — no DST (Phoenix)" },
  { id: "America/Los_Angeles", label: "Pacific (Los Angeles)" },
  { id: "America/Anchorage", label: "Alaska (Anchorage)" },
  { id: "Pacific/Honolulu", label: "Hawaii (Honolulu)" },
  { id: "America/Toronto", label: "Eastern — Canada (Toronto)" },
  { id: "Europe/London", label: "UK (London)" },
  { id: "Europe/Paris", label: "Central Europe (Paris)" },
  { id: "Australia/Sydney", label: "Australia (Sydney)" },
  { id: "UTC", label: "UTC" },
];

// The offset (zone − UTC) in milliseconds for a given instant in a given zone.
// Works by formatting the instant *as* the target zone and reading the wall
// clock back as if it were UTC — the difference is the offset.
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - instant.getTime();
}

/**
 * Convert a wall-clock time *in a specific IANA timezone* into the UTC `Date`
 * it represents. Handles DST by refining the offset once around the boundary.
 */
export function zonedWallTimeToUtc(
  year: number,
  month: number, // 1–12
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset1 = zoneOffsetMs(new Date(wallAsUtc), timeZone);
  let result = wallAsUtc - offset1;
  // Re-check the offset at the computed instant; if we crossed a DST boundary
  // the offset changes, so correct once more.
  const offset2 = zoneOffsetMs(new Date(result), timeZone);
  if (offset2 !== offset1) result = wallAsUtc - offset2;
  return new Date(result);
}

// The calendar date (year/month/day) that `instant` falls on in `timeZone`.
function zoneCalendarDate(instant: Date, timeZone: string): { year: number; month: number; day: number } {
  // en-CA formats as YYYY-MM-DD, which is trivial to split.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(instant)
    .split("-");
  return { year: Number(parts[0]), month: Number(parts[1]), day: Number(parts[2]) };
}

/**
 * Compute the next UTC instant for a preset, evaluated in `timeZone`. Returns
 * the soonest future occurrence (strictly after `from`). For weekday presets it
 * scans up to two weeks ahead; for a day-agnostic preset it picks the next time
 * that slot occurs (today if still future, else tomorrow).
 */
export function nextPresetUtc(preset: DropPreset, timeZone: string, from: Date = new Date()): Date {
  const today = zoneCalendarDate(from, timeZone);
  for (let i = 0; i < 14; i++) {
    // Advance the *calendar* date by i days using a stable noon-UTC anchor so
    // the arithmetic never drifts across DST.
    const anchor = new Date(Date.UTC(today.year, today.month - 1, today.day + i, 12, 0, 0));
    const y = anchor.getUTCFullYear();
    const m = anchor.getUTCMonth() + 1;
    const d = anchor.getUTCDate();
    const weekday = anchor.getUTCDay();
    if (preset.weekday != null && weekday !== preset.weekday) continue;
    const candidate = zonedWallTimeToUtc(y, m, d, preset.hour, preset.minute, timeZone);
    if (candidate.getTime() > from.getTime()) return candidate;
  }
  // Unreachable for sane presets, but keep a safe fallback (one week out).
  return new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
}

/**
 * Format a UTC ISO timestamp for display in a given timezone (short, friendly).
 * e.g. "Sun, Jun 14, 7:00 PM CDT".
 */
export function formatInZone(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(d);
}

/**
 * Convert a UTC ISO timestamp to the value an `<input type="datetime-local">`
 * expects, but expressed in an arbitrary IANA timezone (not the browser's).
 * Returns "YYYY-MM-DDTHH:mm", or "" for null/invalid input.
 */
export function isoToZonedInput(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/**
 * Inverse of `isoToZonedInput`: a "YYYY-MM-DDTHH:mm" wall-clock value typed in
 * `timeZone` → the UTC ISO string the DB stores. Returns null for empty/invalid.
 */
export function zonedInputToIso(local: string, timeZone: string): string | null {
  if (!local) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match;
  const utc = zonedWallTimeToUtc(Number(y), Number(mo), Number(d), Number(h), Number(mi), timeZone);
  return Number.isNaN(utc.getTime()) ? null : utc.toISOString();
}
