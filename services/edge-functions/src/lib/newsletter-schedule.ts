// US-926: Weekly scheduler + send-time optimization — PURE module.
//
// No supabase / env / network imports (mirrors newsletter-tuning.ts) so the
// schedule math, timezone handling, cadence guard, quiet-period check, and the
// per-recipient send-time staggering all unit-test directly and are shared by the
// dispatch job + the admin console. Every function takes `nowMs` (or its inputs)
// explicitly so nothing reads the wall clock — deterministic + reproducible.
//
// The model:
//   • A weekly SEND WINDOW (configured weekday + hour in a configured timezone)
//     is the instant an approved issue is released. nextSendWindow() resolves it
//     to a concrete UTC instant accounting for the zone's offset (incl. DST).
//   • Optional SEND-TIME OPTIMIZATION staggers each recipient toward their
//     historically-best open hour, clamped inside [window, window+stoWindowHours],
//     with the window itself as the safe default when no history exists.
//   • A CADENCE GUARD treats a recipient who received any newsletter within the
//     configured period as ineligible, so re-runs never double-send.
//   • A QUIET PERIOD (holiday pause) suppresses dispatch until a date without
//     touching the cadence clock — skipping a week just means no sends happen.

// Still a pure module: zoned-time.ts imports nothing but Intl.
import { isValidTimeZone, partsInTz, zonedWallToUtcMs } from "./zoned-time.ts";

export interface ScheduleConfig {
  /** Day of week the weekly issue sends — 0=Sunday … 6=Saturday (matches cron DOW). */
  weekday: number;
  /** Hour of day (0–23) in `timezone` the window opens. */
  hour: number;
  /** IANA timezone the weekday/hour are interpreted in (e.g. "America/New_York"). */
  timezone: string;
  /** Days that must pass before a recipient may get another newsletter. */
  cadencePeriodDays: number;
  /** When true, stagger each recipient toward their best open hour. */
  stoEnabled: boolean;
  /** Hours after the window opens across which STO may spread sends. */
  stoWindowHours: number;
  /** ISO instant: while now < this, dispatch is paused (holiday/quiet period). null/"" = off. */
  quietPeriodUntil: string | null;
}

export const DEFAULT_SCHEDULE_CONFIG: ScheduleConfig = {
  weekday: 2, // Tuesday
  hour: 14, // 14:00
  timezone: "UTC",
  cadencePeriodDays: 7,
  stoEnabled: false,
  stoWindowHours: 12,
  quietPeriodUntil: null,
};

export function clampScheduleConfig(over?: Partial<ScheduleConfig>): ScheduleConfig {
  const c = { ...DEFAULT_SCHEDULE_CONFIG, ...(over ?? {}) };
  const weekday = Number.isFinite(c.weekday) ? ((Math.floor(c.weekday) % 7) + 7) % 7 : DEFAULT_SCHEDULE_CONFIG.weekday;
  const hour = Number.isFinite(c.hour) ? Math.min(23, Math.max(0, Math.floor(c.hour))) : DEFAULT_SCHEDULE_CONFIG.hour;
  const tz = typeof c.timezone === "string" && c.timezone.trim().length > 0
    ? c.timezone.trim()
    : DEFAULT_SCHEDULE_CONFIG.timezone;
  return {
    weekday,
    hour,
    timezone: isValidTimeZone(tz) ? tz : "UTC",
    cadencePeriodDays: Number.isFinite(c.cadencePeriodDays) ? Math.max(0, Math.floor(c.cadencePeriodDays)) : 7,
    stoEnabled: Boolean(c.stoEnabled),
    stoWindowHours: Number.isFinite(c.stoWindowHours) ? Math.min(48, Math.max(0, Math.floor(c.stoWindowHours))) : 12,
    quietPeriodUntil: typeof c.quietPeriodUntil === "string" && c.quietPeriodUntil.trim().length > 0
      ? c.quietPeriodUntil.trim()
      : null,
  };
}

// ── Timezone helpers ─────────────────────────────────────────────────────────
// These lived here privately until US-1851 needed the same wall-clock→UTC math
// for reward season boundaries; they now come from lib/zoned-time.ts so the two
// surfaces cannot disagree about when a boundary falls.

// ── Weekly window ──────────────────────────────────────────────────────────

/**
 * The next future send-window instant (ISO) — the configured weekday + hour in
 * the configured timezone, strictly after `nowMs`. DST-correct: the wall-clock
 * weekday/hour is resolved to a UTC instant via the zone offset at that local time.
 */
export function nextSendWindow(config: ScheduleConfig, nowMs: number): string {
  const cfg = clampScheduleConfig(config);
  const tz = cfg.timezone;
  const now = partsInTz(nowMs, tz);
  const daysUntil = ((cfg.weekday - now.weekday) % 7 + 7) % 7;

  // Proxy the local calendar date arithmetic on a UTC midnight so day-shifts
  // never drift across a DST boundary, then anchor the wall-clock hour in tz.
  const localMidnightProxy = Date.UTC(now.year, now.month - 1, now.day);
  const shift = (days: number) => {
    const d = new Date(localMidnightProxy + days * 86_400_000);
    return zonedWallToUtcMs(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), cfg.hour, tz);
  };

  let candidate = shift(daysUntil);
  if (candidate <= nowMs) candidate = shift(daysUntil + 7);
  return new Date(candidate).toISOString();
}

/** True once an issue's scheduled send window has arrived. */
export function isIssueDue(scheduledFor: string | null, nowMs: number): boolean {
  if (!scheduledFor) return false;
  const t = Date.parse(scheduledFor);
  return Number.isFinite(t) && t <= nowMs;
}

/** True while a holiday/quiet period is in effect (dispatch is suppressed). */
export function isQuietPeriod(quietPeriodUntil: string | null, nowMs: number): boolean {
  if (!quietPeriodUntil) return false;
  const t = Date.parse(quietPeriodUntil);
  return Number.isFinite(t) && nowMs < t;
}

// ── Cadence guard ──────────────────────────────────────────────────────────

/**
 * True when a recipient last sent at `lastSentMs` is still inside the cadence
 * period and must NOT receive another newsletter yet. `null` (never sent) is
 * always eligible. Idempotent by construction — a re-run with the same clock
 * re-derives the same verdict.
 */
export function withinCadence(lastSentMs: number | null, cadencePeriodDays: number, nowMs: number): boolean {
  if (lastSentMs == null || !Number.isFinite(lastSentMs)) return false;
  const period = Math.max(0, cadencePeriodDays) * 86_400_000;
  return nowMs - lastSentMs < period;
}

// ── Send-time optimization ──────────────────────────────────────────────────

/** Most-frequent UTC open hour from a recipient's open history, or null if none. */
export function bestOpenHour(hours: number[]): number | null {
  const freq = new Map<number, number>();
  for (const h of hours) {
    if (Number.isInteger(h) && h >= 0 && h <= 23) freq.set(h, (freq.get(h) ?? 0) + 1);
  }
  if (freq.size === 0) return null;
  let best: number | null = null;
  let bestCount = -1;
  for (const [h, c] of freq) {
    if (c > bestCount || (c === bestCount && best !== null && h < best)) {
      best = h;
      bestCount = c;
    }
  }
  return best;
}

export interface RecipientSendPlan {
  /** The UTC instant this recipient should be sent at. */
  targetMs: number;
  /** True once `nowMs` has reached the target (send this tick); else defer. */
  due: boolean;
}

/**
 * Plan one recipient's send instant. With STO off — or no open history — the send
 * fires at the window open (safe default). With STO on and a best hour, the send
 * is staggered to that hour on the window's day, clamped inside
 * [window, window + stoWindowHours] so it never lands before the window opens nor
 * after the staggering span closes.
 */
export function planRecipientSend(
  opts: { stoEnabled: boolean; bestHour: number | null; windowStartMs: number; stoWindowHours: number },
  nowMs: number,
): RecipientSendPlan {
  const base = opts.windowStartMs;
  if (!opts.stoEnabled || opts.bestHour == null) {
    return { targetMs: base, due: nowMs >= base };
  }
  const hour = Math.min(23, Math.max(0, Math.floor(opts.bestHour)));
  const wd = new Date(base);
  let candidate = Date.UTC(wd.getUTCFullYear(), wd.getUTCMonth(), wd.getUTCDate(), hour, 0, 0);
  if (candidate < base) candidate = base;
  const maxMs = base + Math.max(0, opts.stoWindowHours) * 3_600_000;
  if (candidate > maxMs) candidate = maxMs;
  return { targetMs: candidate, due: nowMs >= candidate };
}

/** The instant after which all STO staggering for a window has closed (everyone due). */
export function stoSpanEndMs(windowStartMs: number, stoWindowHours: number): number {
  return windowStartMs + Math.max(0, stoWindowHours) * 3_600_000;
}
