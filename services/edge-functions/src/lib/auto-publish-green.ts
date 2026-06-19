// US-955: pure helpers for AutoLister "auto-publish green drafts on completion".
//
// Kept pure (no DB, no Hono) so the triage rule + the completion-notification
// copy are unit-tested without a live stack. The orchestration that loads rows,
// runs the publish pre-flight, enqueues the durable publish worker, and notifies
// lives in routes/flipdesk-autolister.ts.

// Photo-QA floor for a "green" draft. Mirrors the frontend triage (US-550) in
// src/pages/flipdesk/autolister-queue.tsx (tierOf): a QA score below this is
// "amber" (needs a human look) even when the AI was confident.
export const AUTO_PUBLISH_QA_MIN = 80;

export interface GreenTriageInput {
  /** listings.needs_review (US-541) — AI flagged a low-confidence field. */
  needsReview: boolean;
  /** inventory_items.photo_qa_score (US-537), or null when not yet scored. */
  photoQaScore: number | null;
}

/**
 * A succeeded generation draft is "green" when the AI was confident (not
 * needs_review) AND the photo QA is clean (unscored, or ≥ the floor). Anything
 * else is "amber" and is never auto-published. Mirrors the frontend tierOf so
 * the one-click "Publish green" set and the auto-publish set agree.
 */
export function isGreenDraft(input: GreenTriageInput): boolean {
  const lowQa = input.photoQaScore != null && input.photoQaScore < AUTO_PUBLISH_QA_MIN;
  return !input.needsReview && !lowQa;
}

// Why a generated draft was NOT auto-published. `published` is the green, clean,
// unscheduled, within-cap set that was handed to the durable publish worker.
export interface AutoPublishSkips {
  /** amber: AI low-confidence or low photo-QA. */
  needs_review: number;
  /** green but failed the publish pre-flight (eBay blockers / missing policies). */
  blocked: number;
  /** green but carries a scheduled_publish_at — the scheduled worker owns it. */
  scheduled: number;
  /** green + clean but over the plan's active-listing cap. */
  plan_limit: number;
}

export function emptySkips(): AutoPublishSkips {
  return { needs_review: 0, blocked: 0, scheduled: 0, plan_limit: 0 };
}

export function totalSkipped(s: AutoPublishSkips): number {
  return s.needs_review + s.blocked + s.scheduled + s.plan_limit;
}

export interface AutoPublishOutcome {
  /** Items the publish worker actually listed (publish-job successes). */
  published: number;
  /** Items the publish worker attempted but that failed at publish time. */
  failed: number;
  skipped: AutoPublishSkips;
}

/**
 * Build the one completion notification (title + message) reporting published
 * vs skipped counts with reasons. Pure so the copy is unit-tested.
 */
export function buildAutoPublishNotification(
  outcome: AutoPublishOutcome,
): { title: string; message: string } {
  const { published, failed, skipped } = outcome;
  const skippedTotal = totalSkipped(skipped);

  const title = published > 0
    ? `Auto-published ${published} listing${published === 1 ? "" : "s"}`
    : "Auto-publish finished — nothing went live";

  const reasons: string[] = [];
  if (failed > 0) reasons.push(`${failed} failed to publish`);
  if (skipped.needs_review > 0) reasons.push(`${skipped.needs_review} need review`);
  if (skipped.blocked > 0) reasons.push(`${skipped.blocked} blocked`);
  if (skipped.scheduled > 0) reasons.push(`${skipped.scheduled} scheduled`);
  if (skipped.plan_limit > 0) reasons.push(`${skipped.plan_limit} over plan limit`);

  const totalSkippedAndFailed = skippedTotal + failed;
  const head = published > 0
    ? `${published} high-confidence draft${published === 1 ? "" : "s"} went live`
    : "No drafts were eligible to auto-publish";
  const tail = totalSkippedAndFailed > 0
    ? ` — skipped ${totalSkippedAndFailed} (${reasons.join(", ")}).`
    : ".";

  return { title, message: `${head}${tail}` };
}
