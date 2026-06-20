// US-915: SES warmup ramp + per-day send caps (PURE — no supabase/env/network so
// it unit-tests with zero setup). A freshly-warmed SES identity must not be hit
// with a full list on day one: a graduated daily cap ramps volume up over the
// first weeks so the new sending reputation is established gradually. The DAILY
// caps + the schedule live in the settings registry (seeded in 00292) so they're
// tunable without a deploy; the per-TICK batch bound (marketing_send_batch_limit)
// still caps burst within a day.
//
// Wiring: the bulk broadcast dispatcher (admin-growth) combines the per-tick
// batch limit with the remaining daily warmup budget so a large list drains over
// many ticks AND respects the day's ceiling. When warmup is disabled or the ramp
// has completed, the daily cap is `null` (unlimited) and only the per-tick batch
// bound applies — i.e. today's behaviour is unchanged until an operator turns the
// ramp on.

/** Settings-registry keys (seeded in 00292; tunable without a deploy). */
export const WARMUP_ENABLED_SETTING = "marketing_warmup_enabled";
export const WARMUP_SCHEDULE_SETTING = "marketing_warmup_schedule";
export const WARMUP_START_DATE_SETTING = "marketing_warmup_start_date";
export const MAX_SEND_RATE_SETTING = "marketing_max_send_rate_per_sec";

/**
 * A conservative SES ramp (daily ceilings) that roughly doubles each day for the
 * first ~two weeks. AWS's own guidance is to start small (~50/day) and increase
 * gradually while watching bounce/complaint rates. Past the last entry the
 * identity is considered warmed (no cap).
 */
export const DEFAULT_WARMUP_SCHEDULE: number[] = [
  50, 100, 500, 1000, 5000, 10000, 20000, 40000, 75000, 100000, 150000, 200000,
];

/** AWS SES default production max send rate (msgs/sec) before a quota increase. */
export const DEFAULT_MAX_SEND_RATE_PER_SEC = 14;

/** Coerce the registry value into a clean ascending list of positive integers. */
export function parseWarmupSchedule(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [...DEFAULT_WARMUP_SCHEDULE];
  const out: number[] = [];
  for (const v of raw) {
    const n = Math.floor(Number(v));
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out.length > 0 ? out : [...DEFAULT_WARMUP_SCHEDULE];
}

/**
 * 0-based number of whole days since `startDateIso` (a YYYY-MM-DD or ISO string),
 * in UTC. Returns -1 when there is no valid start date or the start is in the
 * future (warmup hasn't begun → no ramp yet).
 */
export function warmupDayIndex(startDateIso: string | null | undefined, nowMs: number): number {
  const raw = (startDateIso ?? "").trim();
  if (!raw) return -1;
  const startMs = Date.parse(raw.length === 10 ? `${raw}T00:00:00Z` : raw);
  if (!Number.isFinite(startMs)) return -1;
  const dayMs = 86_400_000;
  const startDay = Math.floor(startMs / dayMs);
  const nowDay = Math.floor(nowMs / dayMs);
  const idx = nowDay - startDay;
  return idx < 0 ? -1 : idx;
}

/**
 * The daily send ceiling for today, or `null` when there is no cap (warmup
 * disabled, no start date, or the ramp has completed). The cap is additionally
 * bounded by the theoretical day's throughput at the configured max send rate
 * (rate/sec × 86400) so it can never exceed what SES would physically accept.
 */
export function warmupDailyCap(opts: {
  enabled: boolean;
  schedule: number[];
  dayIndex: number;
  maxRatePerSec?: number;
}): number | null {
  if (!opts.enabled) return null;
  if (opts.dayIndex < 0) return null;
  const schedule = opts.schedule.length > 0 ? opts.schedule : DEFAULT_WARMUP_SCHEDULE;
  // Past the end of the ramp → warmed up, no cap.
  if (opts.dayIndex >= schedule.length) return null;
  let cap = schedule[opts.dayIndex] ?? schedule[schedule.length - 1] ?? 0;
  const rate = opts.maxRatePerSec && opts.maxRatePerSec > 0 ? opts.maxRatePerSec : 0;
  if (rate > 0) cap = Math.min(cap, Math.floor(rate * 86_400));
  return Math.max(0, cap);
}

/**
 * Remaining sends allowed today given the day's cap and how many already went
 * out. `null` cap → unlimited (returns null). Never negative.
 */
export function remainingWarmupBudget(
  dailyCap: number | null,
  sentToday: number,
): number | null {
  if (dailyCap === null) return null;
  return Math.max(0, dailyCap - Math.max(0, Math.floor(sentToday)));
}

/**
 * Fold the daily warmup budget into a per-tick batch limit: the effective number
 * of emails this tick may send is the smaller of the two (a `null` warmup budget
 * leaves the per-tick limit untouched). Never below 0.
 */
export function effectiveBatchLimit(
  perTickLimit: number,
  remainingDailyBudget: number | null,
): number {
  const tick = Math.max(0, Math.floor(perTickLimit));
  if (remainingDailyBudget === null) return tick;
  return Math.max(0, Math.min(tick, remainingDailyBudget));
}
