// US-1863: the PURE half of Thrift Radar aggregation — window math, the
// venue x brand rollup, the k-anonymity floor, and the retention rollup.
//
// Third instance of the split US-1861 and US-1862 established: nothing in this
// file touches Supabase or the environment, so the aggregation math, the floor
// and the pruning boundary are unit-testable directly rather than only through
// a cron. The impure half (reads, upserts, the delete) is
// `radar-aggregate-engine.ts`.
//
// The rule this file exists to keep true — full text in
// vault/20-domain/thrift-radar.md rule 6:
//
//   A venue x window aggregate is served only above K DISTINCT CONTRIBUTORS.
//   Below the floor the endpoint returns NOTHING — not a redacted payload the
//   client is trusted to hide.
//
// The shape that makes that hard to get wrong: `aggregateScanEvents` produces
// candidate rows, and NOTHING downstream consumes them directly. The only way
// to a servable row is `servableAggregates(rows, k)`, which drops below-floor
// groups entirely. The engine writes only what comes out of it, the table
// carries a CHECK that refuses a single-contributor row, and the endpoint
// re-applies the floor on read. Four layers, because "someone remembered" is
// not a privacy guarantee.

import type { RadarGradeBand, RadarVerdict } from "./radar-privacy.ts";

// ── Windows ─────────────────────────────────────────────────────────────────

export const RADAR_WINDOWS = [
  { key: "7d", days: 7 },
  { key: "30d", days: 30 },
  { key: "90d", days: 90 },
] as const;

export type RadarWindowKey = typeof RADAR_WINDOWS[number]["key"];

/** What the endpoint answers with when the caller names no window. */
export const DEFAULT_RADAR_WINDOW: RadarWindowKey = "30d";

export function isRadarWindowKey(value: unknown): value is RadarWindowKey {
  return typeof value === "string" &&
    RADAR_WINDOWS.some((w) => w.key === value);
}

export function radarWindowDays(key: RadarWindowKey): number {
  return RADAR_WINDOWS.find((w) => w.key === key)?.days ?? 30;
}

/** The widest window we ever aggregate — how far back the engine must read. */
export const MAX_RADAR_WINDOW_DAYS = RADAR_WINDOWS.reduce(
  (max, w) => Math.max(max, w.days),
  0,
);

const MS_PER_DAY = 86_400_000;

// ── The k-anonymity floor ───────────────────────────────────────────────────

export const DEFAULT_K_ANONYMITY_FLOOR = 3;

/**
 * The floor may be raised but never lowered past this.
 *
 * `radar_privacy.k_anonymity_floor` is an operator-editable JSON value, and a
 * floor of 1 is not "aggregation with the knob turned down" — it is publishing
 * one person's afternoon under a venue's name. So the config is a MINIMUM the
 * operator may exceed, not a number they may replace. The same bound is a CHECK
 * on `radar_venue_aggregates.contributor_count`, which is what makes this a
 * property of the data rather than of this function being called.
 */
export const MIN_K_ANONYMITY_FLOOR = 2;

/** Clamp a configured floor into the range the schema will actually accept. */
export function clampKFloor(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw)
    ? Math.round(raw)
    : DEFAULT_K_ANONYMITY_FLOOR;
  return Math.max(MIN_K_ANONYMITY_FLOOR, n);
}

// ── Brand keys ──────────────────────────────────────────────────────────────

/**
 * The brand_key of the row that covers EVERY brand seen at a venue.
 *
 * One table holds both grains — the venue total and the per-brand breakdown —
 * because the floor, the retention sweep and the serving filter apply
 * identically to both, and a second table would mean a second copy of each
 * guard. A copied privacy guard is a guard that goes stale on one side.
 */
export const ALL_BRANDS_KEY = "*";

/**
 * Fold a free-typed brand to its aggregation key, or null when there is nothing
 * to key on. Never returns the all-brands sentinel, so a garment literally
 * branded "*" cannot collide with the venue total.
 */
export function brandKey(brand: string | null | undefined): string | null {
  if (typeof brand !== "string") return null;
  const key = brand.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120);
  if (!key || key === ALL_BRANDS_KEY) return null;
  return key;
}

// ── Grade bands → an average grade ──────────────────────────────────────────

/**
 * Representative grade for each condition band.
 *
 * `radar_scan_events` stores a BAND, never the numeric grade — that was 00547's
 * minimization, and it is not being undone here. So "average estimated grade"
 * is computed at band resolution from these midpoints, which is honest about
 * its precision: it is reported to one decimal and can only ever land between
 * 5.0 and 9.0. Mirrors bandForGrade() in resale-condition.ts (low <= 6,
 * mid <= 8, high above).
 */
export const BAND_MIDPOINT: Record<Exclude<RadarGradeBand, "ungraded">, number> = {
  low: 5.0,
  mid: 7.0,
  high: 9.0,
};

// ── Inputs ──────────────────────────────────────────────────────────────────

/** The event columns aggregation reads. A strict subset of the stored row. */
export interface RadarScanEvent {
  id?: string;
  contributor_key: string;
  venue_id: string | null;
  geohash: string | null;
  brand: string | null;
  grade_band: RadarGradeBand;
  verdict: RadarVerdict;
  scanned_at: string;
}

/** One venue x window x brand aggregate, before the floor is applied. */
export interface RadarAggregateRow {
  venue_id: string;
  window_key: RadarWindowKey;
  brand_key: string;
  window_start: string;
  window_end: string;
  scan_count: number;
  /** DISTINCT contributor keys. The only number the floor is computed from. */
  contributor_count: number;
  avg_grade: number | null;
  high_count: number;
  mid_count: number;
  low_count: number;
  ungraded_count: number;
  buy_count: number;
  /** Scans that produced a real verdict — 'unknown' is excluded from the rate. */
  verdict_count: number;
  buy_rate: number | null;
  last_activity_at: string;
}

interface Bucket {
  contributors: Set<string>;
  scans: number;
  bands: Record<RadarGradeBand, number>;
  buys: number;
  verdicts: number;
  lastActivityMs: number;
}

function emptyBucket(): Bucket {
  return {
    contributors: new Set<string>(),
    scans: 0,
    bands: { high: 0, mid: 0, low: 0, ungraded: 0 },
    buys: 0,
    verdicts: 0,
    lastActivityMs: 0,
  };
}

function addToBucket(bucket: Bucket, event: RadarScanEvent, atMs: number): void {
  bucket.contributors.add(event.contributor_key);
  bucket.scans += 1;
  const band = event.grade_band in bucket.bands ? event.grade_band : "ungraded";
  bucket.bands[band] += 1;
  if (event.verdict !== "unknown") {
    bucket.verdicts += 1;
    if (event.verdict === "buy") bucket.buys += 1;
  }
  if (atMs > bucket.lastActivityMs) bucket.lastActivityMs = atMs;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function averageGrade(bands: Record<RadarGradeBand, number>): number | null {
  const graded = bands.high + bands.mid + bands.low;
  if (graded === 0) return null;
  const total = bands.high * BAND_MIDPOINT.high +
    bands.mid * BAND_MIDPOINT.mid +
    bands.low * BAND_MIDPOINT.low;
  return round1(total / graded);
}

export interface AggregateOptions {
  now: Date;
  windows?: readonly RadarWindowKey[];
}

/**
 * Roll a set of scan events into venue x window x brand aggregates.
 *
 * Only VENUE-RESOLVED events participate: an event that never found a venue
 * still has a cell, but a cell is not a place anyone can be told about, and
 * publishing cell-level hotness would hand back the neighbourhood resolution
 * the venue layer exists to replace. Unresolved events are still retained and
 * archived — see `rollupExpiredEvents` — they just are not network intelligence
 * yet.
 *
 * Every group produces BOTH a per-brand row and a contribution to the venue's
 * all-brands row, so a venue total is never re-derived by summing brands (which
 * would double-count a contributor who scanned two brands).
 */
export function aggregateScanEvents(
  events: readonly RadarScanEvent[],
  opts: AggregateOptions,
): RadarAggregateRow[] {
  const nowMs = opts.now.getTime();
  const windows = (opts.windows ?? RADAR_WINDOWS.map((w) => w.key))
    .filter(isRadarWindowKey);
  const windowEnd = new Date(nowMs).toISOString();

  const rows: RadarAggregateRow[] = [];

  for (const windowKey of windows) {
    const days = radarWindowDays(windowKey);
    const startMs = nowMs - days * MS_PER_DAY;
    const windowStart = new Date(startMs).toISOString();

    // venue_id -> brand_key -> bucket
    const byVenue = new Map<string, Map<string, Bucket>>();

    for (const event of events) {
      if (!event.venue_id) continue;
      const atMs = Date.parse(event.scanned_at);
      if (!Number.isFinite(atMs)) continue;
      if (atMs < startMs || atMs > nowMs) continue;

      let brands = byVenue.get(event.venue_id);
      if (!brands) {
        brands = new Map<string, Bucket>();
        byVenue.set(event.venue_id, brands);
      }

      for (const key of [ALL_BRANDS_KEY, brandKey(event.brand)]) {
        if (key === null) continue;
        let bucket = brands.get(key);
        if (!bucket) {
          bucket = emptyBucket();
          brands.set(key, bucket);
        }
        addToBucket(bucket, event, atMs);
      }
    }

    for (const [venueId, brands] of byVenue) {
      for (const [key, bucket] of brands) {
        rows.push({
          venue_id: venueId,
          window_key: windowKey,
          brand_key: key,
          window_start: windowStart,
          window_end: windowEnd,
          scan_count: bucket.scans,
          contributor_count: bucket.contributors.size,
          avg_grade: averageGrade(bucket.bands),
          high_count: bucket.bands.high,
          mid_count: bucket.bands.mid,
          low_count: bucket.bands.low,
          ungraded_count: bucket.bands.ungraded,
          buy_count: bucket.buys,
          verdict_count: bucket.verdicts,
          buy_rate: bucket.verdicts > 0 ? round3(bucket.buys / bucket.verdicts) : null,
          last_activity_at: new Date(bucket.lastActivityMs).toISOString(),
        });
      }
    }
  }

  // Deterministic order in, deterministic order out — the engine writes in
  // chunks and a test can pin the result.
  rows.sort((a, b) =>
    a.venue_id < b.venue_id
      ? -1
      : a.venue_id > b.venue_id
      ? 1
      : a.window_key < b.window_key
      ? -1
      : a.window_key > b.window_key
      ? 1
      : a.brand_key < b.brand_key
      ? -1
      : a.brand_key > b.brand_key
      ? 1
      : 0
  );
  return rows;
}

/**
 * The floor. Keeps only the groups that were contributed to by at least `k`
 * DISTINCT contributor keys, and returns a new array — a caller cannot end up
 * holding a filtered view that still has the dropped rows behind it.
 *
 * Note what this does NOT do: redact, blur, round, or mark. A below-floor group
 * leaves with no row at all, because a row that says "suppressed at this venue"
 * is itself the disclosure that somebody scanned there.
 */
export function servableAggregates(
  rows: readonly RadarAggregateRow[],
  kFloor: number = DEFAULT_K_ANONYMITY_FLOOR,
): RadarAggregateRow[] {
  const k = clampKFloor(kFloor);
  return rows.filter((r) => r.contributor_count >= k);
}

// ── Serving ─────────────────────────────────────────────────────────────────

/** What a venue looks like to the network layer. No contributor data. */
export interface RadarVenueNetworkDto {
  venue_id: string;
  window: RadarWindowKey;
  brand: string | null;
  scan_count: number;
  contributor_count: number;
  avg_grade: number | null;
  buy_rate: number | null;
  grade_mix: { high: number; mid: number; low: number; ungraded: number };
  last_activity_at: string;
  /** Whole days since the last scan here — the freshness signal. */
  days_since_activity: number | null;
}

/**
 * Turn a stored aggregate into the served shape, or null when it does not clear
 * the floor.
 *
 * The floor is re-applied HERE, on top of the engine's filter and the column
 * CHECK, on purpose: a row could only be below the floor if it was written by
 * something other than this pipeline, and that is exactly the case where a
 * remembered guarantee fails. Returning null rather than a flagged DTO means a
 * caller that forgets to check gets nothing to render, not a payload it must be
 * trusted to hide.
 */
export function toVenueNetworkDto(
  row: RadarAggregateRow,
  kFloor: number = DEFAULT_K_ANONYMITY_FLOOR,
  now: Date = new Date(),
): RadarVenueNetworkDto | null {
  if (row.contributor_count < clampKFloor(kFloor)) return null;
  const lastMs = Date.parse(row.last_activity_at);
  const days = Number.isFinite(lastMs)
    ? Math.max(0, Math.floor((now.getTime() - lastMs) / MS_PER_DAY))
    : null;
  return {
    venue_id: row.venue_id,
    window: row.window_key,
    brand: row.brand_key === ALL_BRANDS_KEY ? null : row.brand_key,
    scan_count: row.scan_count,
    contributor_count: row.contributor_count,
    avg_grade: row.avg_grade,
    buy_rate: row.buy_rate,
    grade_mix: {
      high: row.high_count,
      mid: row.mid_count,
      low: row.low_count,
      ungraded: row.ungraded_count,
    },
    last_activity_at: row.last_activity_at,
    days_since_activity: days,
  };
}

// ── Retention ───────────────────────────────────────────────────────────────

export const DEFAULT_RAW_EVENT_RETENTION_DAYS = 180;
/**
 * However short retention is configured, never prune inside the widest window —
 * an aggregate whose raw events are already gone is a number nothing can
 * recompute or correct.
 */
export const MIN_RAW_EVENT_RETENTION_DAYS = MAX_RADAR_WINDOW_DAYS + 1;

export function clampRetentionDays(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw)
    ? Math.round(raw)
    : DEFAULT_RAW_EVENT_RETENTION_DAYS;
  return Math.max(MIN_RAW_EVENT_RETENTION_DAYS, n);
}

/**
 * The boundary raw events are pruned at: the START of the UTC month containing
 * (now - retentionDays). Everything strictly before it is expired.
 *
 * Snapping to a month boundary is what makes the rollup idempotent. The archive
 * is keyed by month, so a partial prune inside a month would leave the month's
 * total recomputable only from the survivors — an undercount that a re-run
 * would then persist. With whole expired months only, a re-run either sees the
 * same events (identical totals) or fewer (a smaller total the merge rule
 * refuses to accept over the larger one it already stored).
 */
export function retentionCutoff(
  now: Date,
  retentionDays: number = DEFAULT_RAW_EVENT_RETENTION_DAYS,
): Date {
  const days = clampRetentionDays(retentionDays);
  const edge = new Date(now.getTime() - days * MS_PER_DAY);
  return new Date(Date.UTC(edge.getUTCFullYear(), edge.getUTCMonth(), 1));
}

/** First day of the UTC month a timestamp falls in, as YYYY-MM-DD. */
export function monthStart(at: Date): string {
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

/**
 * One archived month of activity at one place. The place is a venue when the
 * event resolved to one, and the coarse cell otherwise — so pruning is never
 * the moment the record of unresolved activity disappears.
 */
export interface RadarHistoryRow {
  venue_id: string | null;
  geohash: string | null;
  month_start: string;
  scan_count: number;
  contributor_count: number;
  avg_grade: number | null;
  buy_count: number;
  verdict_count: number;
  last_activity_at: string;
}

/**
 * Roll expired events into per-place, per-month archive rows.
 *
 * Only events strictly before `cutoff` are rolled up — the caller deletes
 * exactly the ids it passed in and got a row for, so an event can never be
 * deleted without having been archived first.
 *
 * `contributor_count` here counts distinct contributor KEYS, which rotate
 * (default every 7 days). Across a month that over-counts people, and it is
 * named for what it is rather than pretending otherwise: the archive is a
 * volume record, not a headcount, and nothing serves it.
 */
export function rollupExpiredEvents(
  events: readonly RadarScanEvent[],
  cutoff: Date,
): RadarHistoryRow[] {
  const cutoffMs = cutoff.getTime();
  const buckets = new Map<
    string,
    { venue_id: string | null; geohash: string | null; month: string; bucket: Bucket }
  >();

  for (const event of events) {
    const atMs = Date.parse(event.scanned_at);
    if (!Number.isFinite(atMs) || atMs >= cutoffMs) continue;
    if (!event.venue_id && !event.geohash) continue;

    const month = monthStart(new Date(atMs));
    const place = event.venue_id ?? `cell:${event.geohash}`;
    const key = `${place}|${month}`;
    let entry = buckets.get(key);
    if (!entry) {
      entry = {
        venue_id: event.venue_id ?? null,
        geohash: event.venue_id ? null : event.geohash,
        month,
        bucket: emptyBucket(),
      };
      buckets.set(key, entry);
    }
    addToBucket(entry.bucket, event, atMs);
  }

  const rows: RadarHistoryRow[] = [];
  for (const { venue_id, geohash, month, bucket } of buckets.values()) {
    rows.push({
      venue_id,
      geohash,
      month_start: month,
      scan_count: bucket.scans,
      contributor_count: bucket.contributors.size,
      avg_grade: averageGrade(bucket.bands),
      buy_count: bucket.buys,
      verdict_count: bucket.verdicts,
      last_activity_at: new Date(bucket.lastActivityMs).toISOString(),
    });
  }
  rows.sort((a, b) => {
    const ka = `${a.venue_id ?? a.geohash}|${a.month_start}`;
    const kb = `${b.venue_id ?? b.geohash}|${b.month_start}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return rows;
}

/** The key an archive row is unique on — venue if resolved, else the cell. */
export function historyPlaceKey(row: RadarHistoryRow): string {
  return row.venue_id ?? `cell:${row.geohash}`;
}

/**
 * Decide what an archive month should hold when a row for it already exists.
 *
 * The more complete computation wins, wholesale. A re-run after a partial
 * delete recomputes the month from the surviving events and therefore counts
 * FEWER scans; taking the larger row keeps the archive monotone rather than
 * letting a retry erode it. Replacing wholesale (rather than field-by-field
 * maxima) keeps the row internally coherent — an avg_grade from one run beside
 * a scan_count from another describes no month that ever happened.
 */
export function mergeHistoryRow(
  existing: RadarHistoryRow | undefined,
  incoming: RadarHistoryRow,
): RadarHistoryRow {
  if (!existing) return incoming;
  return incoming.scan_count >= existing.scan_count ? incoming : existing;
}
