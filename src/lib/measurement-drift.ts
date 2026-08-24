// US-2827: is your medium the same medium everybody else is selling?
//
// measurement_drift (migration 00658) compares the caller's median measurement
// for a (garment category, size, key) against the cohort's, behind the same
// k-anonymity floor as every other cross-seller figure, and reports what the
// drift costs in returns.
//
// The reading rule: a suppressed cohort has NO median, and the drift for that
// row is null. Treating a missing cohort median as "no drift" would report a
// clean bill of health for exactly the buckets nobody can check.

import { supabase } from "@/lib/supabase";
import { MEASUREMENT_SPECS } from "@/lib/measurements";
import { normaliseAgainst } from "@/lib/rpc-shape";

export interface DriftRow {
  garmentCategory: string;
  size: string;
  key: string;
  ownCount: number;
  ownMedian: number | null;
  cohortCount: number;
  cohortSellers: number;
  cohortSuppressed: boolean;
  cohortMedian: number | null;
  cohortP25: number | null;
  cohortP75: number | null;
  /** own minus cohort, in inches. Positive = you measure larger. */
  driftInches: number | null;
}

export interface DriftReturns {
  offCount: number;
  offReturns: number;
  offRate: number | null;
  withinCount: number;
  withinReturns: number;
  withinRate: number | null;
}

/**
 * A cohort band for one (category, size, key), independent of whether the
 * caller has ever measured that bucket. Returned only when a size is asked for.
 */
export interface CohortBand {
  garmentCategory: string;
  size: string;
  key: string;
  cohortCount: number;
  cohortSellers: number;
  cohortSuppressed: boolean;
  cohortMedian: number | null;
  cohortP25: number | null;
  cohortP75: number | null;
}

export interface MeasurementDrift {
  garmentCategory: string | null;
  minSellers: number;
  minMeasure: number;
  minReturn: number;
  driftInches: number;
  rows: DriftRow[];
  /** Cohort-only bands for the requested size. Empty when no size was asked. */
  bands: CohortBand[];
  returns: DriftReturns;
}

export const EMPTY_DRIFT: MeasurementDrift = {
  garmentCategory: null,
  minSellers: 5,
  minMeasure: 3,
  minReturn: 10,
  driftInches: 1,
  rows: [],
  bands: [],
  returns: {
    offCount: 0,
    offReturns: 0,
    offRate: null,
    withinCount: 0,
    withinReturns: 0,
    withinRate: null,
  },
};

/**
 * Human label for a measurement key, from the shared vocabulary rather than a
 * second list. An unknown key falls back to itself made readable, which is what
 * happens when 00658's key list and MEASUREMENT_SPECS drift apart.
 */
export function measurementLabel(key: string): string {
  const spec = MEASUREMENT_SPECS[key];
  if (spec) return spec.label;
  const words = key.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Rows with a real, quotable drift, biggest absolute first. */
export function quotableDrift(report: MeasurementDrift): DriftRow[] {
  return report.rows
    .filter((r) => r.driftInches != null && Number.isFinite(r.driftInches))
    .sort((a, b) => Math.abs(b.driftInches!) - Math.abs(a.driftInches!));
}

/** Rows drifting past the threshold, which are the ones worth acting on. */
export function significantDrift(report: MeasurementDrift): DriftRow[] {
  return quotableDrift(report).filter(
    (r) => Math.abs(r.driftInches!) > report.driftInches,
  );
}

export interface DriftReturnFinding {
  offRate: number;
  withinRate: number;
  multiplier: number;
}

/**
 * What drifting costs, when both halves have enough fulfilled sales to say.
 * Null rather than a large number when the within-tolerance rate is zero.
 */
export function driftReturnFinding(
  report: MeasurementDrift,
): DriftReturnFinding | null {
  const { offRate, withinRate } = report.returns;
  if (offRate == null || withinRate == null) return null;
  if (withinRate <= 0) return null;
  if (offRate <= withinRate) return null;
  return { offRate, withinRate, multiplier: offRate / withinRate };
}

/**
 * Whether a just-entered value sits outside the cohort's middle half, which is
 * what the composer warns on. Null when there is no cohort band to check
 * against — an unknown is not a pass.
 */
export function isOutsideBand(
  value: number,
  row: Pick<DriftRow, "cohortP25" | "cohortP75" | "cohortSuppressed">,
): boolean | null {
  if (row.cohortSuppressed) return null;
  if (row.cohortP25 == null || row.cohortP75 == null) return null;
  if (!Number.isFinite(value)) return null;
  return value < row.cohortP25 || value > row.cohortP75;
}

/** The band for one measurement key, or null when there is nothing to check. */
export function bandFor(
  report: MeasurementDrift,
  key: string,
): CohortBand | null {
  return report.bands.find((b) => b.key === key) ?? null;
}

type RpcClient = {
  rpc: (
    fn: "measurement_drift",
    args: { p_garment_category: string | null; p_size: string | null },
  ) => Promise<{
    data: MeasurementDrift | null;
    error: { message: string } | null;
  }>;
};

/**
 * `size` populates the `bands` array with cohort-only figures for that size, so
 * the composer can check a value the caller has never measured before. Omit it
 * for the analytics panel, which reads `rows` instead.
 */
export async function fetchMeasurementDrift(
  garmentCategory: string | null,
  size: string | null = null,
): Promise<MeasurementDrift> {
  const client = supabase as unknown as RpcClient;
  const { data, error } = await client.rpc("measurement_drift", {
    p_garment_category: garmentCategory,
    p_size: size,
  });
  if (error) throw new Error(error.message);
  return normaliseDrift(data);
}

/**
 * Force any response into a whole `MeasurementDrift`.
 *
 * `RpcClient` above is reached through `supabase as unknown as RpcClient`, so
 * its `data: MeasurementDrift | null` is an ASSERTION, not a check. Nothing
 * verifies it at runtime, and `data ?? EMPTY_DRIFT` — what this used to do —
 * only catches null and undefined. Any other shape passes straight through
 * wearing the type.
 *
 * ⚠ AND IT CRASHED THE WHOLE COMPOSER, not just this card. The e2e suite mocks
 * every unmatched `/rest/v1/**` call with an empty ARRAY, which includes this
 * RPC. `[]` is not null, so it survived the `??`, and `report.bands.find(...)`
 * then threw "Cannot read properties of undefined (reading 'find')". That is a
 * render-phase throw, so the ErrorBoundary swallowed the entire
 * /items/:id/draft route and the seller saw "Something went wrong" instead of
 * their item. Three e2e scenarios, identically, because the payload has nothing
 * to do with the scenario.
 *
 * The mock is not the bug — it is doing its job by being adversarial. A partial
 * or unexpected payload has other live routes to arrive through: PostgREST
 * answering a shape this client never validated, or the stale-overload case in
 * [[postgres-revoke-from-anon-is-a-noop]] where an older `measurement_drift`
 * without `p_size` returns no `bands` at all. A measurement hint failing shut
 * is correct; a measurement hint taking down the item editor is not.
 *
 * So every array and the `returns` block are checked here, at the one boundary
 * they all enter through, rather than at each of the six readers below.
 */
export function normaliseDrift(raw: unknown): MeasurementDrift {
  // US-2838: this was hand-written here first, then the same pattern turned up
  // in seven sibling analytics libs. The logic now lives once in
  // `normaliseAgainst`, which derives the expected shape from the EMPTY_X
  // constant rather than from a per-lib list of field names. The named export
  // stays because its tests and the account above are what explain WHY.
  return normaliseAgainst(EMPTY_DRIFT, raw);
}
