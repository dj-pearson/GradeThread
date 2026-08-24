// US-2848: run the measured answer beside the live one, and show nobody.
//
// valueAtGrade returns a range built from conditionId-filtered comps. US-2841
// says a range built from a price-vs-grade slope fitted on MEASURED condition
// beats it. The two run side by side on real traffic and the gap is recorded.
//
// US-2849 added the flip. CONDITION_VALUE_MEASURED decides which of the two
// ranges the caller gets, and it DEFAULTS OFF: with the flag unset this file
// still only watches, which is what makes "turn it off and nothing changed" a
// property rather than a hope. The two switches are separate on purpose:
//   CONDITION_VALUE_SHADOW=false   stops the RECORDING.
//   CONDITION_VALUE_MEASURED=true  starts SERVING the measured range.
// The flip implies the lookup, so turning the recording off never silently
// disarms a flip that is on.
//
// THREE REFUSALS, all of them the reason this file is separate from the flip.
//
// 1. NO SECOND EBAY CALL. The live range already cost one Browse request. The
//    measured range is read out of condition_price_curves, which the worker
//    already wrote. A shadow that doubled the network cost of every appraisal
//    would be paid for by the seller waiting on it.
//
// 2. NO EXTRAPOLATION, same rule as condition-curve-measured.ts. A grade
//    outside the observed span comes back insufficient rather than as a number
//    a straight line was happy to produce.
//
// 3. NEVER THROWS INTO THE CALLER. Every path here is wrapped and counted. The
//    shadow exists to inform a decision; a decision-support feature that can
//    500 a grading request has its priorities backwards.
//
// The write is bounded by the thing it measures: nothing is recorded for a cell
// with no measured curve, so while zero cells are measured this costs one
// cached, indexed lookup and no writes at all.

import type { CurvePoint } from "./condition-curve.ts";
import { type ItemIdentity, normalizeItemKey } from "./condition-item-key.ts";
import { type ValueRange } from "./condition-value-math.ts";
import { describeValueBasis } from "./value-disclosure.ts";
import { logEvent, recordMetric } from "./observability.ts";

export const SHADOW_SAMPLES_TABLE = "condition_value_shadow_samples";

/** Kill switch for the RECORDING. On unless an operator sets this to "false". */
export function shadowEnabled(
  read: (k: string) => string | undefined = (k) => Deno.env.get(k),
): boolean {
  return (read("CONDITION_VALUE_SHADOW") ?? "").toLowerCase() !== "false";
}

/**
 * The flip (US-2849). OFF unless an operator explicitly turns it on.
 *
 * DEFAULT-OFF IS THE POINT. A flip that defaults on is not a flip, it is a
 * release, and "the flag off restores current behaviour exactly" stops being
 * checkable the moment the default does anything.
 */
export function measuredFlipEnabled(
  read: (k: string) => string | undefined = (k) => Deno.env.get(k),
): boolean {
  const v = (read("CONDITION_VALUE_MEASURED") ?? "").toLowerCase();
  return v === "true" || v === "1" || v === "on";
}

/** Which range a request was answered with. */
export type ServedRange = "live" | "measured";

/**
 * May this measured range be served?
 *
 * A row only carries provenance = 'measured' if publishable() let it through
 * (US-2846), so the publish gate is already spent by the time the row exists
 * and is not re-litigated here. What IS re-checked is the grade: a measured
 * curve that declined to answer at THIS grade must not be served as though it
 * had, so an insufficient range falls back to live even with the flag on.
 */
export function shouldServeMeasured(
  measured: ValueRange | null,
  flipOn: boolean,
): boolean {
  return flipOn && measured != null && measured.sufficient &&
    measured.medianCents != null;
}

// ── The measured range, purely ──────────────────────────────────────

/** What the curve row carries, in this module's terms. */
export interface MeasuredCurve {
  itemKey: string;
  currency: string;
  points: CurvePoint[];
  fitConfidence: number | null;
  slopeCentsPerPoint: number | null;
  measuredAt: string | null;
}

function interpolate(lo: number, hi: number, t: number): number {
  return Math.round(lo + (hi - lo) * t);
}

/**
 * The measured range at a grade, read off the published curve points.
 *
 * Read off the POINTS rather than recomputed from the stored slope, on purpose:
 * the points are what /condition-index renders, so the shadow compares the
 * number a seller would actually have seen, not a second derivation of it that
 * could drift from the page by a rounding rule.
 *
 * Between two published grades the three fields are interpolated linearly,
 * which is exact for a line and honest for the band, because the band is a
 * constant hold-out error either side of it.
 *
 * SAMPLE SIZE TAKES THE SMALLER of the two bracketing points. It understates.
 * That is the correct direction of error for a number whose whole job is to
 * tell a reader how much to trust the range printed next to it.
 */
export function measuredRangeAtGrade(
  curve: MeasuredCurve,
  gradeValue: number | null,
): ValueRange {
  const currency = curve.currency || "USD";
  const insufficient: ValueRange = {
    lowCents: null,
    medianCents: null,
    highCents: null,
    sampleSize: 0,
    confidence: 0,
    sufficient: false,
    currency,
    // No basis: an insufficient measured range is never served, so it must not
    // carry wording a surface could render. The caller falls back to live, and
    // live brings its own comp-median basis with it.
  };
  if (gradeValue == null || !Number.isFinite(gradeValue)) return insufficient;

  const usable = (curve.points ?? [])
    .filter((p) =>
      p && p.sufficient && p.medianCents != null && Number.isFinite(p.grade)
    )
    .sort((a, b) => a.grade - b.grade);
  if (usable.length === 0) return insufficient;

  // Refusal 2: outside the observed span there is nothing measured to report.
  if (gradeValue < usable[0].grade || gradeValue > usable[usable.length - 1].grade) {
    return insufficient;
  }

  const confidence = Math.max(0, Math.min(0.95, curve.fitConfidence ?? 0));

  const basisFor = (median: number | null, sampleSize: number) =>
    describeValueBasis({
      source: "measured_curve",
      sufficient: true,
      sampleSize,
      medianCents: median,
      slopeCentsPerPoint: curve.slopeCentsPerPoint,
      measuredAt: curve.measuredAt,
      currency,
    });

  const exact = usable.find((p) => p.grade === gradeValue);
  if (exact) {
    return {
      lowCents: exact.lowCents ?? exact.medianCents,
      medianCents: exact.medianCents,
      highCents: exact.highCents ?? exact.medianCents,
      sampleSize: exact.sampleSize,
      confidence,
      sufficient: true,
      currency,
      basis: basisFor(exact.medianCents, exact.sampleSize),
    };
  }

  let lo = usable[0];
  let hi = usable[usable.length - 1];
  for (let i = 0; i < usable.length - 1; i++) {
    if (usable[i].grade <= gradeValue && gradeValue <= usable[i + 1].grade) {
      lo = usable[i];
      hi = usable[i + 1];
      break;
    }
  }
  const span = hi.grade - lo.grade;
  const t = span <= 0 ? 0 : (gradeValue - lo.grade) / span;
  const median = interpolate(lo.medianCents as number, hi.medianCents as number, t);
  const low = interpolate(
    lo.lowCents ?? (lo.medianCents as number),
    hi.lowCents ?? (hi.medianCents as number),
    t,
  );
  const high = interpolate(
    lo.highCents ?? (lo.medianCents as number),
    hi.highCents ?? (hi.medianCents as number),
    t,
  );
  const sampleSize = Math.min(lo.sampleSize, hi.sampleSize);
  return {
    lowCents: Math.min(low, median),
    medianCents: median,
    highCents: Math.max(high, median),
    sampleSize,
    confidence,
    sufficient: true,
    currency,
    basis: basisFor(median, sampleSize),
  };
}

// ── The observation ─────────────────────────────────────────────────

export interface ShadowObservation {
  cellKey: string;
  grade: number | null;
  liveMedianCents: number | null;
  measuredMedianCents: number | null;
  /** measured minus live, in cents. Null unless both sides produced a number. */
  deltaCents: number | null;
  liveSampleSize: number;
  measuredSampleSize: number;
  liveSufficient: boolean;
  measuredSufficient: boolean;
  currency: string;
}

/** The row the sample table takes. Exported so the writer and the tests agree. */
export interface ShadowSampleRow {
  cell_key: string;
  grade: number | null;
  live_median_cents: number | null;
  measured_median_cents: number | null;
  delta_cents: number | null;
  live_sample_size: number;
  measured_sample_size: number;
  live_sufficient: boolean;
  measured_sufficient: boolean;
  currency: string;
}

/** Pure: pair the two ranges into one observation. */
export function buildObservation(
  cellKey: string,
  gradeValue: number | null,
  live: ValueRange,
  measured: ValueRange,
): ShadowObservation {
  const l = live.sufficient ? live.medianCents : null;
  const m = measured.sufficient ? measured.medianCents : null;
  return {
    cellKey,
    grade: gradeValue,
    liveMedianCents: l,
    measuredMedianCents: m,
    deltaCents: l != null && m != null ? m - l : null,
    liveSampleSize: live.sampleSize,
    measuredSampleSize: measured.sampleSize,
    liveSufficient: live.sufficient,
    measuredSufficient: measured.sufficient,
    currency: measured.currency || live.currency || "USD",
  };
}

/** Pure: the observation as the table wants it. */
export function toShadowSampleRow(o: ShadowObservation): ShadowSampleRow {
  return {
    cell_key: o.cellKey,
    grade: o.grade,
    live_median_cents: o.liveMedianCents,
    measured_median_cents: o.measuredMedianCents,
    delta_cents: o.deltaCents,
    live_sample_size: o.liveSampleSize,
    measured_sample_size: o.measuredSampleSize,
    live_sufficient: o.liveSufficient,
    measured_sufficient: o.measuredSufficient,
    currency: o.currency,
  };
}

// ── Counters ────────────────────────────────────────────────────────
//
// Refusal 3 needs somewhere for a swallowed error to land, or "swallowed"
// becomes "silent". These are process-local and cheap; the durable record is
// the sample table and the metric lines.

export interface ShadowCounters {
  /** Cells asked about that had no measured curve. The normal case today. */
  missing: number;
  /** Cells where both ranges were produced and compared. */
  observed: number;
  /** Anything that threw or errored inside the shadow branch. */
  failed: number;
  /** US-2849: requests actually answered with the measured range. */
  servedMeasured: number;
}

const counters: ShadowCounters = { missing: 0, observed: 0, failed: 0, servedMeasured: 0 };

export function shadowCounters(): ShadowCounters {
  return { ...counters };
}

export function resetShadowCounters(): void {
  counters.missing = 0;
  counters.observed = 0;
  counters.failed = 0;
  counters.servedMeasured = 0;
}

// ── The lookup, with a small TTL cache ───────────────────────────────

/** The slice of supabase-js this module uses, injected so it is testable. */
export interface ShadowCurveClient {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        eq(column: string, value: string): {
          maybeSingle(): Promise<{
            data: Record<string, unknown> | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
  };
}

/** Insert-only slice for the sample write. */
export interface ShadowWriteClient {
  from(table: string): {
    insert(row: ShadowSampleRow): Promise<{ error: { message: string } | null }>;
  };
}

/**
 * How long a curve lookup is reused.
 *
 * Five minutes. A measured curve is refreshed by a batch worker on the order of
 * days, so this is short by comparison and long enough that a burst of
 * appraisals against one cell pays for one read, not forty.
 */
export const CURVE_CACHE_TTL_MS = 5 * 60_000;
const CURVE_CACHE_MAX = 500;

interface CacheEntry {
  value: MeasuredCurve | null;
  expires: number;
}
const curveCache = new Map<string, CacheEntry>();

export function resetShadowCurveCache(): void {
  curveCache.clear();
}

function cacheGet(key: string, now: number): CacheEntry | undefined {
  const hit = curveCache.get(key);
  if (!hit) return undefined;
  if (hit.expires <= now) {
    curveCache.delete(key);
    return undefined;
  }
  return hit;
}

function cacheSet(key: string, value: MeasuredCurve | null, now: number): void {
  if (curveCache.size >= CURVE_CACHE_MAX) {
    // Cheapest bounded eviction there is: drop the oldest insertion. Map
    // preserves insertion order, so the first key is it.
    const oldest = curveCache.keys().next();
    if (!oldest.done) curveCache.delete(oldest.value);
  }
  curveCache.set(key, { value, expires: now + CURVE_CACHE_TTL_MS });
}

const CURVE_COLS =
  "item_key, currency, curve, fit_confidence, slope_cents_per_point, measured_at";

function rowToCurve(row: Record<string, unknown>): MeasuredCurve {
  const num = (v: unknown): number | null =>
    typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : null;
  return {
    itemKey: String(row.item_key ?? ""),
    currency: typeof row.currency === "string" ? row.currency : "USD",
    points: Array.isArray(row.curve) ? (row.curve as CurvePoint[]) : [],
    fitConfidence: num(row.fit_confidence),
    slopeCentsPerPoint: num(row.slope_cents_per_point),
    measuredAt: typeof row.measured_at === "string" ? row.measured_at : null,
  };
}

/**
 * Read the measured curve for a cell, or null when there isn't one.
 *
 * Filters on provenance = 'measured' in the query rather than after it: a
 * seeded row is not a thin measured row, it is a different kind of claim, and
 * comparing the live range against a seeded curve would compare two generated
 * numbers and call the agreement evidence.
 */
export async function readMeasuredCurve(
  client: ShadowCurveClient,
  itemKey: string,
  now: number = Date.now(),
): Promise<MeasuredCurve | null> {
  const hit = cacheGet(itemKey, now);
  if (hit) return hit.value;

  const { data, error } = await client
    .from("condition_price_curves")
    .select(CURVE_COLS)
    .eq("item_key", itemKey)
    .eq("provenance", "measured")
    .maybeSingle();

  if (error) {
    // Not cached: a read failure is a transient condition, and caching it would
    // turn one bad five seconds into five bad minutes.
    throw new Error(error.message);
  }
  const curve = data ? rowToCurve(data) : null;
  cacheSet(itemKey, curve, now);
  return curve;
}

// ── The orchestrator ────────────────────────────────────────────────

export interface ShadowDeps {
  read: ShadowCurveClient;
  write: ShadowWriteClient;
  /** Injected so a test can prove the caller survives a throw in here. */
  now?: () => number;
  /** Do the lookup at all. False short-circuits to the live range. */
  enabled?: boolean;
  /** Write the sample row and the log line. Default true. */
  record?: boolean;
  /** US-2849: serve the measured range when it is servable. Default false. */
  flip?: boolean;
}

/** What the caller gets back: the range to serve, and which one it is. */
export interface ShadowOutcome {
  range: ValueRange;
  served: ServedRange;
  /** The measured range when there was one, servable or not. Null otherwise. */
  measured: ValueRange | null;
}

/**
 * Compare the measured range against the live one, record the gap, and decide
 * which of the two the caller serves.
 *
 * ONE FUNCTION DECIDES AND LOGS. Splitting the decision from the log line would
 * let the two drift, and a log that says "served: measured" on a request that
 * shipped the live number is worse than no log at all.
 *
 * Falls back to the live range for every unhappy outcome: no curve, disabled,
 * flag off, a grade the curve declined, or anything at all going wrong.
 */
export async function observeMeasuredShadow(
  deps: ShadowDeps,
  item: ItemIdentity,
  gradeValue: number | null,
  live: ValueRange,
): Promise<ShadowOutcome> {
  const liveOnly: ShadowOutcome = { range: live, served: "live", measured: null };
  if (deps.enabled === false) return liveOnly;
  const now = deps.now ?? Date.now;
  const record = deps.record !== false;
  const cellKey = normalizeItemKey(item);
  try {
    const curve = await readMeasuredCurve(deps.read, cellKey, now());
    if (!curve) {
      counters.missing++;
      return liveOnly;
    }

    const measured = measuredRangeAtGrade(curve, gradeValue);
    const observation = buildObservation(cellKey, gradeValue, live, measured);
    counters.observed++;

    const serveMeasured = shouldServeMeasured(measured, deps.flip === true);
    const outcome: ShadowOutcome = {
      range: serveMeasured ? measured : live,
      served: serveMeasured ? "measured" : "live",
      measured,
    };
    if (serveMeasured) counters.servedMeasured++;

    if (!record) return outcome;

    logEvent("info", "condition-value.shadow", {
      served: outcome.served,
      cell_key: observation.cellKey,
      grade: observation.grade,
      live_median_cents: observation.liveMedianCents,
      live_sample_size: observation.liveSampleSize,
      live_sufficient: observation.liveSufficient,
      measured_median_cents: observation.measuredMedianCents,
      measured_sample_size: observation.measuredSampleSize,
      measured_sufficient: observation.measuredSufficient,
      delta_cents: observation.deltaCents,
      slope_cents_per_point: curve.slopeCentsPerPoint,
      fit_confidence: curve.fitConfidence,
      measured_at: curve.measuredAt,
    });
    if (observation.deltaCents != null) {
      recordMetric("condition_value.shadow_abs_delta_cents", Math.abs(observation.deltaCents), {
        cell_key: observation.cellKey,
        served: outcome.served,
      });
    }

    const { error } = await deps.write
      .from(SHADOW_SAMPLES_TABLE)
      .insert(toShadowSampleRow(observation));
    if (error) {
      counters.failed++;
      logEvent("warn", "condition-value.shadow_write_failed", {
        cell_key: cellKey,
        error: error.message,
      });
    }
    return outcome;
  } catch (err) {
    counters.failed++;
    logEvent("warn", "condition-value.shadow_failed", {
      cell_key: cellKey,
      error: err instanceof Error ? err.message : String(err),
    });
    // A failure here CANNOT change the price. Falling back to live is the whole
    // safety property of the flip: the worst case for a seller stays today's
    // answer even when the measured path breaks mid-flip.
    return liveOnly;
  }
}

// ── The report ──────────────────────────────────────────────────────

export interface ShadowDeltaSampleRow {
  cell_key: string;
  grade: number | null;
  live_median_cents: number | null;
  measured_median_cents: number | null;
  delta_cents: number | null;
  created_at: string;
}

export interface ShadowCellSummary {
  cellKey: string;
  /** Rows recorded for this cell in the window, compared or not. */
  samples: number;
  /** Rows where both sides produced a number. The denominator of the medians. */
  compared: number;
  medianAbsDeltaCents: number | null;
  medianSignedDeltaCents: number | null;
  /** Median of |delta| / live median. Null when no comparable row had a live median. */
  medianAbsDeltaPct: number | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length / 2;
  if (s.length % 2 === 1) return s[Math.floor(mid)];
  return (s[mid - 1] + s[mid]) / 2;
}

/**
 * Median absolute delta by cell. Pure, so the number in the admin response is
 * the number the test asserts.
 *
 * A row with no delta still counts toward `samples` and never toward the
 * medians. Reporting only comparable rows would hide the cells where the
 * measured curve keeps declining to answer, which is the failure mode most
 * worth seeing before a flip.
 */
export function summarizeShadowDeltas(
  rows: ShadowDeltaSampleRow[],
): ShadowCellSummary[] {
  const byCell = new Map<string, ShadowDeltaSampleRow[]>();
  for (const r of rows) {
    const list = byCell.get(r.cell_key) ?? [];
    list.push(r);
    byCell.set(r.cell_key, list);
  }
  const out: ShadowCellSummary[] = [];
  for (const [cellKey, list] of byCell) {
    const compared = list.filter((r) => r.delta_cents != null);
    const abs = compared.map((r) => Math.abs(r.delta_cents as number));
    const signed = compared.map((r) => r.delta_cents as number);
    const pct = compared
      .filter((r) => r.live_median_cents != null && (r.live_median_cents as number) > 0)
      .map((r) =>
        Math.abs(r.delta_cents as number) / (r.live_median_cents as number)
      );
    const stamps = list.map((r) => r.created_at).filter((s) => !!s).sort();
    const medAbs = median(abs);
    const medSigned = median(signed);
    const medPct = median(pct);
    out.push({
      cellKey,
      samples: list.length,
      compared: compared.length,
      medianAbsDeltaCents: medAbs == null ? null : Math.round(medAbs),
      medianSignedDeltaCents: medSigned == null ? null : Math.round(medSigned),
      medianAbsDeltaPct: medPct == null ? null : Math.round(medPct * 10000) / 10000,
      firstSeenAt: stamps[0] ?? null,
      lastSeenAt: stamps[stamps.length - 1] ?? null,
    });
  }
  // Widest gap first: the cells where the two answers disagree most are the
  // ones a flip decision turns on.
  out.sort((a, b) => (b.medianAbsDeltaCents ?? -1) - (a.medianAbsDeltaCents ?? -1));
  return out;
}
