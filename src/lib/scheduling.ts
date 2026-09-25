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

// SD-13: one Intl.DateTimeFormat per (kind, zone). Building one is far from
// free, and the calendar used to build several per chip on every render.
export type FormatterKind = "offset" | "date" | "input" | "friendly" | "time";

const FORMATTER_OPTIONS: Record<FormatterKind, { locale: string; options: Intl.DateTimeFormatOptions }> = {
  offset: {
    locale: "en-US",
    options: {
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    },
  },
  // en-CA formats as YYYY-MM-DD, which is trivial to split.
  date: { locale: "en-CA", options: { year: "numeric", month: "2-digit", day: "2-digit" } },
  input: {
    locale: "en-CA",
    options: {
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    },
  },
  friendly: {
    locale: "en-US",
    options: {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    },
  },
  time: { locale: "en-US", options: { hour: "numeric", minute: "2-digit" } },
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

/** The shared formatter for `kind` in `timeZone`, built once. */
export function getFormatter(kind: FormatterKind, timeZone: string): Intl.DateTimeFormat {
  const key = `${kind}|${timeZone}`;
  let f = formatterCache.get(key);
  if (!f) {
    const { locale, options } = FORMATTER_OPTIONS[kind];
    f = new Intl.DateTimeFormat(locale, { ...options, timeZone });
    formatterCache.set(key, f);
  }
  return f;
}

// The offset (zone − UTC) in milliseconds for a given instant in a given zone.
// Works by formatting the instant *as* the target zone and reading the wall
// clock back as if it were UTC — the difference is the offset.
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = getFormatter("offset", timeZone).formatToParts(instant);
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

/** How a wall-clock time mapped onto the zone's real clock (SD-7). */
export type WallTimeAdjustment = "gap" | "overlap" | null;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Wall-clock time in `timeZone` to a UTC instant, saying whether the time fell
 * in a DST gap or overlap.
 *
 * The offsets a day either side of the wall time bracket any one transition,
 * and each gives a candidate instant; a candidate is real when its own wall
 * clock reads back as the time asked for. Two real candidates is an overlap
 * (the fall-back hour happens twice): take the EARLIER, as Temporal does. None
 * is a gap (the spring-forward hour does not exist): use the pre-transition
 * offset, which moves the time forward by the gap, Temporal's 'compatible'.
 * Zones differ in which way a single refinement lands, so this does not rely
 * on one.
 */
export function zonedWallTimeToUtcDetailed(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): { date: Date; adjusted: WallTimeAdjustment } {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const before = wallAsUtc - zoneOffsetMs(new Date(wallAsUtc - DAY_MS), timeZone);
  const after = wallAsUtc - zoneOffsetMs(new Date(wallAsUtc + DAY_MS), timeZone);
  const reads = (t: number) => t + zoneOffsetMs(new Date(t), timeZone) === wallAsUtc;
  const real = [before, after].filter(reads);
  if (real.length === 2 && real[0] !== real[1]) {
    return { date: new Date(Math.min(before, after)), adjusted: "overlap" };
  }
  if (real.length > 0) return { date: new Date(real[0]!), adjusted: null };
  return { date: new Date(before), adjusted: "gap" };
}

/**
 * Convert a wall-clock time *in a specific IANA timezone* into the UTC `Date`
 * it represents, DST gaps and overlaps included (see the detailed variant).
 */
export function zonedWallTimeToUtc(
  year: number,
  month: number, // 1–12
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  return zonedWallTimeToUtcDetailed(year, month, day, hour, minute, timeZone).date;
}

// The calendar date (year/month/day, month 1-based) that `instant` falls on in
// `timeZone`.
export function zoneCalendarDate(instant: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = getFormatter("date", timeZone).format(instant).split("-");
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
  return getFormatter("friendly", timeZone).format(d);
}

/** Just the clock time in a zone, e.g. "7:00 PM"; "-" for junk. */
export function formatTimeInZone(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return getFormatter("time", timeZone).format(d);
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
  const parts = getFormatter("input", timeZone).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/**
 * Inverse of `isoToZonedInput`: a "YYYY-MM-DDTHH:mm" wall-clock value typed in
 * `timeZone` → the UTC ISO string the DB stores, plus whether the time fell in
 * a DST gap (moved forward) or overlap (the earlier one taken). Returns null
 * for empty, malformed or impossible values: 2026-02-30 or 24:00 used to roll
 * over into the next day silently.
 */
export function zonedInputToIsoDetailed(
  local: string,
  timeZone: string,
): { iso: string; adjusted: WallTimeAdjustment } | null {
  if (!local) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!match) return null;
  const [y, mo, d, h, mi] = match.slice(1).map(Number) as [number, number, number, number, number];
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || d < 1) return null;
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d > daysInMonth) return null;
  const { date, adjusted } = zonedWallTimeToUtcDetailed(y, mo, d, h, mi, timeZone);
  return Number.isNaN(date.getTime()) ? null : { iso: date.toISOString(), adjusted };
}

/** `zonedInputToIsoDetailed` without the adjustment flag. */
export function zonedInputToIso(local: string, timeZone: string): string | null {
  return zonedInputToIsoDetailed(local, timeZone)?.iso ?? null;
}

// SD-2: the publish-due cron selects `scheduled_publish_at <= now` every five
// minutes, so a drop moved into the past, or into the next few minutes, goes
// live on eBay at the next tick. Every write path checks against this lead.
export const MIN_DROP_LEAD_MS = 5 * 60_000;

export type FutureDropCheck = { ok: true } | { ok: false; reason: string };

/**
 * Is `iso` far enough ahead to be a schedule rather than a publish-now? Pure,
 * so the mutation hooks and the dialog ask the same question.
 */
export function assertFutureDrop(
  iso: string,
  now: number = Date.now(),
  minLeadMs: number = MIN_DROP_LEAD_MS,
): FutureDropCheck {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) {
    return { ok: false, reason: "That is not a valid date and time." };
  }
  if (t < now + minLeadMs) {
    return { ok: false, reason: "That time has passed. Pick a later time." };
  }
  return { ok: true };
}

// -- Publish health (SD-3) ---------------------------------------------------
//
// Mirrors of the publish-due cron's own constants. Keep them in step with
// services/edge-functions/src/lib/publish-due-policy.ts
// (MAX_SCHEDULED_PUBLISH_ATTEMPTS) and
// services/edge-functions/src/routes/flipdesk-ebay-publish-due.ts
// (PUBLISH_CLAIM_STALE_MS); src/lib/scheduling.test.ts reads both files and
// fails if either number moves.

/** The cron publishes a scheduled draft at most this many times. */
export const MAX_SCHEDULED_PUBLISH_ATTEMPTS = 5;
/** A publish claim older than this is stale and the cron may retake the row. */
export const PUBLISH_CLAIM_STALE_MS = 10 * 60_000;

export type DropHealth = "scheduled" | "publishing" | "retrying" | "overdue" | "blocked";

/** The columns dropHealth reads, so it does not depend on the hook's row type. */
export interface DropHealthInput {
  scheduled_publish_at: string;
  publish_error?: string | null;
  publish_attempts?: number | null;
  publish_claimed_at?: string | null;
  synced_to_ebay_at?: string | null;
}

/**
 * What the cron will do with this drop, read the way the cron reads it:
 * due is `scheduled_publish_at <= now`, not yet synced, under the attempt cap,
 * and not held by a fresh claim. No platform filter, because the cron has none.
 */
export function dropHealth(row: DropHealthInput, now: number = Date.now()): DropHealth {
  const attempts = Number(row.publish_attempts ?? 0) || 0;
  // The cron's scan skips both of these for good; the row will never publish
  // from its schedule.
  if (row.synced_to_ebay_at != null || attempts >= MAX_SCHEDULED_PUBLISH_ATTEMPTS) {
    return "blocked";
  }
  const claimed = row.publish_claimed_at ? Date.parse(row.publish_claimed_at) : NaN;
  if (Number.isFinite(claimed) && now - claimed < PUBLISH_CLAIM_STALE_MS) {
    return "publishing";
  }
  if (attempts > 0 && row.publish_error) return "retrying";
  const at = Date.parse(row.scheduled_publish_at);
  if (Number.isFinite(at) && now - at > PUBLISH_CLAIM_STALE_MS) return "overdue";
  return "scheduled";
}

/** Health states the seller has to act on or at least know about. */
export function dropNeedsAttention(health: DropHealth): boolean {
  return health === "overdue" || health === "retrying" || health === "blocked";
}

/** Short words for each health state; paired with an icon, never color alone. */
export const DROP_HEALTH_LABEL: Record<DropHealth, string> = {
  scheduled: "Scheduled",
  publishing: "Publishing",
  retrying: "Retrying",
  overdue: "Overdue",
  blocked: "Blocked",
};

/**
 * One line telling the seller what happened to a drop, or null when nothing
 * has (a plain scheduled drop needs no note).
 */
export function dropHealthNote(
  row: DropHealthInput,
  health: DropHealth,
): string | null {
  const err = row.publish_error?.trim();
  const attempts = Number(row.publish_attempts ?? 0) || 0;
  switch (health) {
    case "publishing":
      return "Publishing now.";
    case "retrying":
      return `Retrying: attempt ${attempts} of ${MAX_SCHEDULED_PUBLISH_ATTEMPTS}.${err ? ` ${err}` : ""}`;
    case "overdue":
      return `Overdue. Did not publish.${err ? ` ${err}` : ""}`;
    case "blocked":
      if (row.synced_to_ebay_at != null) {
        return "Already on eBay, so this schedule will not run.";
      }
      return `Stopped after ${MAX_SCHEDULED_PUBLISH_ATTEMPTS} attempts.${err ? ` ${err}` : ""}`;
    default:
      return null;
  }
}

/** A shift a seller asks for: whole calendar days, clock minutes, or both. */
export interface DropShift {
  days?: number;
  minutes?: number;
}

/**
 * Move an instant by `days` calendar days IN `timeZone`, then by `minutes` of
 * absolute time (SD-6). A day is not 1440 minutes on a DST change night, so
 * "+1 day" on a 7:00 PM drop has to land on 7:00 PM the next day, not 6 or 8.
 */
export function shiftInZone(iso: string, timeZone: string, shift: DropShift): string {
  const days = shift.days ?? 0;
  const minutes = shift.minutes ?? 0;
  let t = Date.parse(iso);
  if (days !== 0) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(isoToZonedInput(iso, timeZone));
    if (m) {
      const [, y, mo, d, h, mi] = m;
      // Noon-UTC anchor, as in nextPresetUtc, so the calendar arithmetic never
      // drifts across a DST boundary.
      const anchor = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d) + days, 12));
      t = zonedWallTimeToUtc(
        anchor.getUTCFullYear(),
        anchor.getUTCMonth() + 1,
        anchor.getUTCDate(),
        Number(h),
        Number(mi),
        timeZone,
      ).getTime();
    }
  }
  return new Date(t + minutes * 60_000).toISOString();
}

// -- Spread (SD-14) ----------------------------------------------------------

/** Intervals offered when spreading a day's drops, in minutes. */
export const SPREAD_INTERVALS = [5, 10, 15, 30, 60] as const;

/**
 * `count` instants starting at `startIso`, `intervalMinutes` apart. Absolute
 * time, so a spread that crosses a DST change keeps its real gaps.
 */
export function spreadTimes(count: number, startIso: string, intervalMinutes: number): string[] {
  const start = Date.parse(startIso);
  if (!Number.isFinite(start) || count <= 0) return [];
  return Array.from({ length: count }, (_, i) =>
    new Date(start + i * intervalMinutes * 60_000).toISOString(),
  );
}

export type SpreadOrder = "current" | "price" | "promoted";

export const SPREAD_ORDER_LABEL: Record<SpreadOrder, string> = {
  current: "Current order",
  price: "Price, high to low",
  promoted: "Promoted first",
};

/**
 * The order drops take their new slots in. Stable: ties keep their current
 * (time) order, so re-running a spread never shuffles equal rows.
 */
export function orderForSpread<
  T extends { scheduled_publish_at: string; listing_price: number | null; promoted: boolean },
>(drops: readonly T[], order: SpreadOrder): T[] {
  const byTime = [...drops].sort(
    (a, b) => Date.parse(a.scheduled_publish_at) - Date.parse(b.scheduled_publish_at),
  );
  if (order === "price") {
    return byTime
      .map((d, i) => ({ d, i }))
      .sort((a, b) => (b.d.listing_price ?? -1) - (a.d.listing_price ?? -1) || a.i - b.i)
      .map(({ d }) => d);
  }
  if (order === "promoted") {
    return [...byTime.filter((d) => d.promoted), ...byTime.filter((d) => !d.promoted)];
  }
  return byTime;
}
