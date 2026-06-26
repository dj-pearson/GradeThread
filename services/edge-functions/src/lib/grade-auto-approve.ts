// Auto-approve threshold for the mandatory grade-review workflow.
//
// Mandatory review (every grade waits for a human) is the safe default, but it
// doesn't scale to high volume. This lets HIGH-CONFIDENCE, CLEAN grades skip the
// queue and finalize immediately — while anything the system is unsure about, or
// has flagged, still requires a super-admin. The reviewer's oversight is
// preserved exactly where it adds value.
//
// A grade auto-approves iff ALL hold:
//   • confidence_score >= the configured threshold, AND
//   • it was NOT routed to human review (needs_human_review covers low
//     confidence, partial image sets, and suspected tamper/forensic hits), AND
//   • it was NOT flagged for moderation (not-clothing / manipulation /
//     cross-account photo reuse).
//
// GRADE_AUTO_APPROVE_CONFIDENCE controls the threshold:
//   • a number in (0, 1]  → auto-approve at that confidence (default 0.9)
//   • "off" / "false" / "" / <= 0 / > 1 → DISABLED (every grade goes to a human)
// Tune it down to clear more of the queue automatically, or set it "off" to fall
// back to fully-manual review.

const DEFAULT_THRESHOLD = 0.9;

/**
 * Resolve the auto-approve confidence threshold, or null when auto-approve is
 * disabled (every grade then requires human review). `raw` is injectable for
 * tests; defaults to the GRADE_AUTO_APPROVE_CONFIDENCE env var.
 */
export function autoApproveThreshold(
  raw: string | undefined = Deno.env.get("GRADE_AUTO_APPROVE_CONFIDENCE"),
): number | null {
  if (raw === undefined) return DEFAULT_THRESHOLD;
  const t = raw.trim().toLowerCase();
  if (t === "" || t === "off" || t === "false" || t === "disabled") return null;
  const n = Number(t);
  // Out of (0, 1] → treat as disabled rather than silently auto-approving
  // everything (n<=0) or nothing reachable (n>1).
  if (!Number.isFinite(n) || n <= 0 || n > 1) return null;
  return n;
}

export interface AutoApproveInput {
  confidenceScore: number;
  /** The pipeline's human-review flag (low confidence / partial / tamper). */
  needsHumanReview: boolean;
  /** Moderation flag (not-clothing / manipulation / cross-account reuse). */
  flagged: boolean;
}

/**
 * True when a grade is safe to finalize WITHOUT human review. `threshold` is the
 * resolved value from autoApproveThreshold() (null = auto-approve disabled).
 */
export function shouldAutoApprove(
  input: AutoApproveInput,
  threshold: number | null,
): boolean {
  if (threshold === null) return false;
  if (input.needsHumanReview) return false;
  if (input.flagged) return false;
  return input.confidenceScore >= threshold;
}
