// Grading-lifecycle notifications (US-1056).
//
// The pipeline historically only told the seller about the HAPPY path
// (grade_complete / grading_ready). These cover the rest of the lifecycle so a
// grade that fails, abstains, or routes to human review is never silent:
//   • notifyGradingFailed     — the run threw / a required angle couldn't be
//                               analyzed. The charge was already reversed.
//   • notifyGradingIncomplete — the pre-grade quality gate abstained
//                               (status='needs_photos'): the photos can't be
//                               graded, so no grade was produced and no paid
//                               grade was consumed.
//   • notifyReviewNeeded      — a grade was produced but routed to human review
//                               (low confidence / suspected tamper). Fires the
//                               in-app notice AND the iOS push (pushReviewNeeded).
//
// Deps are injectable so the emission is unit-testable without a DB or APNs
// (mirrors notifyPlanDowngrade in plan-change-notify.ts). Every leg is
// best-effort — notifyUser swallows its own errors, and the push is no-op when
// APNs is unconfigured — so a notification problem never breaks the pipeline.

import { notifyUser, type NotifyInput } from "./notify.ts";
import { pushReviewNeeded } from "./transactional-push.ts";

export interface GradingLifecycleNotifyDeps {
  notify: (userId: string, input: NotifyInput) => Promise<void>;
  pushReview: (userId: string, title?: string | null) => Promise<void>;
}

const defaultDeps: GradingLifecycleNotifyDeps = {
  notify: notifyUser,
  pushReview: pushReviewNeeded,
};

function label(title: string | null | undefined): string {
  return title?.trim() || "Your submission";
}

/** A grade run failed outright (pipeline threw / required-angle analysis failed). */
export async function notifyGradingFailed(
  userId: string,
  title: string | null,
  deps: GradingLifecycleNotifyDeps = defaultDeps,
): Promise<void> {
  await deps.notify(userId, {
    type: "grading_failed",
    title: "Grading couldn't finish",
    message:
      `${label(title)} couldn't be graded. Any charge was reversed — ` +
      `please try submitting again.`,
    link: "/dashboard/submissions",
  });
}

/**
 * The pre-grade quality gate abstained (status='needs_photos'). `summary` is the
 * gate's human-readable reason (e.g. "the label photo is too blurry to read");
 * `link` deep-links to where the seller can re-upload.
 */
export async function notifyGradingIncomplete(
  userId: string,
  title: string | null,
  summary: string | null,
  link: string | null,
  deps: GradingLifecycleNotifyDeps = defaultDeps,
): Promise<void> {
  const reason = summary?.trim();
  await deps.notify(userId, {
    type: "grading_incomplete",
    title: "We need clearer photos",
    message: reason
      ? `${label(title)}: ${reason}`
      : `${label(title)} needs clearer photos before we can grade it.`,
    link: link ?? "/dashboard/submissions",
  });
}

/**
 * The AI produced a PRELIMINARY grade. The seller can see the unofficial score,
 * but it stays pending until a human reviewer finalizes it. Sends the in-app
 * notice AND the iOS "we're reviewing it" push.
 */
export async function notifyGradePreliminary(
  userId: string,
  title: string | null,
  link: string | null,
  deps: GradingLifecycleNotifyDeps = defaultDeps,
): Promise<void> {
  await Promise.all([
    deps.notify(userId, {
      type: "grading_preliminary",
      title: "Preliminary grade ready",
      message:
        `${label(title)} has a preliminary AI grade — it's pending expert ` +
        `review before it becomes official and the certificate goes live.`,
      link: link ?? "/dashboard/submissions",
    }),
    deps.pushReview(userId, title),
  ]);
}

/**
 * A reviewer finalized the grade (approved or adjusted). It's now official, the
 * certificate is live, and the item is published. `summary` carries the final
 * score/tier line.
 */
export async function notifyGradeFinalized(
  userId: string,
  title: string | null,
  summary: string,
  link: string | null,
  deps: GradingLifecycleNotifyDeps = defaultDeps,
): Promise<void> {
  await deps.notify(userId, {
    type: "grading_finalized",
    title: "Grade finalized",
    message: `${label(title)} is now official. ${summary}`,
    link: link ?? "/dashboard/submissions",
  });
}

/**
 * A grade was produced but flagged for a human check. Sends BOTH the in-app
 * notice and the iOS push so the seller knows the grade is being double-checked.
 */
export async function notifyReviewNeeded(
  userId: string,
  title: string | null,
  link: string | null,
  deps: GradingLifecycleNotifyDeps = defaultDeps,
): Promise<void> {
  await Promise.all([
    deps.notify(userId, {
      type: "grade_complete",
      title: "We're double-checking your grade",
      message: `${label(title)} is being reviewed by a human before it's final.`,
      link: link ?? "/dashboard/submissions",
    }),
    deps.pushReview(userId, title),
  ]);
}
