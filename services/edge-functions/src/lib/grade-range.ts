// US-3339: a measured grade range, for example "7.6 (likely 7.3 to 7.9)".
//
// The same garment graded twice can land on different numbers (US-2035). The
// self-consistency job (jobs-grading-self-consistency.ts) measures by how much:
// it regrades recent submissions from their stored photos and records the
// spread between the regrades. This module keeps those spreads per garment
// category and turns them into a range.
//
// THE ONE RULE: a range comes from MEASURED regrade spreads and nothing else.
// It is never derived from confidence_score, which is the model's opinion of
// itself; a range built from that would look like a measurement and be a
// guess. Nothing in this file reads confidence, and a test holds it to that.
//
// The number: half_width is the 80th percentile of the measured max spread for
// the category, rounded UP to 0.1. So "likely 7.3 to 7.9" means: in 4 of 5
// measured regrades of this kind of garment, the two grades were no further
// apart than that.
//
// Shown only when the category has at least RANGE_MIN_SAMPLES measurements in
// the last RANGE_WINDOW_DAYS, and only when the spread is at least 0.1 (a
// category that regrades identically gets no range, because there is none).
//
// Persisted in system_settings under GRADE_RANGE_SETTING by the job, one list
// of { spread, at } per category, newest last, capped at RANGE_MAX_PER_CATEGORY.

export const GRADE_RANGE_SETTING = "grading_consistency_by_category";
export const RANGE_MIN_SAMPLES = 10;
export const RANGE_WINDOW_DAYS = 180;
export const RANGE_MAX_PER_CATEGORY = 200;
export const RANGE_PERCENTILE = 0.8;

export interface SpreadEntry {
  spread: number;
  at: string;
}

export interface ConsistencyRecord {
  version: 1;
  updated_at: string | null;
  categories: Record<string, SpreadEntry[]>;
}

export const EMPTY_CONSISTENCY_RECORD: ConsistencyRecord = {
  version: 1,
  updated_at: null,
  categories: {},
};

/** Pure: read whatever is stored, defensively. Anything unrecognized is empty. */
export function coerceRecord(raw: unknown): ConsistencyRecord {
  if (!raw || typeof raw !== "object") return { ...EMPTY_CONSISTENCY_RECORD, categories: {} };
  const r = raw as Record<string, unknown>;
  const cats = r.categories && typeof r.categories === "object"
    ? r.categories as Record<string, unknown>
    : {};
  const categories: Record<string, SpreadEntry[]> = {};
  for (const [cat, list] of Object.entries(cats)) {
    if (!Array.isArray(list)) continue;
    categories[cat] = list.flatMap((e) => {
      const x = e as Record<string, unknown>;
      const spread = Number(x?.spread);
      const at = typeof x?.at === "string" ? x.at : null;
      return Number.isFinite(spread) && spread >= 0 && at ? [{ spread, at }] : [];
    });
  }
  return {
    version: 1,
    updated_at: typeof r.updated_at === "string" ? r.updated_at : null,
    categories,
  };
}

/** Pure: add new measurements, newest last, keeping the newest `cap` per category. */
export function appendSpreads(
  record: ConsistencyRecord,
  items: ReadonlyArray<{ category: string | null | undefined; spread: number; at: string }>,
  cap = RANGE_MAX_PER_CATEGORY,
): ConsistencyRecord {
  const categories: Record<string, SpreadEntry[]> = {};
  for (const [k, v] of Object.entries(record.categories)) categories[k] = v.slice();
  let latest = record.updated_at;
  for (const it of items) {
    const cat = (it.category ?? "").trim().toLowerCase();
    if (!cat || !Number.isFinite(it.spread) || it.spread < 0) continue;
    (categories[cat] ??= []).push({ spread: Math.round(it.spread * 100) / 100, at: it.at });
    if (!latest || it.at > latest) latest = it.at;
  }
  for (const k of Object.keys(categories)) {
    if (categories[k].length > cap) categories[k] = categories[k].slice(-cap);
  }
  return { version: 1, updated_at: latest, categories };
}

/** Pure: nearest-rank percentile of a non-empty list. */
export function percentile(values: readonly number[], p: number): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1];
}

export interface CategoryRange {
  half_width: number;
  samples: number;
}

/** Pure: the measured range for one category, or null when there is none to show. */
export function rangeForCategory(
  record: ConsistencyRecord,
  category: string | null | undefined,
  now: Date = new Date(),
): CategoryRange | null {
  const cat = (category ?? "").trim().toLowerCase();
  const cutoff = now.getTime() - RANGE_WINDOW_DAYS * 86_400_000;
  const recent = (record.categories[cat] ?? []).filter((e) => Date.parse(e.at) >= cutoff);
  if (recent.length < RANGE_MIN_SAMPLES) return null;
  // Round UP to 0.1, working in tenths so float error cannot push 0.3 to 0.4.
  const p = percentile(recent.map((e) => e.spread), RANGE_PERCENTILE);
  const half = Math.ceil(Math.round(p * 1000) / 100) / 10;
  if (half < 0.1) return null;
  return { half_width: half, samples: recent.length };
}

/** Pure: every category that currently qualifies. */
export function publicRanges(
  record: ConsistencyRecord,
  now: Date = new Date(),
): Record<string, CategoryRange> {
  const out: Record<string, CategoryRange> = {};
  for (const cat of Object.keys(record.categories)) {
    const r = rangeForCategory(record, cat, now);
    if (r) out[cat] = r;
  }
  return out;
}
