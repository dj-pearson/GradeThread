// US-2309: the post-composite confidence caps, as a pure function.
//
// WHY THIS EXISTS. `compositeGrade` applies the caps it can see from inside
// itself (authenticity flag, defaulted factors, injection, missing fabric
// close-up) through `applyGradingConfidencePolicy`. Everything AFTER that —
// a partial image set, a peer-norm outlier, the visual-verification
// discrepancies the composite itself reported — was applied only in
// `grading-pipeline.ts`, inline, interleaved with the DB writes.
//
// So `quick-grade.ts` (Snap-to-Value and the browser extension) saw none of
// them. It returned `composite.needs_human_review` and `confidence_score`
// straight out, and a grep of that file for every one of these controls by name
// returned zero hits. A quick grade could therefore report 0.8 where the full
// path would have capped it at 0.6 — on the surface where the number is most
// externally visible, and against a PUBLIC promise that anything under 0.75
// gets a human first.
//
// THE RULE THIS OBEYS (grading-engine skill, US-2299): a cap must do two things
// or it is not a cap — lower the confidence, AND lower the reported ceiling. Do
// only the first and the review gate still fires, so the grade looks handled,
// while the next provenance boost lifts the STORED number back over the cap.
// That number feeds the public confidence label and the calibration miner.
//
// NOT A REFACTOR OF THE PIPELINE, deliberately. `grading-pipeline.ts` keeps its
// own inline sequence, which also writes detailed_notes and interleaves the
// forensic and reconcile passes this cannot see. What the two share is the
// CONSTANTS — imported here, never re-typed — because a number drifting apart
// is the failure that would be silent. `post-composite-caps_test.ts` pins that.

import { PARTIAL_IMAGE_CONFIDENCE_CAP } from "./ai-grading.ts";
import { PEER_NORM_CONFIDENCE_CAP, composeConfidenceCap } from "./peer-norm.ts";

/** The minimum number of visual-verification discrepancies that forces review. */
export const VERIFICATION_DISCREPANCY_REVIEW_MIN = 2;

/** Per-discrepancy confidence shave, and the most it can take in total. */
export const VERIFICATION_DISCREPANCY_SHAVE = 0.1;
export const VERIFICATION_DISCREPANCY_MAX_SHAVE = 0.2;

export interface PostCompositeCapInput {
  /** Confidence as the composite left it. */
  confidence: number;
  /** The ceiling the composite reported (`confidence_ceiling`), or 1. */
  ceiling: number;
  /** Review threshold in force (settings-driven; 0.75 by default). */
  reviewThreshold: number;
  /** True when fewer images were analyzed than the caller supplied. */
  partialImageSet: boolean;
  /** Cross-photo contradictions the composite's own verification pass found. */
  verificationDiscrepancies: number;
  /** A peer-norm cap, when the check ran and flagged. Null when it did not. */
  peerNormCap: number | null;
}

export interface PostCompositeCapResult {
  confidence: number;
  ceiling: number;
  needsHumanReview: boolean;
  /** Which caps fired, for logging and for the reason shown to an operator. */
  applied: string[];
}

/**
 * Apply the caps that can only be known after the composite has run.
 *
 * Order does not matter to the result — every step is a MIN against the running
 * value — and that is deliberate: a cap sequence whose outcome depends on its
 * order is one refactor away from being wrong.
 */
export function applyPostCompositeCaps(
  input: PostCompositeCapInput,
): PostCompositeCapResult {
  let confidence = input.confidence;
  let ceiling = input.ceiling;
  const applied: string[] = [];
  let needsHumanReview = false;

  // A dropped image is one the grader never saw. The full pipeline treats that
  // as a reason to distrust the whole read, not to average over what remains.
  if (input.partialImageSet) {
    confidence = Math.min(confidence, PARTIAL_IMAGE_CONFIDENCE_CAP);
    ceiling = Math.min(ceiling, PARTIAL_IMAGE_CONFIDENCE_CAP);
    needsHumanReview = true;
    applied.push("partial_image_set");
  }

  // The composite re-checked the photos against its own findings and disagreed
  // with itself. One contradiction shaves; two mean a human looks.
  if (input.verificationDiscrepancies > 0) {
    const shave = Math.min(
      VERIFICATION_DISCREPANCY_MAX_SHAVE,
      VERIFICATION_DISCREPANCY_SHAVE * input.verificationDiscrepancies,
    );
    confidence = Math.max(0, confidence - shave);
    // The shave is a floor a later boost must not cross, which is why it moves
    // the ceiling too — the same reasoning as US-1622/C9 in the pipeline.
    ceiling = Math.min(ceiling, confidence);
    applied.push(`verification_discrepancies:${input.verificationDiscrepancies}`);
    if (input.verificationDiscrepancies >= VERIFICATION_DISCREPANCY_REVIEW_MIN) {
      needsHumanReview = true;
    }
  }

  // Peer-norm: this grade sits outside the range similar items land in.
  if (input.peerNormCap != null) {
    confidence = composeConfidenceCap(confidence, input.peerNormCap);
    ceiling = Math.min(ceiling, input.peerNormCap);
    needsHumanReview = true;
    applied.push("peer_norm");
  }

  // The flat threshold still applies to whatever survived the caps above.
  if (confidence < input.reviewThreshold) needsHumanReview = true;

  return { confidence, ceiling, needsHumanReview, applied };
}

/** Re-exported so callers cap against the same numbers rather than their own. */
export { PARTIAL_IMAGE_CONFIDENCE_CAP, PEER_NORM_CONFIDENCE_CAP };
