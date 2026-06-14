// US-891: pure period-resolution for the revenue dashboard.
//
// Kept in its own module (no supabase import) so the route handler stays thin
// and the resolver is unit-testable with no database / env — the same in CI as
// locally (mirrors the rate-limit-overrides split).

export type RevenuePeriod = "mtd" | "qtd" | "ytd" | "custom";
export type RevenueGranularity = "day" | "week";

export interface ResolvedRevenueWindow {
  period: RevenuePeriod;
  start: string; // ISO timestamp
  end: string; // ISO timestamp
  granularity: RevenueGranularity;
}

const DAY_MS = 24 * 60 * 60 * 1000;
// Auto-pick weekly buckets once the window is wide enough that daily buckets
// would be noisy / too many points to chart (≈ a quarter).
const DAILY_BUCKET_MAX_DAYS = 92;
// Guard against pathological custom ranges (RPC + chart cost).
const MAX_WINDOW_DAYS = 366 * 3;

function startOfMonthUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function startOfQuarterUTC(d: Date): Date {
  const qMonth = Math.floor(d.getUTCMonth() / 3) * 3;
  return new Date(Date.UTC(d.getUTCFullYear(), qMonth, 1));
}

function startOfYearUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
}

/**
 * Resolve a requested period into a concrete {start, end, granularity} window.
 * Pure + exported so it's unit-testable without a DB. Throws on an invalid
 * custom range (the route maps the throw to a 400).
 */
export function resolveRevenueWindow(opts: {
  period?: string | null;
  start?: string | null;
  end?: string | null;
  granularity?: string | null;
  now?: Date;
}): ResolvedRevenueWindow {
  const now = opts.now ?? new Date();
  const period = (opts.period ?? "mtd").toLowerCase() as RevenuePeriod;

  let start: Date;
  let end: Date = now;

  switch (period) {
    case "mtd":
      start = startOfMonthUTC(now);
      break;
    case "qtd":
      start = startOfQuarterUTC(now);
      break;
    case "ytd":
      start = startOfYearUTC(now);
      break;
    case "custom": {
      if (!opts.start || !opts.end) {
        throw new Error("custom period requires both start and end");
      }
      const s = new Date(opts.start);
      const e = new Date(opts.end);
      if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
        throw new Error("custom period start/end must be valid dates");
      }
      if (e <= s) {
        throw new Error("custom period end must be after start");
      }
      if (e.getTime() - s.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
        throw new Error("custom period window is too large");
      }
      start = s;
      end = e;
      break;
    }
    default:
      throw new Error(`unknown period: ${period}`);
  }

  // Granularity: honor an explicit valid override, else auto-pick by span.
  let granularity: RevenueGranularity;
  const gOverride = (opts.granularity ?? "").toLowerCase();
  if (gOverride === "day" || gOverride === "week") {
    granularity = gOverride;
  } else {
    const spanDays = (end.getTime() - start.getTime()) / DAY_MS;
    granularity = spanDays > DAILY_BUCKET_MAX_DAYS ? "week" : "day";
  }

  return {
    period,
    start: start.toISOString(),
    end: end.toISOString(),
    granularity,
  };
}
