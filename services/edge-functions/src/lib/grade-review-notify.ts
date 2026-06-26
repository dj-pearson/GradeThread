// Admin/super-admin notifications for the mandatory grade-review queue.
//
// When the pipeline produces a PRELIMINARY grade, the people who can finalize it
// need to know: an in-app notice for every admin + super-admin (so the bell
// badge lights up and the queue is worked), and an email to the super-admins
// (the spec's "the super admin receives an email to review"). Best-effort —
// every leg swallows its own errors so a notification problem never blocks the
// grading pipeline.

import { supabaseAdmin } from "./supabase.ts";
import { notifyUser } from "./notify.ts";
import { sendGradeReviewRequestEmail } from "./email.ts";

export interface GradeReviewNeededInput {
  submissionTitle: string | null;
  overallScore: number;
  gradeTier: string;
  serviceTier: string;
  confidenceScore: number | null;
  flagged: boolean;
}

const REVIEW_QUEUE_LINK = "/admin/reviews";

/**
 * Alert reviewers that a new preliminary grade is awaiting finalization.
 * In-app to all admins + super-admins; email to super-admins only (the
 * designated finalizers — keeps per-grade email volume sane).
 */
export async function notifyAdminsGradeReviewNeeded(
  input: GradeReviewNeededInput,
): Promise<void> {
  try {
    const { data: admins, error } = await supabaseAdmin
      .from("users")
      .select("id, email, role")
      .in("role", ["admin", "super_admin"]);
    if (error) {
      console.error("[grade-review-notify] admin lookup failed:", error.message);
      return;
    }

    const rows = (admins ?? []) as Array<{
      id: string;
      email: string | null;
      role: string;
    }>;
    const title = input.submissionTitle?.trim() || "A submission";
    const scoreLine = `${input.overallScore.toFixed(1)} · ${input.gradeTier}`;

    await Promise.all(
      rows.map(async (admin) => {
        // In-app for every admin/super-admin. type 'system' is unsuppressible
        // and links straight to the review queue.
        await notifyUser(admin.id, {
          type: "system",
          title: "Grade awaiting review",
          message: `${title} has a preliminary grade (${scoreLine}) ready to finalize.`,
          link: REVIEW_QUEUE_LINK,
        });
        // Email only the super-admins.
        if (admin.role === "super_admin" && admin.email) {
          await sendGradeReviewRequestEmail(admin.email, {
            submissionTitle: title,
            overallScore: input.overallScore,
            gradeTier: input.gradeTier,
            serviceTier: input.serviceTier,
            confidenceScore: input.confidenceScore,
            flagged: input.flagged,
          });
        }
      }),
    );
  } catch (err) {
    console.error(
      "[grade-review-notify] unexpected error:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
