// US-1897 (AC2): pure helpers for the drafts cockpit's quality-score column.
//
// Extracted so the two judgement calls below are testable without rendering the
// whole page (the repo's status-param-to-tab.ts pattern).

import type { QualityScoreSummary } from "@/components/flipdesk/quality-score-chip";

export interface QualityScoreRow {
  id: string;
  quality_score: number | null;
  quality_blocked: boolean | null;
}

/**
 * Build the listing-id → score map from the persisted columns.
 *
 * A NULL quality_score is OMITTED rather than coerced to 0. "Never scored" and
 * "scored zero" are different facts, and a 0 would both render a confident chip
 * and sort an unscored draft in with the genuinely worst listings.
 */
export function scoreMapFromRows(
  rows: readonly QualityScoreRow[] | null | undefined,
): Record<string, QualityScoreSummary> {
  const out: Record<string, QualityScoreSummary> = {};
  for (const r of rows ?? []) {
    if (!r || typeof r.quality_score !== "number") continue;
    out[r.id] = { score: r.quality_score, blocked: r.quality_blocked === true };
  }
  return out;
}

/**
 * Sort rank for "Quality: low first".
 *
 * Unscored drafts sink to the END. "We don't know" is not evidence of low
 * quality, and floating unknowns to the top of a worst-first sort would bury
 * the listings we DO know are weak — which is the entire job of that sort.
 */
export function qualityRankOf(summary: QualityScoreSummary | undefined): number {
  return summary ? summary.score : Number.POSITIVE_INFINITY;
}
