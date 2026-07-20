// US-2145: tell a seller when their item draws a red_flags authenticity verdict.
//
// DECIDED 2026-07-19 (vault/60-decisions/adr-authenticity-open-questions.md §1a):
// notify on red_flags ONLY. The alternative options were "every assessment",
// which draws attention to a signal most sellers would never notice, and "no
// notification" — which makes the appeal route decorative, because a seller
// cannot contest what they were never told about.
//
// This is the notice that makes the appeal path real. The verdict is published
// on a public certificate, sealed into certificate integrity, and written to an
// append-only passport ledger; a seller finding that out by accident is the
// failure US-2145 exists to fix.
//
// ⚠ COPY NEEDS COUNSEL REVIEW (US-2133). It is deliberately factual and
// non-accusatory — it reports what the assessment said, states that it is an
// estimate rather than a determination, and points at the appeal. It does not
// assert the item IS counterfeit, because the pass has no measured error rate.
// Reviewed alongside the certificate copy, not separately.
//
// Deps are injectable so the emission is unit-testable without a DB, mirroring
// grading-lifecycle-notify.ts.

import { notifyUser, type NotifyInput } from "./notify.ts";

export interface AuthenticityNotifyDeps {
  notify: (userId: string, input: NotifyInput) => Promise<void>;
}

const defaultDeps: AuthenticityNotifyDeps = { notify: notifyUser };

/**
 * Business days the appeal review targets. DECIDED 2026-07-19: 5.
 *
 * Stated in the notice because an appeal with no stated turnaround is an appeal
 * a seller cannot plan around — and while it is open the item is effectively
 * unsellable at its stated grade, so the wait is itself a cost.
 */
export const AUTHENTICITY_APPEAL_SLA_BUSINESS_DAYS = 5;

/** Compose the notice. Pure + exported so the copy is testable without a DB. */
export function buildAuthenticityFlagNotice(
  title: string | null,
  link: string | null,
): NotifyInput {
  const label = title?.trim() || "Your item";
  return {
    // An appeal is a dispute, so it rides the existing dispute_update channel
    // rather than inventing a type the user's preferences do not know about.
    type: "dispute_update",
    title: "Your authenticity check needs a look",
    // Deliberate wording: "could not confirm" reports the limit of what the pass
    // established. Saying the item IS counterfeit would assert something an
    // ungated, photo-only estimate cannot support.
    message:
      `${label}: our authenticity check flagged details it could not confirm. ` +
      `This is an automated estimate from photos, not a determination — if you ` +
      `believe it's wrong you can contest it, and we aim to respond within ` +
      `${AUTHENTICITY_APPEAL_SLA_BUSINESS_DAYS} business days.`,
    link: link ?? "/dashboard/submissions",
  };
}

/**
 * Notify a seller of a red-flag verdict. Best-effort — notifyUser swallows its
 * own errors, so a notification problem never breaks the grading pipeline.
 *
 * Fires ONLY for red_flags. An inconclusive verdict is not a finding, and
 * telling a seller about one would be noise that also invites appeals against
 * nothing.
 */
export async function notifyAuthenticityFlagged(
  userId: string,
  verdict: string | null,
  title: string | null,
  link: string | null,
  deps: AuthenticityNotifyDeps = defaultDeps,
): Promise<boolean> {
  if (!userId || verdict !== "red_flags") return false;
  await deps.notify(userId, buildAuthenticityFlagNotice(title, link));
  return true;
}
