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

// ── US-9204: the review screen's hard checks ──────────────────────────────
//
// Approve blocks on exactly three things, because each one makes every channel
// refuse the listing anyway: no front or back photo, no price, no category.
// Everything softer (a thin description, a missing size) stays a nudge on the
// card and never stops the button.

export type ReviewBlockerCode = "missing_photo" | "no_price" | "no_category";

export interface ReviewBlocker {
  code: ReviewBlockerCode;
  /** Plain words for the card. */
  message: string;
  /** Where "Edit details" goes for this one. */
  fix: "photos" | "price" | "details";
}

export function reviewHardBlockers(input: {
  photoTypes: ReadonlyArray<string | null | undefined>;
  requiredPhotoTypes: ReadonlyArray<string>;
  price: number | null | undefined;
  category: string | null | undefined;
}): ReviewBlocker[] {
  const out: ReviewBlocker[] = [];
  const have = new Set(input.photoTypes.filter((t): t is string => typeof t === "string"));
  const missing = input.requiredPhotoTypes.filter((t) => !have.has(t));
  if (missing.length > 0) {
    out.push({
      code: "missing_photo",
      message: `Add a ${missing.join(" and a ")} photo.`,
      fix: "photos",
    });
  }
  const price = typeof input.price === "number" ? input.price : Number(input.price);
  if (!Number.isFinite(price) || price <= 0) {
    out.push({ code: "no_price", message: "Set a price.", fix: "price" });
  }
  if (!input.category || !String(input.category).trim()) {
    out.push({ code: "no_category", message: "Pick a category.", fix: "details" });
  }
  return out;
}
