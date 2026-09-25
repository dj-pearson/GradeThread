// US-3036: roll garment_measurements up into the numbers a page can print.
//
// The MATH is pure and unit-tested (aggregateCohort); the job
// (computeMeasurementAggregates) does the DB plumbing and upserts the deny-all
// garment_measurement_stats table (00709). Same split, and the same reasons, as
// durability-aggregate.ts.
//
// ── THE TWO FLOORS ARE NOT THE SAME KIND OF THING ──────────────────────────
//
// MIN_MEASUREMENT_SAMPLE is a quality floor: five garments is where the median
// of a flat measurement stops moving much when a sixth arrives.
//
// MIN_MEASUREMENT_CONTRIBUTORS is a PRIVACY floor, and it exists for a
// different reason entirely. A number backed by one seller's closet is a
// statement about that seller's inventory; a number backed by three is a fact
// about the garment. It is deliberately independent of the sample floor, so
// five garments from one seller does NOT publish, however good the measuring
// was. Raising one of these is not a substitute for the other.
//
// ── WHY FIVE, WHEN THE CONDITION INDEX USES EIGHT ──────────────────────────
//
// Price variance across a cohort is large, so a price claim needs more samples
// to be honest — MIN_INDEX_TOTAL_SAMPLE = 8 in condition-index.ts. Flat
// measurements of one style in one size vary by a fraction of an inch, so five
// real garments already give a stable median. Both numbers are DECISIONS, not
// measurements, written down here so the next person argues with the reasoning
// rather than with the number.
//
// ── INSUFFICIENT COHORTS ARE STILL WRITTEN ─────────────────────────────────
//
// With sufficient=false, following the durability precedent: the read path
// filters, the write path never hides. That is what keeps coverage MEASURABLE,
// which is exactly what the US-3037 gate has to answer before any public page
// is written. A job that silently skipped thin cohorts would make "we have no
// coverage" and "we have coverage we refuse to publish" look identical.

import { supabaseAdmin } from "./supabase.ts";

/** Garments needed behind a number before it can be published. */
export const MIN_MEASUREMENT_SAMPLE = 5;

/** Distinct contributors needed. A privacy floor, not a quality floor. */
export const MIN_MEASUREMENT_CONTRIBUTORS = 3;

/** The identity of one published number. */
export interface CohortKey {
  brand_key: string;
  style_key: string;
  department: string;
  measurement_group: string;
  size_label: string;
  field_key: string;
}

export interface CohortObservation {
  inches: number;
  user_id: string;
}

export interface CohortStats extends CohortKey {
  sample_count: number;
  contributor_count: number;
  p25: number | null;
  median: number | null;
  p75: number | null;
  sufficient: boolean;
}

/** Linear-interpolated quantile over a SORTED ascending array. */
export function quantileSorted(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/**
 * Drop values outside 1.5 IQR, returning the survivors in input order.
 *
 * Run BEFORE the median and quartiles, not after. With cohorts this small one
 * fat-fingered 220 would otherwise drag the quartiles far enough that the band
 * printed on the page is wrong even though the median looks fine.
 *
 * Below four values there is no meaningful quartile to compute a fence from, so
 * nothing is dropped — an outlier rule that fires on a cohort of two is just a
 * rule that deletes disagreement.
 */
export function outlierFence(
  values: readonly number[],
): { lo: number; hi: number } | null {
  if (values.length < 4) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = quantileSorted(sorted, 0.25);
  const q3 = quantileSorted(sorted, 0.75);
  const iqr = q3 - q1;
  if (iqr === 0) return null;
  return { lo: q1 - 1.5 * iqr, hi: q3 + 1.5 * iqr };
}

export function dropOutliers(values: readonly number[]): number[] {
  const fence = outlierFence(values);
  if (!fence) return [...values];
  return values.filter((v) => v >= fence.lo && v <= fence.hi);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The published shape of one cohort. Pure.
 *
 * `sample_count` and `contributor_count` are counted AFTER the outlier drop, so
 * they describe the garments the number actually came from. Reporting the
 * pre-drop count next to a post-drop median would be a small lie in the one
 * place the page asks the reader to trust it.
 */
export function aggregateCohort(
  key: CohortKey,
  observations: readonly CohortObservation[],
): CohortStats {
  const usable = observations.filter((o) => Number.isFinite(o.inches));
  const fence = outlierFence(usable.map((o) => o.inches));

  // Filter the OBSERVATIONS by the fence, not the values, so a survivor keeps
  // its contributor attached. Matching values back to contributors afterwards
  // happens to work today (equal values fall on the same side of a numeric
  // fence) and would break the moment the rule stopped being a plain range.
  const kept = fence
    ? usable.filter((o) => o.inches >= fence.lo && o.inches <= fence.hi)
    : usable;

  const contributors = new Set(kept.map((o) => o.user_id));

  const sample_count = kept.length;
  const contributor_count = contributors.size;
  const sufficient = sample_count >= MIN_MEASUREMENT_SAMPLE &&
    contributor_count >= MIN_MEASUREMENT_CONTRIBUTORS;

  if (sample_count === 0) {
    return {
      ...key,
      sample_count: 0,
      contributor_count: 0,
      p25: null,
      median: null,
      p75: null,
      sufficient: false,
    };
  }

  const sorted = kept.map((o) => o.inches).sort((a, b) => a - b);
  return {
    ...key,
    sample_count,
    contributor_count,
    p25: round2(quantileSorted(sorted, 0.25)),
    median: round2(quantileSorted(sorted, 0.5)),
    p75: round2(quantileSorted(sorted, 0.75)),
    sufficient,
  };
}

/**
 * The separator between key parts.
 *
 * A newline, because it is a character no key part can contain:
 * normalizeSizeLabel collapses every run of whitespace to a single space, and
 * the other five parts are words or identifiers.
 *
 * A SPACE would not do, and that is not hypothetical — ("550","Men") and
 * ("550 Men","") would join to the same string and silently merge two cohorts.
 * The collision test pins exactly that pair.
 *
 * Named rather than inlined so it can never again be written as a raw control
 * character: this line held a literal NUL byte until 2026-09-01, which made the
 * whole file read as binary to grep and to `file`, and which no review would
 * have caught because it renders as nothing at all.
 */
const KEY_SEPARATOR = "\n";

/** The join key as one string, for grouping. Field order is fixed. */
export function cohortKeyString(k: CohortKey): string {
  return [
    k.brand_key,
    k.style_key,
    k.department,
    k.measurement_group,
    k.size_label,
    k.field_key,
    // Separated by a newline, which is a character no key can contain:
    // normalizeSizeLabel collapses all whitespace to single spaces, and
    // every other part is a word or an identifier. A SPACE would not do:
    // ("550","Men") and ("550 Men","") would join to the same string and
    // silently merge two cohorts, which is what the collision test pins.
  ].join(KEY_SEPARATOR);
}

/** Group raw observation rows into cohorts and aggregate each. Pure. */
export function aggregateAll(
  rows: readonly (CohortKey & CohortObservation)[],
): CohortStats[] {
  const groups = new Map<string, { key: CohortKey; obs: CohortObservation[] }>();

  for (const row of rows) {
    const key: CohortKey = {
      brand_key: row.brand_key,
      style_key: row.style_key,
      department: row.department,
      measurement_group: row.measurement_group,
      size_label: row.size_label,
      field_key: row.field_key,
    };
    const id = cohortKeyString(key);
    const existing = groups.get(id);
    if (existing) existing.obs.push({ inches: row.inches, user_id: row.user_id });
    else groups.set(id, { key, obs: [{ inches: row.inches, user_id: row.user_id }] });
  }

  return [...groups.values()].map((g) => aggregateCohort(g.key, g.obs));
}

/**
 * Which currently-published cohorts no longer have any observation behind them.
 *
 * Pure, and split out from the job on purpose: the bug this replaced lived in
 * the plumbing, where an early return on an empty `stats` skipped retirement
 * entirely, so a cohort whose contributors had all opted out kept printing its
 * median. Making the DECISION pure means that case is a unit test rather than
 * something you only find by deleting rows against a live database.
 *
 * An EMPTY `stats` retires everything, which is the case that matters most: it
 * means every observation is gone.
 */
export function cohortsToRetire<T extends CohortKey>(
  stats: readonly CohortKey[],
  published: readonly T[],
): T[] {
  const live = new Set(stats.map((s) => cohortKeyString(s)));
  return published.filter((p) => !live.has(cohortKeyString(p)));
}

export interface AggregateSummary {
  cohorts: number;
  /** Sufficient cohorts among the chunks that were actually saved. */
  sufficient: number;
  upserted: number;
  /** Published cohorts whose last observation went away and were unpublished. */
  retired: number;
  /** Observation rows read. Every page, or the job threw. */
  rowsRead: number;
  /** Upsert or retire chunks that failed. Non-zero means the job route 500s. */
  failedChunks: number;
}

/** The slice of the Supabase client this job uses; injectable for tests. */
type AggregateDb = Pick<typeof supabaseAdmin, "from">;
// The PostgREST builder's generic type does not survive being passed through a
// filter callback; the calls below are the same ones the job made before.
// deno-lint-ignore no-explicit-any
type Query = any;

const PAGE = 1000;
const CHUNK = 500;

/**
 * Read every row of a table in id order, keyset-paged.
 *
 * MC-06: a failed page THROWS. It used to log and break, and the job then
 * saved stats from partial data and retired every cohort it had not reached,
 * which unpublished real numbers and still answered 200 ok. `.range()` offset
 * paging is also gone: keyset on id cannot skip or repeat a row when the table
 * changes mid-read.
 */
async function readAllById<T extends { id: string }>(
  db: AggregateDb,
  table: string,
  columns: string,
  filter?: (q: Query) => Query,
): Promise<T[]> {
  const out: T[] = [];
  let lastId: string | null = null;
  for (;;) {
    let q: Query = db.from(table).select(columns);
    if (filter) q = filter(q);
    if (lastId !== null) q = q.gt("id", lastId);
    const { data, error } = await q.order("id", { ascending: true }).limit(PAGE);
    if (error) {
      throw new Error(`[measurement-aggregate] read of ${table} failed: ${error.message}`);
    }
    const page = (data ?? []) as T[];
    out.push(...page);
    if (page.length < PAGE) break;
    lastId = page[page.length - 1]!.id;
  }
  return out;
}

/** Read every observation, aggregate, and upsert the stats table. */
export async function computeMeasurementAggregates(
  db: AggregateDb = supabaseAdmin,
): Promise<AggregateSummary> {
  // Throws on a failed page, before anything is written or retired.
  const rows = await readAllById<CohortKey & CohortObservation & { id: string }>(
    db,
    "garment_measurements",
    "id, brand_key, style_key, department, measurement_group, size_label, field_key, inches, user_id",
  );

  const stats = aggregateAll(rows);

  // NO EARLY RETURN ON AN EMPTY RESULT, and that is the whole point of this
  // comment. There used to be one, and it was a real bug caught by deleting
  // every observation against a live database: with nothing to aggregate the
  // function returned before the retirement pass below, so a cohort whose
  // contributors had ALL opted out kept its `sufficient=true` row and the page
  // kept printing a median backed by nothing at all. "Nothing to write" and
  // "nothing to retire" are different questions and only one of them was being
  // asked. An empty result is only trusted because the read above is COMPLETE:
  // a failed page throws rather than leaving `rows` short.

  let upserted = 0;
  let sufficient = 0;
  let failedChunks = 0;
  for (let i = 0; i < stats.length; i += CHUNK) {
    const slice = stats.slice(i, i + CHUNK);
    const chunk = slice.map((s) => ({
      ...s,
      updated_at: new Date().toISOString(),
    }));
    const { error } = await db
      .from("garment_measurement_stats")
      .upsert(chunk as never, {
        onConflict:
          "brand_key,style_key,department,measurement_group,size_label,field_key",
      });
    if (error) {
      console.error("[measurement-aggregate] upsert failed:", error.message);
      failedChunks++;
      continue;
    }
    upserted += chunk.length;
    sufficient += slice.filter((s) => s.sufficient).length;
  }

  // A cohort whose last observation was deleted (an opt-out, or a purge) leaves
  // a stale row behind that would keep printing a number nothing backs any
  // more. Retire those rather than deleting them: the row stays as evidence
  // that coverage existed and went away, and `sufficient=false` is exactly what
  // the read path already filters on.
  //
  // This runs unconditionally. An empty `stats` is the case that needs it MOST,
  // because it means every observation is gone. The published set is paged the
  // same way and a failed read throws: retiring against a PARTIAL published set
  // would only miss rows, but pretending it read them all would hide that.
  const existing = await readAllById<CohortKey & { id: string }>(
    db,
    "garment_measurement_stats",
    "id, brand_key, style_key, department, measurement_group, size_label, field_key",
    (q) => q.eq("sufficient", true),
  );
  const stale = cohortsToRetire(stats, existing);
  let retired = 0;
  for (let i = 0; i < stale.length; i += CHUNK) {
    const ids = stale.slice(i, i + CHUNK).map((r) => r.id);
    const { error } = await db
      .from("garment_measurement_stats")
      .update({
        sample_count: 0,
        contributor_count: 0,
        p25: null,
        median: null,
        p75: null,
        sufficient: false,
        updated_at: new Date().toISOString(),
      } as never)
      .in("id", ids);
    if (error) {
      console.error("[measurement-aggregate] retire failed:", error.message);
      failedChunks++;
      continue;
    }
    retired += ids.length;
  }

  return {
    cohorts: stats.length,
    sufficient,
    upserted,
    retired,
    rowsRead: rows.length,
    failedChunks,
  };
}
