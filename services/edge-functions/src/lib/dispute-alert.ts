// SUB-05: the admin alert for a newly filed grade dispute or authenticity
// appeal, sent by the filing routes themselves.
//
// It used to be a second, fire-and-forget request from the web client to
// POST /api/notifications/dispute-filed. That route looked the dispute up by
// the CALLER's id, but a dispute filed by a workspace member is stored under
// the workspace OWNER (grade.ts files as ownerId), so every member-filed
// dispute 404'd there and nobody noticed. Authenticity appeals never alerted
// anyone at all, although each one hides a public verdict until an admin acts.
//
// Tenancy (US-268): every read and the claim are keyed on `ownerId`, which the
// caller resolves as workspaceOwnerId ?? userId. The race-safe claim on
// admin_alerted_at (US-1652) means the route call and a legacy client call
// for the same dispute produce exactly one alert between them.

import { supabaseAdmin } from "./supabase.ts";
import { sendDisputeFiledAdminEmail } from "./email.ts";

export type DisputeAlertKind = "grade" | "authenticity";

export type DisputeAlertResult =
  | { status: "not_found" }
  | { status: "skipped"; reason: "not open" | "already alerted" }
  | { status: "sent"; emailed: boolean; adminsNotified: number };

export interface DisputeAlertDeps {
  sendEmail?: typeof sendDisputeFiledAdminEmail;
  adminEmail?: string;
}

/** Title and body for the in-app admin notification, by kind. */
export function disputeAlertCopy(
  kind: DisputeAlertKind,
  submitterName: string,
  submissionTitle: string,
): { title: string; message: string } {
  if (kind === "authenticity") {
    return {
      title: "New authenticity appeal",
      message:
        `${submitterName} appealed the authenticity result for "${submissionTitle}". ` +
        "The verdict is hidden from the certificate until it is decided.",
    };
  }
  return {
    title: "New grade dispute filed",
    message: `${submitterName} disputed the grade for "${submissionTitle}".`,
  };
}

/**
 * Alert every admin (in-app) and the dispute inbox (email) about a dispute or
 * appeal owned by `ownerId`. Never throws; a failure is logged and reported
 * in the result, because the filing it follows has already succeeded.
 */
export async function notifyAdminsDisputeFiled(
  disputeId: string,
  ownerId: string,
  kind?: DisputeAlertKind,
  deps: DisputeAlertDeps = {},
): Promise<DisputeAlertResult> {
  const { data: dispute } = await supabaseAdmin
    .from("disputes")
    .select("id, status, reason, user_id, grade_report_id, kind")
    .eq("id", disputeId)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (!dispute) return { status: "not_found" };
  if (dispute.status !== "open") return { status: "skipped", reason: "not open" };
  const resolvedKind: DisputeAlertKind =
    kind ?? (dispute.kind === "authenticity" ? "authenticity" : "grade");

  // US-1652: race-safe claim, owner-scoped like the lookup above.
  const { data: claimed } = await supabaseAdmin
    .from("disputes")
    .update({ admin_alerted_at: new Date().toISOString() })
    .eq("id", disputeId)
    .eq("user_id", ownerId)
    .is("admin_alerted_at", null)
    .select("id")
    .maybeSingle();
  if (!claimed) return { status: "skipped", reason: "already alerted" };

  // The grade report is reached through the owner-verified dispute row, and
  // the submission is scoped to the owner as well.
  const { data: report } = await supabaseAdmin
    .from("grade_reports")
    .select("submission_id")
    .eq("id", dispute.grade_report_id)
    .maybeSingle();
  let submissionTitle = "a graded submission";
  if (report?.submission_id) {
    const { data: submission } = await supabaseAdmin
      .from("submissions")
      .select("title")
      .eq("id", report.submission_id)
      .eq("user_id", ownerId)
      .maybeSingle();
    if (submission?.title) submissionTitle = submission.title;
  }
  const { data: submitter } = await supabaseAdmin
    .from("users")
    .select("full_name, email")
    .eq("id", dispute.user_id)
    .maybeSingle();
  const submitterName = submitter?.full_name || submitter?.email || "A user";

  const adminEmail = deps.adminEmail ??
    (Deno.env.get("DISPUTE_ALERT_EMAIL") || Deno.env.get("SMTP_ADMIN_EMAIL") || "");
  let emailed = false;
  if (adminEmail) {
    try {
      emailed = await (deps.sendEmail ?? sendDisputeFiledAdminEmail)(adminEmail, {
        submitterName,
        submissionTitle,
        reason: dispute.reason,
        submissionId: report?.submission_id ?? "",
        kind: resolvedKind,
      });
    } catch (err) {
      console.error("[dispute-alert] email failed:", err);
    }
  }

  const copy = disputeAlertCopy(resolvedKind, submitterName, submissionTitle);
  const { data: admins } = await supabaseAdmin
    .from("users")
    .select("id")
    .in("role", ["admin", "super_admin"]);
  for (const a of admins ?? []) {
    const { error } = await supabaseAdmin.from("notifications").insert({
      user_id: a.id,
      type: "system",
      title: copy.title,
      message: copy.message,
      link: "/admin/disputes",
    });
    if (error) console.error("[dispute-alert] in-app insert failed:", error.message);
  }

  return { status: "sent", emailed, adminsNotified: (admins ?? []).length };
}

/**
 * Remove evidence photos uploaded for a dispute whose insert then failed, so
 * they do not sit in the owner's folder with no row pointing at them.
 * Returns true when there was nothing to remove or the removal succeeded.
 */
export async function removeOrphanedEvidence(
  paths: readonly string[],
  remove: (paths: string[]) => Promise<{ error: unknown }> = (p) =>
    supabaseAdmin.storage.from("submission-images").remove(p),
): Promise<boolean> {
  if (paths.length === 0) return true;
  try {
    const { error } = await remove([...paths]);
    if (error) {
      console.error("[dispute] orphaned evidence cleanup failed:", error);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[dispute] orphaned evidence cleanup threw:", err);
    return false;
  }
}
