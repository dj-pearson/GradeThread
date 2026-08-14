// US-2505: who is allowed to DECIDE a flagged grade report.
//
// The TTL claim (US-1293) was advisory. `POST /review/:id/claim` refused when
// another operator held the item, but approve, adjust and send-back never
// looked — and /admin/reviews never called /claim at all. Two operators, one on
// each admin page, could therefore both finalize the same report:
// `finalizeGradeReview` reported `alreadyFinal` so the GRADE survived, but each
// decision inserted its own `human_reviews` row, crediting one outcome to two
// reviewers in the table the adjust route feeds as the self-improvement dataset.
//
// Pure so the rule is unit-testable without a DB or a Hono context; the route
// helper in admin-grading.ts does the reads and maps the verdict to a response.

/** How long a claim holds the item before another operator may take it. */
export const REVIEW_CLAIM_TTL_SEC = 15 * 60;

export type ReviewClaimVerdict =
  /** This operator may decide the report. */
  | "ok"
  /** Already decided — a second decision would double-write `human_reviews`. */
  | "already_reviewed"
  /** Another operator holds a claim that has not expired. */
  | "held_by_other";

export interface ReviewClaimState {
  humanReviewed: boolean | null;
  claimedBy: string | null;
  claimedAt: string | null;
  /** The operator attempting the decision. */
  adminId: string;
  /** Injected so the TTL boundary is testable. */
  nowMs: number;
}

export function reviewClaimVerdict(s: ReviewClaimState): ReviewClaimVerdict {
  // A decided report takes no second decision. This is what makes "one
  // human_reviews row per finalized report" true even for two operators who
  // never claimed it — the claim is optional, this check is not.
  if (s.humanReviewed) return "already_reviewed";

  // Unclaimed, or claimed by the caller: claiming stays optional, it just
  // becomes binding once taken.
  if (!s.claimedBy || s.claimedBy === s.adminId) return "ok";

  // A stale claim is not a lock, so a crashed or idle session can never wedge
  // the queue. Same rule /claim itself applies.
  const claimedAtMs = s.claimedAt ? Date.parse(s.claimedAt) : NaN;
  if (!Number.isFinite(claimedAtMs)) return "ok";
  const ageMs = s.nowMs - claimedAtMs;
  return ageMs < REVIEW_CLAIM_TTL_SEC * 1000 ? "held_by_other" : "ok";
}
