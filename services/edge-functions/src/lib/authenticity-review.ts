// US-2140: authenticity human-review outcomes, and the loop back into the
// golden set.
//
// authenticityNeedsReview() already routes a red_flags verdict (or a branded
// assessment under the confidence threshold) to a human. Until 00487 there was
// nowhere for that human to record what they concluded — human_reviews is
// condition-shaped (original_score/adjusted_score), and an authenticity outcome
// is a verdict plus the tells it rested on.
//
// The promotion path is the reason this matters beyond bookkeeping: a resolved
// authenticity review is expert-labelled ground truth about a real submission,
// which is the cheapest ongoing source of the cases the eval gate needs. Every
// review that gets resolved and promoted moves the gate closer to being able to
// pass at all (US-2131).

import type { AuthenticityVerdict } from "./ai-authenticity.ts";
import type { ExpectedLabel } from "./authenticity-eval.ts";
import { AUTH_TELL_CATEGORIES, isAuthTellCategory } from "./brand-authenticity.ts";

export type ReviewerVerdict = ExpectedLabel;

export const REVIEWER_VERDICTS: ReadonlySet<string> = new Set([
  "authentic",
  "counterfeit",
  "inconclusive",
]);

export interface AuthenticityReviewOutcome {
  grade_report_id: string;
  human_review_id?: string | null;
  reviewer_id: string;
  model_verdict: AuthenticityVerdict | null;
  model_confidence: number | null;
  model_prompt_version: string | null;
  reviewer_verdict: ReviewerVerdict;
  tells_relied_on: string[];
  reasoning: string | null;
}

/**
 * Did the reviewer contradict the pass? Pure + exported.
 *
 * The two vocabularies differ (the model says likely_authentic / red_flags /
 * inconclusive; a reviewer says authentic / counterfeit / inconclusive), so this
 * maps before comparing rather than string-matching two different alphabets.
 *
 * A null model verdict is NOT an override — the pass never ran, so there was
 * nothing to disagree with.
 */
export function overrodeModel(
  modelVerdict: AuthenticityVerdict | null,
  reviewerVerdict: ReviewerVerdict,
): boolean {
  if (modelVerdict === null) return false;
  const asLabel: ReviewerVerdict = modelVerdict === "likely_authentic"
    ? "authentic"
    : modelVerdict === "red_flags"
    ? "counterfeit"
    : "inconclusive";
  return asLabel !== reviewerVerdict;
}

/**
 * The overrides worth acting on first. Pure + exported.
 *
 * A reviewer calling a fake what the model called authentic is the DANGEROUS
 * direction — it is the same error the eval gate fails outright on, and the only
 * one where a buyer was actively misled rather than merely under-served. The
 * reverse (model cried fake, reviewer says genuine) is a false alarm: bad, but
 * it cost a seller a review, not a buyer a counterfeit.
 */
export function isDangerousOverride(
  modelVerdict: AuthenticityVerdict | null,
  reviewerVerdict: ReviewerVerdict,
): boolean {
  return modelVerdict === "likely_authentic" && reviewerVerdict === "counterfeit";
}

export interface PromotionCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Is this resolved review fit to become a golden-set case? Pure + exported.
 *
 * Deliberately strict, because a golden set is only as good as its weakest
 * label and these cases will certify every future prompt version:
 *
 *  - 'inconclusive' outcomes are rejected. They are a legitimate REVIEW result
 *    but a poor eval case: they teach the gate nothing about the distinction it
 *    exists to measure, and they inflate the agreement denominator.
 *  - Reasoning is required. An unexplained label cannot be audited later, and
 *    "the expert said so" is exactly the provenance the curation surface asks
 *    for on hand-entered cases (source_url).
 *  - Images are required, because the eval replays them.
 */
export function canPromoteToGoldenSet(
  outcome: Pick<AuthenticityReviewOutcome, "reviewer_verdict" | "reasoning">,
  imageCount: number,
  alreadyPromoted: boolean,
): PromotionCheck {
  if (alreadyPromoted) {
    return { ok: false, reason: "This review has already been promoted to the golden set." };
  }
  if (outcome.reviewer_verdict === "inconclusive") {
    return {
      ok: false,
      reason:
        "An inconclusive outcome is a valid review result but a poor eval case — it " +
        "cannot demonstrate the authentic-vs-counterfeit distinction the gate measures.",
    };
  }
  if (!outcome.reasoning || !outcome.reasoning.trim()) {
    return { ok: false, reason: "Reasoning is required — an unexplained label cannot be audited." };
  }
  if (imageCount === 0) {
    return { ok: false, reason: "The submission has no images to replay." };
  }
  return { ok: true };
}

/** Validate a review outcome before it is written. Returns an error, or null. */
export function validateReviewOutcome(body: Record<string, unknown>): string | null {
  if (typeof body.grade_report_id !== "string" || !body.grade_report_id.trim()) {
    return "grade_report_id is required.";
  }
  if (
    typeof body.reviewer_verdict !== "string" ||
    !REVIEWER_VERDICTS.has(body.reviewer_verdict)
  ) {
    return `reviewer_verdict must be one of: ${[...REVIEWER_VERDICTS].join(", ")}.`;
  }
  if (body.tells_relied_on !== undefined) {
    if (!Array.isArray(body.tells_relied_on)) {
      return "tells_relied_on must be an array of tell categories.";
    }
    // US-2147 reads these to rank brand-knowledge candidates, and its aggregator
    // DROPS anything that is not a known category. Accepting free text here
    // would look like it was recorded while contributing nothing — the reviewer
    // would have done the work and the signal would silently vanish. Reject at
    // write time so the caller finds out immediately.
    const unknown = body.tells_relied_on.filter((t) => !isAuthTellCategory(t));
    if (unknown.length > 0) {
      return `Unknown tell categories: ${unknown.map(String).join(", ")}. ` +
        `Valid: ${AUTH_TELL_CATEGORIES.join(", ")}.`;
    }
  }
  return null;
}
