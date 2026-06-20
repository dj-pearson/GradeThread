// US-934: marketing frequency cap & cross-program send coordination — PURE policy.
//
// The single source of truth for whether ONE marketing email may go out RIGHT
// NOW to a given recipient, coordinated across ALL marketing programs (trial
// drip, journeys, weekly newsletter, win-back). It enforces, in precedence
// order: consent (US-911) + suppression (US-914) as permanent drops; a
// cross-program precedence rule (the trial drip outranks the newsletter/journey,
// so those are paused while a recipient is in the drip); a quiet-hours window;
// and a per-recipient daily frequency cap. A blocked-but-not-dropped send is
// DEFERRED (re-queued) rather than lost.
//
// PURE module: no supabase / network / env imports, so the DB coordinator
// (lib/marketing-coordinator.ts) and its test share one source of truth — the
// coordinator resolves the booleans/counts/times and feeds them in; this maps
// them to send / defer / drop.

// ── Sources & precedence ──

export type MarketingSource =
  | "trial_drip"
  | "win_back"
  | "journey"
  | "weekly_newsletter";

/**
 * Cross-program precedence (lower = higher precedence). The trial drip and its
 * post-trial win-back tail outrank the generic journey engine and the weekly
 * newsletter, so the lower-precedence programs are paused for a recipient who is
 * actively enrolled in the drip (AC2: "drip wins; the newsletter is paused").
 */
export const MARKETING_PRECEDENCE: Record<MarketingSource, number> = {
  trial_drip: 0,
  win_back: 1,
  journey: 2,
  weekly_newsletter: 3,
};

// ── Configurable policy (mirrored in the settings registry, US-884) ──

export const DEFAULT_FREQUENCY_CAP_PER_DAY = 1;

export interface QuietHoursConfig {
  enabled: boolean;
  /** Local hour [0,24) the quiet window opens (e.g. 21 = 9pm). */
  startHour: number;
  /** Local hour [0,24) the quiet window closes (e.g. 8 = 8am). May be < startHour (the window wraps midnight). */
  endHour: number;
  /** IANA timezone the window is evaluated in (recipient tz, with a safe default). */
  timezone: string;
}

/** Safe default: no marketing 9pm–8am in US Central (the company's tz). */
export const DEFAULT_QUIET_HOURS: QuietHoursConfig = {
  enabled: true,
  startHour: 21,
  endHour: 8,
  timezone: "America/Chicago",
};

/** Coerce an arbitrary registry blob into a valid QuietHoursConfig. */
export function normalizeQuietHours(raw: unknown): QuietHoursConfig {
  if (!raw || typeof raw !== "object") return DEFAULT_QUIET_HOURS;
  const q = raw as Partial<QuietHoursConfig>;
  const inRange = (n: unknown): n is number =>
    typeof n === "number" && Number.isFinite(n) && n >= 0 && n < 24;
  return {
    enabled: typeof q.enabled === "boolean" ? q.enabled : DEFAULT_QUIET_HOURS.enabled,
    startHour: inRange(q.startHour) ? q.startHour : DEFAULT_QUIET_HOURS.startHour,
    endHour: inRange(q.endHour) ? q.endHour : DEFAULT_QUIET_HOURS.endHour,
    timezone: typeof q.timezone === "string" && q.timezone.trim()
      ? q.timezone
      : DEFAULT_QUIET_HOURS.timezone,
  };
}

// ── Quiet-hours + deferral-timing helpers (pure, time-of-day math) ──

/** Is `hour` (local, [0,24)) inside the (possibly midnight-wrapping) quiet window? */
export function isInQuietHours(hour: number, q: QuietHoursConfig): boolean {
  if (!q.enabled) return false;
  if (q.startHour === q.endHour) return false; // zero-width = effectively off
  return q.startHour < q.endHour
    ? hour >= q.startHour && hour < q.endHour
    : hour >= q.startHour || hour < q.endHour;
}

const MIN_MS = 60_000;

/** Ms from a local (hour,minute) to the next local midnight — the next cap window. */
export function msUntilLocalMidnight(localHour: number, localMinute: number): number {
  const minutesLeft = (24 - localHour) * 60 - localMinute;
  return Math.max(MIN_MS, minutesLeft * MIN_MS);
}

/** Ms from a local (hour,minute) until the next occurrence of `targetHour` (local). */
export function msUntilLocalHour(
  localHour: number,
  localMinute: number,
  targetHour: number,
): number {
  let hoursDelta = targetHour - localHour;
  if (hoursDelta <= 0) hoursDelta += 24;
  const minutes = hoursDelta * 60 - localMinute;
  return Math.max(MIN_MS, minutes * MIN_MS);
}

// ── The decision ──

export type MarketingSendAction = "send" | "defer" | "drop";

export interface MarketingSendInput {
  source: MarketingSource;
  /** Recipient opted out of marketing email (US-911). */
  optedOut: boolean;
  /** Recipient on the hard-bounce/complaint suppression list (US-914). */
  suppressed: boolean;
  /** Marketing emails already sent to this recipient in the current cap window. */
  sentInWindow: number;
  /** Per-recipient daily cap (configurable, ≥1). */
  capPerDay: number;
  /** Is the recipient currently enrolled in the (higher-precedence) trial drip? */
  enrolledInDrip: boolean;
  /** Recipient's local hour-of-day [0,24) now, for quiet-hours. */
  localHour: number;
  quietHours: QuietHoursConfig;
  /** Ms from now to the next cap window (next local midnight) — defer target. */
  msUntilWindowReset: number;
  /** Ms from now until quiet hours end — defer target when in quiet hours. */
  msUntilQuietEnd: number;
}

export interface MarketingSendDecision {
  action: MarketingSendAction;
  reason: string;
  /** When action === "defer": ms from now to re-attempt (re-queue delay). */
  deferMs?: number;
}

/**
 * Decide whether a marketing email is sent now, deferred (re-queued for later so
 * the content isn't lost), or dropped (the recipient must never receive it).
 *
 * Order matters:
 *   1. Consent / suppression → DROP (permanent; re-queuing would never become
 *      sendable, and re-sending is exactly what consent/suppression forbids).
 *   2. Cross-program precedence → DEFER a lower-precedence program while the
 *      recipient is in the drip (AC2 — newsletter/journey paused, drip wins).
 *   3. Quiet hours → DEFER until the window ends (AC4).
 *   4. Frequency cap → DEFER to the next window (AC1/AC3 — collapse, don't drop).
 */
export function evaluateMarketingSend(i: MarketingSendInput): MarketingSendDecision {
  if (i.optedOut) return { action: "drop", reason: "opted_out" };
  if (i.suppressed) return { action: "drop", reason: "suppressed" };

  if (
    i.enrolledInDrip &&
    MARKETING_PRECEDENCE[i.source] > MARKETING_PRECEDENCE.win_back
  ) {
    return {
      action: "defer",
      reason: "paused_for_drip",
      deferMs: Math.max(i.msUntilWindowReset, MIN_MS),
    };
  }

  if (isInQuietHours(i.localHour, i.quietHours)) {
    return {
      action: "defer",
      reason: "quiet_hours",
      deferMs: Math.max(i.msUntilQuietEnd, MIN_MS),
    };
  }

  if (i.sentInWindow >= Math.max(1, i.capPerDay)) {
    return {
      action: "defer",
      reason: "frequency_capped",
      deferMs: Math.max(i.msUntilWindowReset, MIN_MS),
    };
  }

  return { action: "send", reason: "ok" };
}
