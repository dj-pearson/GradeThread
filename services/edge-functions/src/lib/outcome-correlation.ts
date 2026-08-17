// US-2280: does a higher grade actually realize a higher price?
//
// Grading accuracy today is calibrated from buyer-guarantee CLAIMS only
// (lib/claim-accuracy.ts turns an approved claim into per-factor over-grade
// deltas). A claim is a rare, self-selected signal: it fires when a buyer is
// unhappy enough to act, which measures the tail and says nothing about the
// body. Realized sale price against the comp median is dense — we already record
// it on every FlipDesk sale — and it is the only signal that could let the public
// data reports say something true rather than something safe.
//
// THIS MODULE IS THE PURE HALF. Rows in, report out. No supabase, no env, no
// clock. The caller owns the query and therefore owns the tenant scoping.
//
// ⚠ PRIVACY BY CONSTRUCTION (AC4). `OutcomeRow` carries NO user id, NO item id,
// NO listing id and no free text. That is not an oversight to be filled in
// later — it is the same trick as ReadScope in SyncEngine (US-2337): the caller
// holding a seller's row has nothing valid to pass that would carry the seller
// into the aggregate, so a per-seller leak into an internal report is
// unrepresentable rather than merely guarded. If a future caller needs to slice
// by seller, that is a different type and a different review.
//
// ⚠ INTERNAL ONLY (AC3). This is calibration input. It is NOT the public data
// report (US-976/US-1691) and the two must not share a surface: a public number
// derived per-seller from a small sample is a disclosure risk dressed as a
// statistic.
//
// THE JOIN THIS EXPECTS (AC2), so the caller does not have to rediscover it:
//   grade_reports
//     -> submissions.id
//     -> flipdesk_grading_submissions.submission_id      (00008)
//     -> flipdesk_grading_submissions.inventory_item_id
//     -> inventory_items.id
//        -> sales.inventory_item_id                      (sale_price, sale_date)
//        -> repricing_suggestions.inventory_item_id      (comp_median_cents)
// repricing_suggestions carries a denormalized user_id, which is what the
// caller scopes on.
//
// ⚠ ONE CAVEAT ABOUT THE COMP, and it limits what this can claim.
// repricing_suggestions holds the CURRENT suggestion for a listing, not a
// snapshot taken when the grade was assigned. A row that was applied or
// dismissed, or rescanned after the sale, carries a comp from a different moment
// than the sale it is being compared against. So the ratio below is
// "sale price vs the comp we last computed", not "vs the comp at grade time".
// That is usable for a correlation across many items and is NOT usable to
// characterise any single sale — and if the correlation ever becomes load-
// bearing, snapshotting the comp at grade time is the fix.

/**
 * One graded item that later sold. Deliberately identifier-free — see the
 * privacy note above.
 */
export interface OutcomeRow {
  /** The grade that was assigned, 1.0–10.0. */
  grade: number;
  /** What it actually sold for. */
  salePriceCents: number;
  /** Comp median for the item, or null when no comp was ever computed. */
  compMedianCents: number | null;
  /** Garment category, for the per-category view. Never a free-text title. */
  category: string;
  returned: boolean;
  disputed: boolean;
}

/**
 * Below this many usable pairs, no coefficient is reported at all.
 *
 * Not a significance test — this module deliberately invents no p-value. It is
 * the point below which a correlation coefficient is noise wearing a number's
 * clothes, and reporting one anyway is how a chart ends up in a deck.
 */
export const MIN_CORRELATION_SAMPLE = 30;

export interface GradeBandStat {
  /** Whole grade point. The tier boundaries fall exactly here (9.x = NWOT, 10 = NWT), so this duplicates no table. */
  band: number;
  sales: number;
  /** Median of salePrice / compMedian for the rows in this band that had a comp. */
  medianRealization: number | null;
  withComp: number;
  returnRate: number;
  disputeRate: number;
}

export interface OutcomeCorrelationReport {
  /** Rows supplied. */
  rows: number;
  /** Rows with a usable comp — the only ones the coefficient can use. */
  usablePairs: number;
  /**
   * Spearman rank correlation between grade and price realization, or null when
   * there were fewer than MIN_CORRELATION_SAMPLE usable pairs.
   */
  spearman: number | null;
  /** Why spearman is null, when it is. Empty string when it is not. */
  insufficientReason: string;
  bands: GradeBandStat[];
  /** Plain-language summary. Never characterises a null coefficient. */
  summary: string;
}

/** Ranks with ties averaged. Grades tie heavily (0.1 steps over a 9-point range). */
export function rankAverage(values: readonly number[]): number[] {
  const idx = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++;
    // Ranks are 1-based; the shared rank is the average of the positions the
    // tied group occupies. Without this, ties take arbitrary distinct ranks and
    // the coefficient depends on sort order rather than on the data.
    const shared = (i + j + 2) / 2;
    for (let k = i; k <= j; k++) ranks[idx[k].i] = shared;
    i = j + 1;
  }
  return ranks;
}

/**
 * Spearman rank correlation. Pure.
 *
 * Rank-based rather than Pearson on purpose: the question is monotonic ("does a
 * better grade sell closer to or above comp"), grades are ordinal, and a single
 * item that sold for ten times its comp would drag a Pearson coefficient around
 * by itself.
 *
 * Returns null when either series has no variance — a run of identical grades
 * has no rank order to correlate, and 0 would read as "no relationship" when the
 * truth is "no question was asked".
 */
export function spearman(xs: readonly number[], ys: readonly number[]): number | null {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const rx = rankAverage(xs), ry = rankAverage(ys);
  const n = rx.length;
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / n;
  const mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = rx[i] - mx, b = ry[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return Number((num / Math.sqrt(dx * dy)).toFixed(4));
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const m = s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
  return Number(m.toFixed(4));
}

function rate(n: number, of: number): number {
  return of === 0 ? 0 : Number((n / of).toFixed(4));
}

/** A row can be used for the coefficient only if it has a comp worth dividing by. */
function usable(r: OutcomeRow): boolean {
  return (
    Number.isFinite(r.grade) &&
    Number.isFinite(r.salePriceCents) &&
    r.compMedianCents !== null &&
    Number.isFinite(r.compMedianCents) &&
    r.compMedianCents > 0
  );
}

/**
 * Build the report. Pure.
 *
 * Rows WITHOUT a comp are excluded from the coefficient and still counted in the
 * band table's return and dispute rates — those need no comp, and dropping the
 * rows entirely would make the return rate a statistic about items that happened
 * to have been repriced.
 */
export function correlateOutcomes(rows: readonly OutcomeRow[]): OutcomeCorrelationReport {
  const pairs = rows.filter(usable);
  const grades = pairs.map((r) => r.grade);
  const realization = pairs.map((r) => r.salePriceCents / (r.compMedianCents as number));

  const enough = pairs.length >= MIN_CORRELATION_SAMPLE;
  const rho = enough ? spearman(grades, realization) : null;
  const insufficientReason = enough
    ? (rho === null
      ? `no variance to correlate — ${pairs.length} pairs, but grade or realization is constant`
      : "")
    : `${pairs.length} usable pair(s), below the ${MIN_CORRELATION_SAMPLE} needed to report a coefficient`;

  // Bands are whole grade points. Tier boundaries fall exactly on them, so this
  // groups by tier without copying the tier table.
  const byBand = new Map<number, OutcomeRow[]>();
  for (const r of rows) {
    if (!Number.isFinite(r.grade)) continue;
    const band = Math.floor(r.grade);
    const list = byBand.get(band) ?? [];
    list.push(r);
    byBand.set(band, list);
  }
  const bands: GradeBandStat[] = [...byBand.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([band, list]) => {
      const withComp = list.filter(usable);
      return {
        band,
        sales: list.length,
        withComp: withComp.length,
        medianRealization: median(
          withComp.map((r) => r.salePriceCents / (r.compMedianCents as number)),
        ),
        returnRate: rate(list.filter((r) => r.returned).length, list.length),
        disputeRate: rate(list.filter((r) => r.disputed).length, list.length),
      };
    });

  // The summary never characterises a null coefficient. "No correlation found"
  // and "not enough data to look" are different sentences, and collapsing them
  // is how a thin sample becomes a conclusion.
  const summary = rho === null
    ? `No coefficient reported: ${insufficientReason}. ${rows.length} sale(s) across ${bands.length} grade band(s).`
    : `Spearman ${rho >= 0 ? "+" : ""}${rho} between grade and price realization over ` +
      `${pairs.length} sale(s) with comps, across ${bands.length} grade band(s).`;

  return {
    rows: rows.length,
    usablePairs: pairs.length,
    spearman: rho,
    insufficientReason,
    bands,
    summary,
  };
}
