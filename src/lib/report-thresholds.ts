// US-2098: when a public data report may present itself as a citable finding.
//
// /state-of-durability renders a "GradeThread, The State of Secondhand
// Durability... CC BY 4.0" citation block over a dataset that is currently
// EMPTY (brands 0, sufficient_cohorts 0, regrades 0, most_durable []), and
// /transparency renders an MAE of "0.00" derived from 17 reviews — which reads
// as fabricated-perfect rather than low-sample.
//
// This is the one class of SEO/GEO defect that can actively damage credibility
// rather than merely underperform: inviting citation of a finding we do not
// have is worse than having no report page at all, and an answer engine that
// ingests "MAE 0.00" will repeat it.
//
// The condition index already gets this right — it suppresses any curve below
// MIN_INDEX_TOTAL_SAMPLE (8) and never fabricates. This module extends that
// same discipline to the report pages, and exists so the thresholds live in ONE
// place rather than as scattered magic numbers (AC4).

/**
 * Minimum expert reviews before /transparency may publish a DERIVED quality
 * statistic (agreement rate, MAE, misread rate).
 *
 * 30 is the conventional small-sample floor — below it a single review moves
 * the headline figure by several percent, so the number would be noise
 * presented with the authority of a measurement. This is a PUBLICATION policy
 * choice, not a claim about the data: the metrics are still computed and still
 * visible internally, they simply are not offered to the public or to answer
 * engines as findings.
 */
export const MIN_QUALITY_REVIEWS = 30;

/**
 * Minimum brand cohorts with sufficient data before /state-of-durability may
 * present itself as a citable report.
 *
 * Mirrors the MIN_INDEX_TOTAL_SAMPLE = 8 precedent the condition index already
 * uses (AC4 asks for exactly that parity), for the same reason: a "ranking"
 * over fewer than 8 cohorts is a list, not a finding.
 */
export const MIN_DURABILITY_COHORTS = 8;

/** Shown wherever a statistic is withheld for insufficient sample. */
export const PENDING_LABEL = "Not enough data yet";

/**
 * True when a sample is large enough to publish a derived statistic from.
 *
 * Null/undefined counts as INSUFFICIENT rather than throwing: an absent count
 * means we do not know the sample size, and publishing a statistic whose
 * support is unknown is the exact failure this guards.
 */
export function hasSufficientSample(n: number | null | undefined, min: number): boolean {
  return typeof n === "number" && Number.isFinite(n) && n >= min;
}

/**
 * Whether a report page may present a citation block and be indexed.
 *
 * Deliberately one function for both decisions. They must not diverge: a page
 * that noindexes itself but still shows "cite this report" still invites
 * citation from anyone who reaches it by link, and a page that drops the
 * citation block but stays indexed still advertises an empty report to
 * crawlers.
 */
export function isPublishableReport(
  sampleSize: number | null | undefined,
  min: number,
): boolean {
  return hasSufficientSample(sampleSize, min);
}
